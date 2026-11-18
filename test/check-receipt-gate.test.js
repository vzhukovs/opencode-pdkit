/**********************************************************************
 * Copyright (C) 2026 Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 ***********************************************************************/

// scripts/check-receipt-gate.js decides what CI reports about whether the
// receipt gate still holds an implementer. Running a server and a model is the
// CI job's part; what the script makes of the sessions' records, the journal
// and the doctor's report is pinned here. The hold and the journal entries it
// expects are the ones lib/hooks/task-completed.js writes, produced here by the
// handler itself, so a change of wording there cannot leave the check reading
// a hold that no longer comes.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { start } from '../lib/active.js';
import { issueDir } from '../lib/config.js';
import { writeReceipt } from '../lib/evidence.js';
import { IMPLEMENTER, handle } from '../lib/hooks/task-completed.js';
import { read as readJournal } from '../lib/journal.js';
import { setOwns, transition } from '../lib/state.js';
import {
  CAPTURE,
  IMPLEMENTER_TASK,
  PARENT_PROMPT,
  TASK,
  childrenOf,
  doctorVerdict,
  holdVerdict,
  holdsIn,
  items,
  journalVerdict,
  settled,
  subagentVerdict,
  toolCalls,
  usage,
} from '../scripts/check-receipt-gate.js';

const execFileAsync = promisify(execFile);

const PARENT = 'ses_parent';
const CHILD = 'ses_child';
const HOME = '/tmp/check/pdkit-home';

const user = (text) => ({ type: 'user', text });
const said = (text) => ({ type: 'assistant', agent: IMPLEMENTER, content: [{ type: 'text', text }], finish: 'stop' });
const called = (name, input) => ({ type: 'assistant', content: [{ type: 'tool', name, state: { status: 'completed', input } }], finish: 'tool-calls' });
const idle = (outcome = 'succeeded') => ({ type: 'idle', outcome });
const hold = (text) => ({ type: 'synthetic', text, description: text.split('\n')[0], metadata: { source: 'opencode-pdkit', hook: 'subagent-stop' } });
const report = (state = 'completed') => ({ type: 'synthetic', text: `<subagent sessionID="${CHILD}" state="${state}">`, metadata: { source: 'subagent', childID: CHILD, state } });

describe('what the session is asked', () => {
  test('to start the implementer, by its ID, with a task that names no receipt', () => {
    assert.ok(PARENT_PROMPT.includes(`start the ${IMPLEMENTER} agent`));
    assert.ok(PARENT_PROMPT.includes(IMPLEMENTER_TASK), 'the task is handed over whole');
    assert.ok(!IMPLEMENTER_TASK.includes('pdkit'), 'the implementer learns the command from the hold, not from its task');
  });
});

describe('listings', () => {
  test('an array or { items }, and nothing else', () => {
    assert.deepEqual(items([1]), [1]);
    assert.deepEqual(items({ items: [2] }), [2]);
    assert.deepEqual(items(undefined), []);
    assert.deepEqual(items({ data: [3] }), []);
  });

  test("the parent's children, by parentID", () => {
    const listing = [{ id: PARENT }, { id: CHILD, parentID: PARENT }, { id: 'ses_other', parentID: 'ses_elsewhere' }];
    assert.deepEqual(childrenOf(listing, PARENT).map((session) => session.id), [CHILD]);
    assert.deepEqual(childrenOf({ items: listing }, PARENT).map((session) => session.id), [CHILD]);
  });

  test('tool calls, by name and input, from the assistant messages only', () => {
    const messages = [user('go'), called('subagent', { agent: IMPLEMENTER }), said('Launched.'), idle()];
    assert.deepEqual(toolCalls(messages), [{ name: 'subagent', input: { agent: IMPLEMENTER }, status: 'completed' }]);
  });

  test("a hold is the plugin's synthetic message, not the subagent's report", () => {
    assert.equal(holdsIn([hold('pdkit: x'), report(), { type: 'synthetic', text: 'other', metadata: { source: 'someone' } }]).length, 1);
  });
});

// The subagent runs in the background: the parent goes idle once with it
// still running, and again after its report. Reading the records at the first
// idle would find a child in the middle of its run.
describe('when the parent is done', () => {
  test('idle after the report', () => {
    assert.equal(settled([user('go'), called('subagent', {}), said('Launched.'), idle(), report(), said('PARENT GOT: x'), idle()]), true);
  });

  test('not idle while the subagent it started has not reported', () => {
    assert.equal(settled([user('go'), called('subagent', {}), said('Launched.'), idle()]), false);
  });

  test('idle without having started one: nothing more will come', () => {
    assert.equal(settled([user('go'), said('No.'), idle()]), true);
  });

  test('not while it still runs', () => {
    assert.equal(settled([user('go'), called('subagent', {}), said('Launched.'), idle(), report()]), false);
    assert.equal(settled([]), false);
  });
});

// A model's slip is not the gate's failure, and the report says which it is.
describe('the subagent', () => {
  test('one, the implementer', () => {
    assert.equal(subagentVerdict([{ id: CHILD, agent: IMPLEMENTER }], []).ok, true);
  });

  test('none: the model did not do what it was asked, with what it did', () => {
    const verdict = subagentVerdict([], [user('go'), said('I would rather not.'), idle()]);
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /no subagent/);
    assert.match(verdict.detail, /not the gate's doing/);
    assert.match(verdict.detail, /I would rather not/);
  });

  test('another agent, or more than one', () => {
    assert.equal(subagentVerdict([{ id: CHILD, agent: 'general' }], []).ok, false);
    assert.equal(subagentVerdict([{ id: CHILD, agent: IMPLEMENTER }, { id: 'ses_two', agent: IMPLEMENTER }], []).ok, false);
  });
});

// The hold and the stops are read against what the handler itself says and
// writes, for the task and the sessions the check sets up.
describe('the hold and the journal, as the handler makes them', () => {
  let home;
  let worktree;
  let saved;
  let refusal;
  const stop = () => handle({ agent_id: CHILD, agent_type: IMPLEMENTER, session_id: PARENT, cwd: worktree }, { event: 'subagent-stop', pluginRoot: '' });
  const journal = async () => ({
    stops: await readJournal({ event: 'agent-done' }, { home }),
    receipts: await readJournal({ event: 'task-receipt' }, { home }),
  });

  before(async () => {
    saved = process.env.PDKIT_HOME;
    home = await mkdtemp(join(tmpdir(), 'pdkit-gate-check-'));
    worktree = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-gate-check-repo-')));
    process.env.PDKIT_HOME = home;
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: worktree });
    await transition(TASK.issue, 'triaged', { home });
    await setOwns(TASK.issue, TASK.id, [TASK.owns], { home });
    await mkdir(join(issueDir(home, TASK.issue), 'tasks'), { recursive: true });
    await writeFile(join(issueDir(home, TASK.issue), 'tasks', `${TASK.id}.md`), `# ${TASK.id}: a task\n\n## Done when\n\`\`\`bash\n${TASK.done}\n\`\`\`\n`);
    await start({ issue: TASK.issue, taskId: TASK.id, worktree, session: PARENT, home });

    const first = await stop();
    assert.equal(first.block, true, 'no receipt: the implementer is held');
    refusal = first.reason;
    await writeReceipt({
      issue: TASK.issue,
      taskId: TASK.id,
      run: { command: TASK.done, exitCode: 0, stdout: 'T1-DONE\n', stderr: '', durationMs: 5, at: new Date().toISOString(), complete: true },
      home,
    });
    const second = await stop();
    assert.equal(second.block, false, 'a receipt: let go');
  });

  after(async () => {
    if (saved === undefined) delete process.env.PDKIT_HOME;
    else process.env.PDKIT_HOME = saved;
    for (const dir of [home, worktree]) await rm(dir, { recursive: true, force: true });
  });

  test('the hold names the command the check expects the model to run', () => {
    assert.ok(refusal.includes(CAPTURE), refusal);
  });

  test('held once, then idle and succeeded: pass', () => {
    const verdict = holdVerdict([user('task'), said('IMPLEMENTER: done'), hold(refusal), called('shell', { command: CAPTURE }), said('IMPLEMENTER: captured'), idle()]);
    assert.equal(verdict.ok, true, verdict.detail);
  });

  // The failure this check exists for: a renamed experimental.idle registers
  // without a complaint, and the implementer simply stops.
  test('not held: the hook did not run, and the report says what that means', () => {
    const verdict = holdVerdict([user('task'), said('IMPLEMENTER: done'), idle()]);
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /not held/);
    assert.match(verdict.detail, /experimental\.idle/);
  });

  test('held more than once: the model did not capture, and its calls are shown', () => {
    const verdict = holdVerdict([user('task'), said('done'), hold(refusal), said('done'), hold(refusal), said('done'), hold(refusal), said('done'), idle()]);
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /held 3 times/);
    assert.match(verdict.detail, /its calls: none/);
  });

  test('another text, or no idle success at the end: fail', () => {
    assert.equal(holdVerdict([said('done'), hold('pdkit: something else'), said('x'), idle()]).ok, false);
    assert.equal(holdVerdict([said('done'), hold(refusal), said('x'), idle('failed')]).ok, false);
    assert.equal(holdVerdict([said('done'), hold(refusal), said('x')]).ok, false);
  });

  test("the handler's two stops and its acceptance: pass", async () => {
    const verdict = journalVerdict(await journal(), CHILD);
    assert.equal(verdict.ok, true, verdict.detail);
  });

  test("another run's entries do not count for this one", async () => {
    assert.equal(journalVerdict(await journal(), 'ses_someone_else').ok, false);
  });

  test('one stop, or no acceptance: fail', async () => {
    const { stops, receipts } = await journal();
    assert.equal(journalVerdict({ stops: stops.slice(0, 1), receipts }, CHILD).ok, false);
    assert.equal(journalVerdict({ stops, receipts: [] }, CHILD).ok, false);
  });

  test('stops not filed under the running task: fail', async () => {
    const { stops, receipts } = await journal();
    const elsewhere = stops.map((entry) => ({ ...entry, detail: entry.detail.replace(/; while .*$/, '') }));
    assert.equal(journalVerdict({ stops: elsewhere, receipts }, CHILD).ok, false);
  });
});

describe("the doctor's word", () => {
  const report = (status, detail = 'x') => ({ home: HOME, checks: [{ id: 'hooks:agent-done', status, detail }] });

  test('the home first: another one is a failure whatever else it says', () => {
    assert.equal(doctorVerdict(report('ok'), HOME).ok, true);
    assert.equal(doctorVerdict({ ...report('ok'), home: '/elsewhere' }, HOME).ok, false);
    assert.equal(doctorVerdict(undefined, HOME).ok, false);
    assert.equal(doctorVerdict({ home: HOME }, HOME).ok, false);
  });

  test('after the run, hooks:agent-done ok and nothing less', () => {
    assert.equal(doctorVerdict(report('ok'), HOME, { agentDone: true }).ok, true);
    assert.equal(doctorVerdict(report('warn'), HOME, { agentDone: true }).ok, false);
    const failed = doctorVerdict(report('fail', 'none of them wrote an agent-done'), HOME, { agentDone: true });
    assert.equal(failed.ok, false);
    assert.match(failed.detail, /none of them wrote/);
    assert.equal(doctorVerdict({ home: HOME, checks: [] }, HOME, { agentDone: true }).ok, false);
  });
});

test('usage adds up the sessions, reasoning as output', () => {
  const record = { tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 100 } }, cost: 0.0015 };
  assert.equal(usage([record, record]), '2 sessions: 20 input tokens (200 more read from cache), 14 output, $0.0030');
  assert.equal(usage([{}]), '1 session: 0 input tokens (0 more read from cache), 0 output, $0.0000');
});
