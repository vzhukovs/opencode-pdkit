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

// subagent-stop in Open Code, end to end short of the host: the
// experimental.idle callback a stand-in for setup()'s context collects, called
// as Open Code calls it when a session has finished its model work (F57), with
// the sessions it looks up shaped as Open Code records them (F54). Behind it
// is everything real — the bridge, the runner, a node process running
// bin/pdkit, task-completed.js and the journal — in a repository with a task
// running, against a throwaway $PDKIT_HOME.
//
// A hold is a message the bridge adds to the child session (F58): Open Code
// runs it in the same execution instead of letting the child go idle. So each
// rule of docs/specification/06-hooks.md for subagent-stop is asserted as the
// messages added — the handler's own words, or none — and the journal it
// leaves. Then what Claude Code did for the handler and Open Code does not:
// say whether the last stop was held, and stop holding after eight in a row.
// Then the other half: whatever fails lets the subagent go, and says why.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import plugin from '../opencode/server.js';
import { HOLD_LIMIT } from '../opencode/bridge/hooks.js';
import { start, stop as stopTask } from '../lib/active.js';
import { record as recordAttempt, unblock as unblockTask } from '../lib/attempts.js';
import { issueDir } from '../lib/config.js';
import { writeReceipt } from '../lib/evidence.js';
import { IMPLEMENTER, STALL_LIMIT, handle } from '../lib/hooks/task-completed.js';
import { read as readJournal } from '../lib/journal.js';
import { setOwns, transition } from '../lib/state.js';
import { logOf } from './helpers/server-log.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const execFileAsync = promisify(execFile);

const ISSUE = 18248;

/** The session a person drives, which started the task. */
const PERSON = 'ses_person';

let home;
let repo;
let previousHome;

/** A receipt's run: a passing one unless told otherwise. */
const run = (over = {}) => ({
  command: 'pnpm test:main -- container-registry.spec.ts',
  exitCode: 0,
  stdout: 'Test Files  1 passed (1)\n',
  stderr: '',
  durationMs: 4210,
  at: '2026-07-31T10:00:00.000Z',
  complete: true,
  ...over,
});

const receiptPath = () => join(issueDir(home, ISSUE), 'receipts', 'T1.md');

before(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-subagent-stop-home-')));
  // The child process takes $PDKIT_HOME from the server's environment, as it
  // would in a session; here the server is this process.
  previousHome = process.env.PDKIT_HOME;
  process.env.PDKIT_HOME = home;
  repo = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-subagent-stop-repo-')));
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await transition(ISSUE, 'triaged', { home });
  await setOwns(ISSUE, 'T1', ['packages/main/src/plugin/container-registry.ts'], { home });
});

beforeEach(async () => {
  await rm(receiptPath(), { force: true });
  await rm(join(home, 'config.yaml'), { force: true });
  // A count of failed captures, and of stops without one, starts here.
  await unblockTask({ issue: ISSUE, taskId: 'T1', reason: 'a test of its own', home });
  await start({ issue: ISSUE, taskId: 'T1', worktree: repo, session: PERSON, home });
});

after(async () => {
  if (previousHome === undefined) delete process.env.PDKIT_HOME;
  else process.env.PDKIT_HOME = previousHome;
  for (const dir of [home, repo]) await rm(dir, { recursive: true, force: true });
});

/** A child session's ID of its own for each subagent a test runs: the stall limit counts stops per run. */
let children = 0;
const childId = () => `ses_child${(children += 1)}`;

/**
 * A stand-in for setup()'s context, in the repository: just enough for the
 * entry point to load in full, with the sessions it knows. `stop` calls the
 * experimental.idle callback for a session, as Open Code does before the
 * session goes idle, and gives back the messages the bridge added to it.
 * `ended` sends an event on the stream the bridge subscribed to; a stream
 * that does not `filter` sends it whatever types were asked for. `fail` names
 * the calls that throw, and is read at each call: a test can change it.
 */
function host({ sessions = {}, fail = {}, events = true, filter = true } = {}) {
  let idle;
  const added = [];
  const looked = [];
  const streams = [];
  const registered = { dispose: async () => {} };
  const transforms = { transform: async () => registered };
  const ctx = {
    app: { name: 'cli', version: '2.3.0', channel: 'latest' },
    location: { directory: repo, project: { id: 'global', directory: repo, canonical: repo } },
    tool: { hook: async () => registered },
    session: {
      hook: async (name, callback) => {
        if (name === 'experimental.idle') idle = callback;
        return registered;
      },
      get: async ({ sessionID }) => {
        looked.push(sessionID);
        if (fail.get) throw new Error(fail.get);
        if (!Object.hasOwn(sessions, sessionID)) throw new Error(`Session not found: ${sessionID}`);
        return sessions[sessionID];
      },
      synthetic: async (input) => {
        if (fail.synthetic) throw new Error(fail.synthetic);
        added.push(input);
        return { id: `inbox_${added.length}`, sessionID: input.sessionID, type: 'synthetic', payload: { text: input.text } };
      },
    },
    shell: { hook: async () => registered },
    permission: { hook: async () => registered },
    agent: transforms,
    command: transforms,
    skill: transforms,
  };
  if (events) ctx.event = { subscribe: (options) => stream(filter ? options : { ...options, types: undefined }, streams) };
  return {
    ctx,
    sessions,
    looked,
    streams,
    stop: async (sessionID) => {
      const before = added.length;
      await idle({ sessionID, background: [] });
      return added.slice(before);
    },
    ended: async (type, sessionID) => {
      for (const { push } of streams) push({ type, data: { sessionID } });
      // The bridge reads the stream on its own; let it.
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

/**
 * An event stream as ctx.event.subscribe gives one: an async iterable, ended
 * by the signal it was given. `push` sends it an event.
 */
function stream(options, streams) {
  const queue = [];
  let wake = () => {};
  const signal = options?.signal;
  signal?.addEventListener('abort', () => wake(), { once: true });
  const entry = {
    options,
    push: (event) => {
      if (!options?.types || options.types.includes(event.type)) queue.push(event);
      wake();
    },
  };
  streams.push(entry);
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          while (queue.length === 0) {
            if (signal?.aborted) return { done: true, value: undefined };
            await new Promise((resolve) => (wake = resolve));
          }
          return { done: false, value: queue.shift() };
        },
      };
    },
  };
}

/** A session's record, as ctx.session.get gives it (F54): a child of the person's session unless told otherwise. */
const child = (id, agent = IMPLEMENTER, { parentID = PERSON, directory = repo } = {}) => ({
  id,
  parentID,
  projectID: 'global',
  agent,
  title: 'Implement T1',
  location: { directory },
});

/** The person's session: no parent, and no agent recorded (F54). */
const person = (id = PERSON) => ({ id, projectID: 'global', title: 'Session', location: { directory: repo } });

/** The plugin in this checkout, loaded, with the sessions given. */
async function loaded(t, options) {
  const log = logOf(t);
  const stand = host(options);
  await plugin.setup(stand.ctx);
  return { ...stand, log };
}

/** One implementer, known to the host, and the plugin. */
async function oneImplementer(t, agent = IMPLEMENTER, fields) {
  const id = childId();
  const loadedPlugin = await loaded(t, { sessions: { [PERSON]: person(), [id]: child(id, agent, fields) } });
  return { id, ...loadedPlugin };
}

/** The reason the handler gives itself, for a run of its own, in the same tree: what the model must read. */
async function said(agentType = IMPLEMENTER) {
  const decision = await handle({ agent_id: `direct-${childId()}`, agent_type: agentType, session_id: PERSON, cwd: repo }, { event: 'subagent-stop', pluginRoot: ROOT });
  assert.equal(decision.block, true, 'the handler holds this one');
  return decision.reason;
}

/** The newest `agent-done` entry, and how many there are. */
async function lastRun() {
  const runs = await readJournal({ event: 'agent-done' }, { home });
  return { count: runs.length, last: runs.at(-1) };
}

/** One message added to hold the subagent: the reason in full for the model, its first line for the person. */
function heldWith(added, id, reason) {
  assert.equal(added.length, 1, 'held: one message added');
  assert.deepEqual(added[0], {
    sessionID: id,
    text: reason,
    description: reason.split('\n')[0],
    metadata: { source: 'opencode-pdkit', hook: 'subagent-stop' },
  });
}

describe('the rules of 06-hooks.md for subagent-stop, on experimental.idle', () => {
  test('HK-18: the implementer without a receipt is held, with the command to run as its next instruction', async (t) => {
    const reason = await said();
    const { id, stop, log } = await oneImplementer(t);

    const added = await stop(id);

    heldWith(added, id, reason);
    assert.match(reason, /^pdkit: T1 of issue 18248 cannot be completed — there is no receipt\.\n {2}Run: pdkit receipt write --issue 18248 --task T1\n/);
    assert.equal((await lastRun()).last.detail, `agent task ${id}; pd-implementer; while T1 was active`);
    assert.deepEqual(log(), []);
  });

  test('HK-18: so is one whose receipt was edited after it was captured', async (t) => {
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run(), home });
    const content = await readFile(receiptPath(), 'utf8');
    await writeFile(receiptPath(), content.replace('1 passed (1)', '9 passed (9)'));
    const { id, stop } = await oneImplementer(t);

    const added = await stop(id);

    assert.equal(added.length, 1);
    assert.match(added[0].text, /edited after it was captured/);
  });

  test('HK-19: the implementer with a real receipt of a failed command is held: fix the work and capture again', async (t) => {
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run({ exitCode: 1 }), home });
    const reason = await said();
    const { id, stop } = await oneImplementer(t);

    const added = await stop(id);

    heldWith(added, id, reason);
    assert.match(reason, /valid receipt for a command that failed \(exit 1\)/);
    assert.match(reason, /Fix the work and capture again/);
  });

  test('HK-35: the implementer with a receipt that passes is let go, and the task accepted', async (t) => {
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run(), home });
    const { id, stop, log } = await oneImplementer(t);

    const added = await stop(id);

    assert.deepEqual(added, []);
    const accepted = (await readJournal({ issue: ISSUE, event: 'task-receipt' }, { home })).at(-1);
    assert.equal(accepted.detail, `T1 accepted; agent task ${id}`);
    // Claude Code wrote this to its debug log: an exit 0's stdout on SubagentStop.
    assert.deepEqual(log(), ['opencode-pdkit: subagent-stop message, which reaches no one here: pdkit: T1 has a receipt for `pnpm test:main -- container-registry.spec.ts`']);
  });

  test('HK-17: any other agent is let go, and counted', async (t) => {
    for (const agent of ['pd-scout', 'pd-auditor', 'general']) {
      const { id, stop, log } = await oneImplementer(t, agent);
      const before = (await lastRun()).count;

      assert.deepEqual(await stop(id), [], `${agent} is not asked for T1's receipt`);

      const { count, last } = await lastRun();
      assert.equal(count, before + 1);
      assert.equal(last.detail, `agent task ${id}; ${agent}; while T1 was active`);
      assert.deepEqual(log(), []);
    }
  });

  // Every stop, not every run: a held one, and the one let go after it.
  test('HK-17: every stop is counted, the held ones too', async (t) => {
    const { id, stop } = await oneImplementer(t);
    const before = (await lastRun()).count;

    await stop(id);
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run(), home });
    await stop(id);

    const runs = (await readJournal({ event: 'agent-done' }, { home })).slice(before);
    assert.deepEqual(
      runs.map((entry) => entry.detail),
      [`agent task ${id}; pd-implementer; while T1 was active`, `agent task ${id}; pd-implementer; while T1 was active`],
    );
  });

  // A host that stops naming agents must not open the gate (HK-17): the
  // record names none, so the payload says nothing about the agent.
  test('HK-17: a subagent whose agent the host does not name is held', async (t) => {
    for (const agent of [undefined, '']) {
      const id = childId();
      const { stop } = await loaded(t, { sessions: { [PERSON]: person(), [id]: { ...child(id), agent } } });

      const added = await stop(id);

      assert.equal(added.length, 1, `agent ${JSON.stringify(agent)} is gated`);
      assert.match(added[0].text, /there is no receipt/);
      assert.equal((await lastRun()).last.detail, `agent task ${id}; while T1 was active`);
    }
  });

  test(`HK-20: a run that cannot capture is warned on stop ${STALL_LIMIT}, let go after it, and not accepted`, async (t) => {
    const { id, stop, log } = await oneImplementer(t);
    const accepted = async () => (await readJournal({ issue: ISSUE, event: 'task-receipt' }, { home })).length;
    const acceptedBefore = await accepted();

    for (let stopNumber = 1; stopNumber < STALL_LIMIT; stopNumber += 1) {
      const added = await stop(id);
      assert.equal(added.length, 1, `stop ${stopNumber} is held`);
      assert.doesNotMatch(added[0].text, /next stop is let go/);
    }
    const warned = await stop(id);
    assert.equal(warned.length, 1);
    assert.match(warned[0].text, /This is stop 3 with nothing captured\. .*the next stop is let go/);

    assert.deepEqual(await stop(id), [], `stop ${STALL_LIMIT + 1} is let go`);
    assert.equal(await accepted(), acceptedBefore, 'letting go is not acceptance');
    assert.equal(log().length, 1);
    assert.match(log()[0], /^opencode-pdkit: subagent-stop message, which reaches no one here: pdkit: T1 of issue 18248 is NOT accepted — let go after 4 stops/);
  });

  // stop_hook_active, which Claude Code sent and Open Code does not: the bridge
  // remembers that it held the last stop. At the ceiling the first stop of a
  // round is held with "blocked", the next one let go with the same words —
  // and a later round starts over, as Claude Code started it with false.
  test('HK-21: at the attempts ceiling the implementer is held once with "blocked", then let go — once a round', async (t) => {
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run({ exitCode: 1 }), home });
    for (let i = 0; i < 3; i += 1) await recordAttempt({ issue: ISSUE, taskId: 'T1', exitCode: 1, home });
    const { id, stop, log } = await oneImplementer(t);

    const first = await stop(id);
    assert.equal(first.length, 1);
    assert.match(first[0].text, /^pdkit: T1 of issue 18248 is blocked: 3 failed captures/);

    assert.deepEqual(await stop(id), [], 'told once: let go, not held for a fourth try');
    assert.equal(log().length, 1);
    assert.match(log()[0], /^opencode-pdkit: subagent-stop message, which reaches no one here: pdkit: T1 of issue 18248 is blocked/);

    // A follow-up from the parent: a new round of the same run.
    const again = await stop(id);
    assert.equal(again.length, 1, 'the first stop of the next round is held again');
    assert.equal(again[0].text, first[0].text);
  });

  test('HK-21: after pdkit task unblock the implementer is held as before the ceiling', async (t) => {
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run({ exitCode: 1 }), home });
    for (let i = 0; i < 3; i += 1) await recordAttempt({ issue: ISSUE, taskId: 'T1', exitCode: 1, home });
    await unblockTask({ issue: ISSUE, taskId: 'T1', reason: 'plan amended: A1', home });
    const reason = await said();
    const { id, stop } = await oneImplementer(t);

    const added = await stop(id);

    heldWith(added, id, reason);
    assert.match(reason, /valid receipt for a command that failed \(exit 1\)/);
    assert.doesNotMatch(reason, /is blocked/);
  });

  // Agents of the host's own (Claude Code's prompt suggestions): Open Code
  // asks the hook of every session, and the sessions that are nobody's
  // subagent are the ones a person drives, which have no parent.
  test('HK-33: a session with no parent is neither held nor counted', async (t) => {
    const { stop, log, looked } = await loaded(t, { sessions: { [PERSON]: person() } });
    const before = (await lastRun()).count;

    assert.deepEqual(await stop(PERSON), []);

    assert.equal((await lastRun()).count, before);
    assert.deepEqual(looked, [PERSON], 'one lookup, and nothing else');
    assert.deepEqual(log(), []);
  });

  test('HK-34: a subagent of another session in the same tree is let go, and counted as not the task\'s', async (t) => {
    const id = childId();
    const { stop, log } = await loaded(t, { sessions: { 'ses_other': person('ses_other'), [id]: child(id, IMPLEMENTER, { parentID: 'ses_other' }) } });

    assert.deepEqual(await stop(id), []);

    const { last } = await lastRun();
    assert.equal(last.detail, `agent task ${id}; pd-implementer; from another session than the one running T1`);
    assert.deepEqual(log(), []);
  });

  // The session that started the task is the one at the top: a subagent's
  // subagent is its session's as much as its parent is.
  test('HK-34: the session is the one at the top of the chain, not the parent', async (t) => {
    const middle = childId();
    const id = childId();
    const { stop } = await loaded(t, {
      sessions: { [PERSON]: person(), [middle]: child(middle, 'general'), [id]: child(id, IMPLEMENTER, { parentID: middle }) },
    });

    const added = await stop(id);

    assert.equal(added.length, 1, 'held: its session is the one running T1');
    assert.match((await lastRun()).last.detail, /while T1 was active$/);
  });

  test('with no task running a subagent is let go, and counted by the branch of its tree', async (t) => {
    await stopTask({ worktree: repo, home });
    await execFileAsync('git', ['checkout', '-q', '-b', `DESKTOP-${ISSUE}/subagent-stop`], { cwd: repo });
    t.after(() => execFileAsync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: repo }));
    const { id, stop, log } = await oneImplementer(t);

    assert.deepEqual(await stop(id), []);

    const last = (await readJournal({ issue: ISSUE, event: 'agent-done' }, { home })).at(-1);
    assert.equal(last.detail, `agent task ${id}; pd-implementer`);
    assert.deepEqual(log(), []);
  });

  test('the run is filed under its directory: a subagent in another tree is not held for this one\'s task', async (t) => {
    const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-subagent-stop-elsewhere-')));
    t.after(() => rm(elsewhere, { recursive: true, force: true }));
    const { id, stop } = await oneImplementer(t, IMPLEMENTER, { directory: elsewhere });

    assert.deepEqual(await stop(id), []);
    assert.equal((await lastRun()).last.detail, `agent task ${id}; pd-implementer`);
  });
});

// What Claude Code did on its side of SubagentStop, and the bridge does here.
describe('what the host did, done by the bridge', () => {
  // Claude Code let a subagent go after eight holds in a row whatever the hook
  // said (CLAUDE_CODE_STOP_HOOK_BLOCK_CAP). With `exec.max_attempts: 0` and a
  // capture that stays red, nothing in pdkit ends the loop: every stop follows
  // a capture, so the stall limit never comes, and the ceiling is off.
  test(`no more than ${HOLD_LIMIT} holds in a row, as Claude Code allowed; the next round starts afresh`, async (t) => {
    await writeFile(join(home, 'config.yaml'), 'exec:\n  max_attempts: 0\n');
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run({ exitCode: 1 }), home });
    const { id, stop, log } = await oneImplementer(t);

    const holds = [];
    for (let stopNumber = 1; stopNumber <= HOLD_LIMIT + 1; stopNumber += 1) {
      await recordAttempt({ issue: ISSUE, taskId: 'T1', exitCode: 1, home });
      holds.push((await stop(id)).length);
    }

    assert.deepEqual(holds, [...Array(HOLD_LIMIT).fill(1), 0]);
    assert.deepEqual(log(), [`opencode-pdkit: pdkit: hook "subagent-stop" held ${id} ${HOLD_LIMIT} times in a row, as many as Claude Code allowed; letting it go`]);

    await recordAttempt({ issue: ISSUE, taskId: 'T1', exitCode: 1, home });
    assert.equal((await stop(id)).length, 1, 'a follow-up is a new round');
  });

  test('the limit is the one Claude Code documents', () => {
    assert.equal(HOLD_LIMIT, 8);
  });

  // Subagents run side by side (F62), and each is held on its own (F66).
  test('subagents side by side are each held, and let go, on their own', async (t) => {
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run({ exitCode: 1 }), home });
    for (let i = 0; i < 3; i += 1) await recordAttempt({ issue: ISSUE, taskId: 'T1', exitCode: 1, home });
    const [a, b] = [childId(), childId()];
    const { stop } = await loaded(t, { sessions: { [PERSON]: person(), [a]: child(a), [b]: child(b) } });

    assert.equal((await stop(a)).length, 1, 'a: held');
    assert.equal((await stop(b)).length, 1, 'b: held, though a was held before it');
    assert.equal((await stop(a)).length, 0, 'a: told, let go');
    assert.equal((await stop(b)).length, 0, 'b: told, let go');
  });

  // No stop follows a run that failed or was interrupted (F57): the mark of a
  // stop held before it would make the first stop of the next round read as
  // one already told.
  for (const type of ['session.execution.failed', 'session.execution.interrupted']) {
    test(`a held subagent whose run ends with ${type} starts its next round afresh`, async (t) => {
      await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run({ exitCode: 1 }), home });
      for (let i = 0; i < 3; i += 1) await recordAttempt({ issue: ISSUE, taskId: 'T1', exitCode: 1, home });
      const { id, stop, ended, streams } = await oneImplementer(t);

      assert.equal((await stop(id)).length, 1);
      await ended(type, id);

      assert.equal((await stop(id)).length, 1, 'held again: not taken for one already told');
      assert.deepEqual(streams[0].options.types, ['session.execution.failed', 'session.execution.interrupted']);
    });
  }

  test("another session's run ending changes nothing for this one", async (t) => {
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run({ exitCode: 1 }), home });
    for (let i = 0; i < 3; i += 1) await recordAttempt({ issue: ISSUE, taskId: 'T1', exitCode: 1, home });
    const { id, stop, ended } = await oneImplementer(t);

    assert.equal((await stop(id)).length, 1);
    await ended('session.execution.failed', 'ses_someone_else');
    await ended('session.execution.succeeded', id);

    assert.deepEqual(await stop(id), [], 'still told: let go');
  });

  // The types are asked of the host; the bridge does not rely on getting only
  // those. A run that succeeded ended in a stop the bridge saw.
  test('only a failed or interrupted run is forgotten, whatever the stream sends', async (t) => {
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run({ exitCode: 1 }), home });
    for (let i = 0; i < 3; i += 1) await recordAttempt({ issue: ISSUE, taskId: 'T1', exitCode: 1, home });
    const id = childId();
    const { stop, ended } = await loaded(t, { sessions: implementerSessions(id), filter: false });

    assert.equal((await stop(id)).length, 1);
    for (const type of ['session.execution.succeeded', 'session.execution.started', 'session.step.ended']) await ended(type, id);

    assert.deepEqual(await stop(id), [], 'still told: let go');
  });

  test('cleanup ends the watch on runs, and forgets what was held', async (t) => {
    logOf(t);
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run({ exitCode: 1 }), home });
    for (let i = 0; i < 3; i += 1) await recordAttempt({ issue: ISSUE, taskId: 'T1', exitCode: 1, home });
    const id = childId();
    const stand = host({ sessions: { [PERSON]: person(), [id]: child(id) } });
    const cleanup = await plugin.setup(stand.ctx);

    assert.equal((await stand.stop(id)).length, 1);
    await cleanup();

    assert.equal(stand.streams[0].options.signal.aborted, true);
    assert.equal((await stand.stop(id)).length, 1, 'nothing remembered: the stop is a first one');
  });
});

/**
 * A copy of the plugin with some files replaced, loaded in the repository,
 * with the sessions given.
 *
 * @param {import('node:test').TestContext} t
 * @param {Record<string, string|((text: string) => string)|null>} files
 */
async function broken(t, files, options) {
  const dir = await mkdtemp(join(tmpdir(), 'pdkit-subagent-stop-plugin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const entry of ['opencode', 'lib', 'bin', 'defaults', 'agents', 'skills', 'package.json']) {
    await cp(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  for (const [path, change] of Object.entries(files)) {
    const file = join(dir, path);
    if (change === null) await rm(file);
    else await writeFile(file, typeof change === 'function' ? change(await readFile(file, 'utf8')) : change);
  }
  const copy = (await import(pathToFileURL(join(dir, 'opencode', 'server.js')).href)).default;
  const log = logOf(t, { watch: false });
  const stand = host(options);
  await copy.setup(stand.ctx);
  return { ...stand, log };
}

/** The sessions of one implementer, for a stand-in: the person's and the child's. */
const implementerSessions = (id, fields) => ({ [PERSON]: person(), [id]: child(id, IMPLEMENTER, fields) });

/** The one line a stop let go for want of an answer leaves in the log: subagent-stop's, saying `problem`. */
const allowing = (log, problem) => {
  assert.equal(log().length, 1, log().join('\n'));
  assert.match(log()[0], new RegExp(`^opencode-pdkit: pdkit: hook "subagent-stop" ${problem}.*; allowing$`, 's'));
};

// subagent-stop fails open (FAIL_CLOSED names pre-bash alone): a handler that
// cannot run must neither keep a subagent running nor stop the work. Here
// failing open is also not failing the child's run: an exception out of the
// callback would end it, lose its answer, and hand the parent the exception
// (F59). Each case is an implementer without a receipt, which a working gate
// holds, so a stop let go is the failure's doing.
describe('no answer lets the subagent go, and says why', () => {
  test('no node on the PATH of the server', async (t) => {
    const { id, stop, log } = await oneImplementer(t);
    const path = process.env.PATH;
    process.env.PATH = home;
    t.after(() => (process.env.PATH = path));

    assert.deepEqual(await stop(id), []);
    allowing(log, 'cannot run: "node" was not found on the PATH of the process that runs hooks \\(ENOENT\\)');
  });

  test('a session directory that does not exist', async (t) => {
    const { id, stop, log } = await oneImplementer(t, IMPLEMENTER, { directory: join(repo, 'missing') });

    assert.deepEqual(await stop(id), []);
    allowing(log, 'cannot run: its working directory does not exist: ');
  });

  test('a session record without a directory', async (t) => {
    const id = childId();
    const { stop, log } = await loaded(t, { sessions: { [PERSON]: person(), [id]: { ...child(id), location: undefined } } });

    assert.deepEqual(await stop(id), []);
    allowing(log, 'cannot run: the payload names no working directory');
  });

  test('a CLI that does not load: exit 1', async (t) => {
    const id = childId();
    const { stop, log } = await broken(t, { 'lib/cli.js': 'this is not valid javascript {{{\n' }, { sessions: implementerSessions(id) });

    assert.deepEqual(await stop(id), []);
    allowing(log, 'exited with code 1 \\(SyntaxError: ');
  });

  test('a handler that does not load: runHook allows, as under Claude Code', async (t) => {
    const id = childId();
    const { stop, log } = await broken(t, { 'lib/hooks/task-completed.js': 'this is not valid javascript {{{\n' }, { sessions: implementerSessions(id) });

    assert.deepEqual(await stop(id), []);
    allowing(log, 'handler "task-completed\\.js" is unavailable');
  });

  test('a handler that throws: runHook allows, as under Claude Code', async (t) => {
    const id = childId();
    const { stop, log } = await broken(t, { 'lib/hooks/task-completed.js': "export async function handle() { throw new Error('the journal broke'); }\n" }, { sessions: implementerSessions(id) });

    assert.deepEqual(await stop(id), []);
    allowing(log, 'failed \\(the journal broke\\)');
  });

  // Open Code waits on the hook without end (F59): the deadline is the bridge's.
  test('a handler that hangs: stopped at the deadline', async (t) => {
    const id = childId();
    const { stop, log } = await broken(
      t,
      {
        'lib/hooks/task-completed.js': 'export function handle() { return new Promise(() => setInterval(() => {}, 1000)); }\n',
        'lib/hooks/runner.js': (source) => source.replace('export const DEADLINE_MS = 10_000;', 'export const DEADLINE_MS = 2_000;'),
      },
      { sessions: implementerSessions(id) },
    );

    assert.deepEqual(await stop(id), []);
    allowing(log, 'gave no answer within 2s and was stopped');
  });

  test('a session that cannot be looked up', async (t) => {
    const id = childId();
    const { stop, log } = await loaded(t, { sessions: implementerSessions(id), fail: { get: 'the store is closed' } });

    assert.deepEqual(await stop(id), []);
    allowing(log, 'failed in the hook bridge \\(the store is closed\\)');
  });

  test('a parent that cannot be looked up', async (t) => {
    const id = childId();
    const { stop, log } = await loaded(t, { sessions: { [id]: child(id) } });

    assert.deepEqual(await stop(id), []);
    allowing(log, `failed in the hook bridge \\(Session not found: ${PERSON}\\)`);
  });

  // A hold that could not be added is a stop let go, and not remembered as
  // held: at the attempts ceiling, the next stop of the subagent is a first
  // one, and held with "blocked" — not let go as one already told.
  test('a message that cannot be added', async (t) => {
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run({ exitCode: 1 }), home });
    for (let i = 0; i < 3; i += 1) await recordAttempt({ issue: ISSUE, taskId: 'T1', exitCode: 1, home });
    const id = childId();
    const fail = { synthetic: 'the inbox is closed' };
    const { stop, log } = await loaded(t, { sessions: implementerSessions(id), fail });

    assert.deepEqual(await stop(id), []);
    allowing(log, 'failed in the hook bridge \\(the inbox is closed\\)');

    delete fail.synthetic;
    const next = await stop(id);
    assert.equal(next.length, 1, 'held: the stop before was not one held');
    assert.match(next[0].text, /is blocked/);
  });

  // A stop that fails after one held lets the subagent go, and forgets the
  // hold with it, as any stop let go does: the next is the first of a round.
  test('a failure after a hold forgets the hold', async (t) => {
    await writeReceipt({ issue: ISSUE, taskId: 'T1', run: run({ exitCode: 1 }), home });
    for (let i = 0; i < 3; i += 1) await recordAttempt({ issue: ISSUE, taskId: 'T1', exitCode: 1, home });
    const id = childId();
    const fail = {};
    const { stop, log } = await loaded(t, { sessions: implementerSessions(id), fail });

    assert.equal((await stop(id)).length, 1, 'held with "blocked"');
    fail.get = 'the store is closed';
    assert.deepEqual(await stop(id), []);
    allowing(log, 'failed in the hook bridge \\(the store is closed\\)');

    delete fail.get;
    assert.equal((await stop(id)).length, 1, 'a first stop again: held with "blocked", not let go as told');
  });

  test('a callback without a session to look at says nothing, and does nothing', async (t) => {
    const { stop, log, looked } = await loaded(t, { sessions: {} });

    for (const sessionID of [undefined, '']) assert.deepEqual(await stop(sessionID), []);
    assert.deepEqual(looked, []);
    assert.deepEqual(log(), []);
  });

  // The filter is before the process: a session nobody's subagent costs a
  // lookup, and nothing that could fail — not even with a CLI that does not load.
  test('a session with no parent starts no process', async (t) => {
    const { stop, log } = await broken(t, { 'lib/cli.js': 'this is not valid javascript {{{\n' }, { sessions: { [PERSON]: person() } });

    assert.deepEqual(await stop(PERSON), []);
    assert.deepEqual(log(), []);
  });

  // Without the watch the gate holds as before; only a run that fails while
  // held is not forgotten. Said once, at setup.
  test('a host with no event stream: holds as before, and says what it cannot do', async (t) => {
    const id = childId();
    const { stop, log } = await loaded(t, { sessions: implementerSessions(id), events: false });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal((await stop(id)).length, 1);
    // session-start says what it cannot do without the stream in a line of its own.
    const lines = log().filter((line) => !/compactions/.test(line));
    assert.equal(lines.length, 1, log().join('\n'));
    assert.match(lines[0], /^opencode-pdkit: pdkit: the hook bridge cannot follow the runs of subagents that fail or are interrupted \(.+\); one held when that happens is taken, at its next stop, for one already told$/);
  });
});

describe('where it is registered', () => {
  // A host that renamed experimental.idle (F57: "name and shape may change")
  // must leave the other hooks registered, and say which point it lacks.
  test('a point the host does not have leaves the rest registered, and is reported', async (t) => {
    const log = logOf(t);
    const stand = host();
    const points = [];
    stand.ctx.tool.hook = async (name) => {
      points.push(`tool.hook ${name}`);
      return { dispose: async () => {} };
    };
    stand.ctx.session.hook = async (name) => {
      throw new Error(`unknown session hook: ${name}`);
    };

    await plugin.setup(stand.ctx);

    assert.deepEqual(points, ['tool.hook execute.before', 'tool.hook execute.before', 'tool.hook execute.after']);
    assert.deepEqual(log(), [
      'opencode-pdkit: cannot register its hooks (unknown session hook: experimental.idle; unknown session hook: prompt; unknown session hook: fork; unknown session hook: compaction); the gate and the rest are unaffected',
      // The agents' hiding of tools stands on session hooks too (opencode/agents.js).
      'opencode-pdkit: cannot register its hiding of tools (unknown session hook: context; unknown session hook: compaction; unknown session hook: generate); pd-implementer, pd-thread-resolver may be offered opencode_worktree_remove, which Claude Code did not give them',
      // And the end of a grant of allowed-tools, on the prompt hook (opencode/allowed.js).
      "opencode-pdkit: cannot register its allowed tools (unknown session hook: prompt); /pd:editor, /pd:open run their commands as the person's rules say, asking where they ask",
    ]);
    const watches = stand.streams.filter(({ options }) => options.types?.includes('session.execution.failed'));
    assert.equal(watches.length, 0, 'no watch for a hook that is not there');
  });
});
