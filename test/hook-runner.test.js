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

// Tests for lib/hooks/runner.js — the host's side of `pdkit hook <event>`.
//
// Three things are pinned here. That run() reports what happened to the
// process — every way it can fail to answer included — and never throws: it
// is run against a stand-in plugin whose bin/pdkit does what each case needs.
// That decide() reads runHook's output back into the decision handle()
// returned, and turns no answer into a refusal on the event that guards
// writes upstream and into a pass everywhere else. And that the two together
// agree with the handler itself: invoke() through the real bin/pdkit gives
// what a direct handle() gives, on the gate's own fixtures, and refuses in
// runHook's words when the handler cannot run.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { DEADLINE_MS, childEnv, decide, invoke, refusal, run } from '../lib/hooks/runner.js';
import { FAIL_CLOSED } from '../lib/hooks/events.js';
import { handle } from '../lib/hooks/dispatch.js';
import { handle as handleOwns } from '../lib/hooks/owns.js';
import { handle as handlePostWrite } from '../lib/hooks/post-write.js';
import { handle as handlePostClaim } from '../lib/hooks/post-claim.js';
import { handle as handlePostBash } from '../lib/hooks/post-bash.js';
import { handle as handlePostRead } from '../lib/hooks/post-read.js';
import { handle as handleSubagentStop } from '../lib/hooks/task-completed.js';
import { handle as handleSessionStart } from '../lib/hooks/session-start.js';
import { handle as handlePromptSubmit } from '../lib/hooks/prompt-submit.js';
import { record as recordAttempt, unblock as unblockTask } from '../lib/attempts.js';
import { issueDir } from '../lib/config.js';
import { writeReceipt } from '../lib/evidence.js';
import { PLUGIN_ROOT } from '../lib/commands/support.js';
import { spdxHeader } from '../lib/upstream.js';
import { start, stop } from '../lib/active.js';
import * as gate from '../lib/gate.js';
import { setOwns, transition, withdrawTask } from '../lib/state.js';
import { read as readJournal } from '../lib/journal.js';
import { BRANCH, otherRepository, podmanDesktopClone, readyIssue } from './helpers/gate-fixture.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const execFileAsync = promisify(execFile);
const POSIX = process.platform !== 'win32';

/** The advice every refusal for want of an answer ends with, as runner.js words it. */
const ADVICE = refusal('pre-bash', 'x').slice('pdkit: hook "pre-bash" x. '.length);

/**
 * A stand-in plugin whose bin/pdkit does what the event name says. Run with
 * this process's own node, so it behaves the same on every platform; the
 * cases about finding `node` pass a name of their own.
 */
const STUB = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [, , verb, event] = process.argv;
let input = '';
for await (const chunk of process.stdin) input += chunk;

if (event === 'echo') {
  process.stdout.write(JSON.stringify({ argv: [verb, event], input: JSON.parse(input), cwd: process.cwd(), env: process.env }));
} else if (event === 'exit-1') {
  process.stderr.write('pdkit hook: something broke\\n');
  process.exitCode = 1;
} else if (event === 'signal') {
  process.kill(process.pid, 'SIGKILL');
} else if (event === 'hang') {
  // A child of its own that outlives nothing, so the deadline has a grandchild to stop.
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(process.env.RUNNER_TEST_PIDFILE, String(grandchild.pid));
  setInterval(() => {}, 1000);
}
`;

let stub;
let work;

before(async () => {
  stub = await mkdtemp(join(tmpdir(), 'pdkit-runner-stub-'));
  await mkdir(join(stub, 'bin'));
  await writeFile(join(stub, 'package.json'), '{ "type": "module" }\n');
  await writeFile(join(stub, 'bin', 'pdkit'), STUB);
  work = await mkdtemp(join(tmpdir(), 'pdkit-runner-work-'));
});

after(async () => {
  await rm(stub, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

/** A pre-bash payload in the work directory. */
const payload = (fields = {}) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: work, ...fields });

/** run() against the stand-in plugin, on its own node. */
const runStub = (event, fields, options = {}) => run(event, payload(fields), { root: stub, node: process.execPath, ...options });

/** Whether a process is still there. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('run', () => {
  test('hands the payload to `pdkit hook <event>` and closes stdin behind it', async () => {
    // The stand-in reads stdin to its end: it answers at all only because the
    // pipe was closed.
    const outcome = await runStub('echo');

    assert.equal(outcome.failure, null);
    assert.equal(outcome.code, 0);
    const seen = JSON.parse(outcome.stdout);
    assert.deepEqual(seen.argv, ['hook', 'echo']);
    assert.deepEqual(seen.input, payload());
  });

  test("runs in the payload's working directory, not the caller's", async () => {
    const outcome = await runStub('echo');

    assert.equal(JSON.parse(outcome.stdout).cwd, await realpath(work));
  });

  test('passes the environment on, less what a hook must not inherit', async () => {
    const base = { ...process.env, CLAUDE_PID: '4242', RUNNER_TEST_KEPT: 'kept' };
    const outcome = await runStub('echo', {}, { env: base });

    const env = JSON.parse(outcome.stdout).env;
    assert.equal(env.RUNNER_TEST_KEPT, 'kept');
    assert.equal('CLAUDE_PID' in env, false);
    assert.equal(base.CLAUDE_PID, '4242', 'the environment it was given is left as it was');
  });

  test('childEnv drops only what it must', () => {
    assert.deepEqual(childEnv({ A: '1', CLAUDE_PID: '2', PATH: '/bin' }), { A: '1', PATH: '/bin' });
  });

  test('a node that is not there is a failure to start, named', async () => {
    const outcome = await runStub('echo', {}, { node: 'pdkit-runner-test-no-such-node' });

    assert.equal(outcome.code, null);
    assert.equal(outcome.failure.kind, 'spawn');
    assert.equal(
      outcome.failure.detail,
      `cannot run: "pdkit-runner-test-no-such-node" was not found on the PATH of the process that runs hooks (ENOENT); pdkit's hooks need Node.js 22 or later there`,
    );
  });

  // Not process.execPath: inside the Open Code server that is the server's own
  // binary. The PATH that counts is the one the child is given.
  test('node is looked up on the PATH of the environment the child gets', { skip: !POSIX && 'T10.10' }, async () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PATH'));
    const outcome = await run('echo', payload(), { root: stub, env: { ...env, PATH: work } });

    assert.equal(outcome.failure?.kind, 'spawn');
    assert.match(outcome.failure.detail, /"node" was not found on the PATH/);
  });

  // spawn answers a missing directory with ENOENT, as it does a missing node;
  // checked first so the two are not confused.
  for (const [label, cwd, said] of [
    ['missing', () => join(work, 'missing'), /does not exist/],
    ['a file', () => join(stub, 'bin', 'pdkit'), /is not a directory/],
    ['relative', () => 'relative/dir', /not an absolute path/],
    ['not given', () => undefined, /names no working directory/],
  ]) {
    test(`a working directory that is ${label} is a failure before anything starts`, async () => {
      let started = false;
      const outcome = await runStub('echo', { cwd: cwd() }, { spawn: () => (started = true) });

      assert.equal(started, false);
      assert.equal(outcome.failure.kind, 'cwd');
      assert.match(outcome.failure.detail, said);
    });
  }

  test('an exit code is reported with what the process wrote', async () => {
    const outcome = await runStub('exit-1');

    assert.deepEqual(outcome, { code: 1, stdout: '', stderr: 'pdkit hook: something broke\n', failure: null });
  });

  test('a process killed by a signal is a failure', { skip: !POSIX && 'no signals on Windows' }, async () => {
    const outcome = await runStub('signal');

    assert.equal(outcome.code, null);
    assert.deepEqual(outcome.failure, { kind: 'signal', detail: 'was killed by SIGKILL' });
  });

  test('a process that does not answer in time is stopped, with what it started', { skip: !POSIX && 'T10.10' }, async () => {
    const pidfile = join(work, 'grandchild.pid');
    const started = Date.now();

    const outcome = await runStub('hang', {}, { env: { ...process.env, RUNNER_TEST_PIDFILE: pidfile }, deadlineMs: 400 });

    assert.ok(Date.now() - started < 400 + 2000, 'the deadline did not hold');
    assert.deepEqual(outcome.failure, { kind: 'deadline', detail: 'gave no answer within 0.4s and was stopped' });
    const grandchild = Number(await readFile(pidfile, 'utf8'));
    for (let i = 0; i < 20 && alive(grandchild); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(alive(grandchild), false, 'the hook was stopped and its own child was left running');
  });

  test('never rejects: a spawn that throws is a failure to start', async () => {
    const outcome = await runStub('echo', {}, {
      spawn: () => {
        throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
      },
    });

    assert.equal(outcome.failure.kind, 'spawn');
    assert.match(outcome.failure.detail, /did not start \(EACCES\)/);
  });

  test('never rejects: a payload that is not JSON is a failure to start', async () => {
    const outcome = await runStub('echo', { size: 10n });

    assert.equal(outcome.failure.kind, 'spawn');
    assert.match(outcome.failure.detail, /payload is not JSON/);
  });

  test('the deadline is set for a hang, not for a slow machine', () => {
    assert.ok(DEADLINE_MS >= 5000, `${DEADLINE_MS}ms would refuse ordinary commands on a loaded machine`);
  });
});

/** An outcome with the given fields. */
const outcome = (fields) => ({ code: null, stdout: '', stderr: '', failure: null, ...fields });

describe('decide', () => {
  const OPEN = 'post-bash';

  test('the events are the ones the policy names', () => {
    assert.ok(FAIL_CLOSED.includes('pre-bash'));
    assert.ok(!FAIL_CLOSED.includes(OPEN));
  });

  for (const event of ['pre-bash', OPEN]) {
    describe(`on ${event}`, () => {
      test('exit 2 refuses, with stderr as the reason', () => {
        assert.deepEqual(decide(event, outcome({ code: 2, stderr: 'pdkit: no.\n  command: git push\n' })), {
          block: true,
          reason: 'pdkit: no.\n  command: git push',
        });
      });

      test('exit 2 with nothing on stderr still refuses', () => {
        assert.deepEqual(decide(event, outcome({ code: 2 })), { block: true, reason: `pdkit: hook "${event}" refused without saying why` });
      });

      test('exit 0 with nothing to say allows', () => {
        assert.deepEqual(decide(event, outcome({ code: 0 })), { block: false });
      });

      test('exit 0 with text is a message', () => {
        assert.deepEqual(decide(event, outcome({ code: 0, stdout: 'pdkit: consent token for x spent\n' })), {
          block: false,
          message: 'pdkit: consent token for x spent',
        });
      });

      test('a notice and the context for the model come back from their JSON', () => {
        const stdout = `${JSON.stringify({ systemMessage: 'to the person', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'to the model' } })}\n`;
        assert.deepEqual(decide(event, outcome({ code: 0, stdout })), { block: false, notice: 'to the person', message: 'to the model' });
      });

      test('context after a tool comes back from its JSON', () => {
        const stdout = `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'the block was cut' } })}\n`;
        assert.deepEqual(decide(event, outcome({ code: 0, stdout })), { block: false, message: 'the block was cut' });
      });

      test('JSON that is not the protocol is a message like any other text', () => {
        assert.deepEqual(decide(event, outcome({ code: 0, stdout: '{"a": 1}\n' })), { block: false, message: '{"a": 1}' });
      });

      test('what an allowing run wrote to stderr comes back as a diagnostic', () => {
        assert.deepEqual(decide(event, outcome({ code: 0, stderr: `pdkit: hook "${event}" failed (boom); allowing\n` })), {
          block: false,
          diagnostic: `pdkit: hook "${event}" failed (boom); allowing`,
        });
      });
    });
  }

  // Everything that is not an answer, and what each says. On pre-bash it
  // refuses in runHook's words; on any other event it allows and says why in
  // runHook's words for that case.
  const UNANSWERED = [
    ['exit 1 with an error', outcome({ code: 1, stderr: 'file:///x/lib/cli.js:1\nSyntaxError: Unexpected token\n    at x\n\nNode.js v20.20.0\n' }), 'exited with code 1 (SyntaxError: Unexpected token; Node.js v20.20.0)'],
    ['exit 1 with nothing said', outcome({ code: 1 }), 'exited with code 1 and wrote nothing to stderr'],
    ['exit 127', outcome({ code: 127, stderr: 'env: node: No such file or directory\n' }), 'exited with code 127 (env: node: No such file or directory)'],
    ['no node', outcome({ failure: { kind: 'spawn', detail: 'cannot run: "node" was not found on the PATH' } }), 'cannot run: "node" was not found on the PATH'],
    ['no directory', outcome({ failure: { kind: 'cwd', detail: 'cannot run: its working directory does not exist: /x' } }), 'cannot run: its working directory does not exist: /x'],
    ['a deadline', outcome({ failure: { kind: 'deadline', detail: 'gave no answer within 10s and was stopped' } }), 'gave no answer within 10s and was stopped'],
    ['a signal', outcome({ failure: { kind: 'signal', detail: 'was killed by SIGKILL' } }), 'was killed by SIGKILL'],
  ];

  for (const [label, given, problem] of UNANSWERED) {
    test(`${label}: pre-bash refuses`, () => {
      assert.deepEqual(decide('pre-bash', given), { block: true, reason: refusal('pre-bash', problem), undecided: problem });
    });

    test(`${label}: ${OPEN} allows and says why`, () => {
      assert.deepEqual(decide(OPEN, given), { block: false, undecided: problem, diagnostic: `pdkit: hook "${OPEN}" ${problem}; allowing` });
    });
  }

  // A failure that comes with an exit code is the failure, not the code.
  test('a failure outweighs whatever code came with it', () => {
    const given = outcome({ code: 2, failure: { kind: 'deadline', detail: 'gave no answer within 10s and was stopped' } });
    assert.equal(decide(OPEN, given).block, false);
  });
});

// The handler's side and this module's must agree, and the only way to know is
// to run both: dispatch.js imported, and the same payload through bin/pdkit.
describe('invoke agrees with handle', () => {
  let home;
  let repo;
  let other;
  let previousHome;

  before(async () => {
    home = await mkdtemp(join(tmpdir(), 'pdkit-runner-home-'));
    previousHome = process.env.PDKIT_HOME;
    process.env.PDKIT_HOME = home;
    repo = await podmanDesktopClone('pdkit-runner-repo-');
    other = await otherRepository('pdkit-runner-other-');
    await readyIssue(2001, { home });
    await readyIssue(2002, { home, prOpen: true });
  });

  beforeEach(async () => {
    await gate.revokeAll({ home });
  });

  after(async () => {
    if (previousHome === undefined) delete process.env.PDKIT_HOME;
    else process.env.PDKIT_HOME = previousHome;
    for (const dir of [home, repo, other]) await rm(dir, { recursive: true, force: true });
  });

  const bash = (command, cwd = repo) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });

  /** What the decision says, as far as the process protocol carries it. */
  const carried = (decision) => ({ block: decision.block, reason: decision.reason, message: decision.message });

  const FIXTURES = [
    ['ordinary work', () => bash('git status')],
    ['a push without a token', () => bash('git push')],
    ['a push with a token', () => bash('git push'), () => gate.open({ issue: 2001, branch: BRANCH, home })],
    ['a pull request without a token', () => bash('gh pr create --base main --head DESKTOP-2001/other --title x')],
    ['a review write without a reply token', () => bash('gh pr comment 17577 --body x')],
    ['a review write with one', () => bash('gh pr comment 17577 --body x'), () => gate.open({ issue: 2002, pr: 17577, kind: 'reply', home })],
    ['a mutation that names no pull request', () => bash('gh api graphql -f query="mutation { x }"')],
    ['a tracker write', () => bash('gh issue comment 17221 --body x')],
    ['a force push', () => bash(`git push --force origin ${BRANCH}`)],
    ['add -A', () => bash('git add -A')],
    ['an interactive rebase', () => bash('git rebase -i main')],
    ['--no-verify', () => bash('git commit --no-verify -m x')],
    ['a push elsewhere', () => bash('git push origin main', other)],
  ];

  for (const [label, payloadOf, arrange = async () => {}] of FIXTURES) {
    test(label, async () => {
      await arrange();
      const direct = carried(await handle(payloadOf()));

      await gate.revokeAll({ home });
      await arrange();
      const through = carried(await invoke('pre-bash', payloadOf(), { root: ROOT }));

      assert.deepEqual(through, direct);
    });
  }
});

// The same for the ownership check: owns.js imported, and the same payload
// through bin/pdkit, on each of its outcomes.
describe('invoke agrees with handle, for pre-write', () => {
  let home;
  let repo;
  let outside;
  let previousHome;

  before(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-runner-owns-home-')));
    previousHome = process.env.PDKIT_HOME;
    process.env.PDKIT_HOME = home;
    repo = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-runner-owns-repo-')));
    outside = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-runner-owns-out-')));
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    await mkdir(join(repo, 'src'), { recursive: true });
    await setOwns(3001, 'T1', ['src/owned.ts'], { home });
    await setOwns(3001, 'T8', [], { home });
    await setOwns(3001, 'T2', ['src/owned.ts'], { home });
    await withdrawTask(3001, { task: 'T2', amendment: 'A1', replacedBy: ['T5'], home });
  });

  after(async () => {
    await stop({ worktree: repo, home });
    if (previousHome === undefined) delete process.env.PDKIT_HOME;
    else process.env.PDKIT_HOME = previousHome;
    for (const dir of [home, repo, outside]) await rm(dir, { recursive: true, force: true });
  });

  const write = (file, tool = 'Write') => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: file }, cwd: repo });

  /** What the decision says, as far as the process protocol carries it. */
  const carried = (decision) => ({ block: decision.block, reason: decision.reason, message: decision.message });

  /** A task running in the repository, or none. */
  const task = (issue, taskId) => async () => {
    await stop({ worktree: repo, home });
    if (taskId) await start({ issue, taskId, worktree: repo, home });
  };

  const FIXTURES = [
    ['a file the task owns', () => write(join(repo, 'src/owned.ts')), task(3001, 'T1')],
    ['a file it does not own', () => write(join(repo, 'src/other.ts')), task(3001, 'T1')],
    ['an edit of a file it does not own', () => write(join(repo, 'src/other.ts'), 'Edit'), task(3001, 'T1')],
    ['a relative path, from cwd', () => write('src/other.ts'), task(3001, 'T1')],
    ['a file outside the tree', () => write(join(outside, 'notes.md')), task(3001, 'T1')],
    ['a task that owns nothing', () => write(join(repo, 'src/owned.ts')), task(3001, 'T8')],
    ['a task with no Owns recorded', () => write(join(repo, 'src/other.ts')), task(4242, 'T9')],
    ['a withdrawn task', () => write(join(repo, 'src/owned.ts')), task(3001, 'T2')],
    ['no task running', () => write(join(repo, 'src/other.ts')), task()],
    ['no file', () => ({ ...write(''), tool_input: {} }), task(3001, 'T1')],
  ];

  for (const [label, payloadOf, arrange] of FIXTURES) {
    test(label, async () => {
      await arrange();
      const direct = carried(await handleOwns(payloadOf(), { event: 'pre-write', pluginRoot: ROOT }));
      const through = carried(await invoke('pre-write', payloadOf(), { root: ROOT }));

      assert.deepEqual(through, direct);
    });
  }

  test('the fixtures cover every outcome: a refusal, a pass, and a pass with a message', async () => {
    const outcomes = new Set();
    for (const [, payloadOf, arrange] of FIXTURES) {
      await arrange();
      const decision = await handleOwns(payloadOf(), { event: 'pre-write', pluginRoot: ROOT });
      outcomes.add(decision.block ? 'refuse' : decision.message ? 'message' : 'pass');
    }
    assert.deepEqual([...outcomes].sort(), ['message', 'pass', 'refuse']);
  });
});

// The same for post-write: post-write.js imported, and the same payload through
// bin/pdkit, on each of its outcomes — exit 2 with the header to insert, the
// reminder that runHook sends as additionalContext after a tool, and silence.
describe('invoke agrees with handle, for post-write', () => {
  let home;
  let repo;
  let other;
  let previousHome;

  before(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-runner-post-home-')));
    previousHome = process.env.PDKIT_HOME;
    process.env.PDKIT_HOME = home;
    // The clone the configuration names: post-write says nothing anywhere else.
    await writeFile(join(home, 'config.yaml'), 'repo:\n  fork: someone/podman-desktop\n');
    repo = await realpath(await podmanDesktopClone('pdkit-runner-post-repo-'));
    await execFileAsync('git', ['remote', 'add', 'origin', 'git@github.com:someone/podman-desktop.git'], { cwd: repo });
    other = await realpath(await otherRepository('pdkit-runner-post-other-'));
    for (const dir of [repo, other]) {
      await mkdir(join(dir, 'src', 'schemas'), { recursive: true });
      await writeFile(join(dir, 'src', 'bare.ts'), 'export {};\n');
    }
    await writeFile(join(repo, 'src', 'headed.ts'), `${spdxHeader()}\nexport {};\n`);
    await writeFile(join(repo, 'src', 'schemas', 'settings.ts'), 'export {};\n');
    await writeFile(join(repo, 'src', 'notes.md'), '# x\n');
  });

  after(async () => {
    if (previousHome === undefined) delete process.env.PDKIT_HOME;
    else process.env.PDKIT_HOME = previousHome;
    for (const dir of [home, repo, other]) await rm(dir, { recursive: true, force: true });
  });

  const wrote = (file, tool = 'Write') => ({ hook_event_name: 'PostToolUse', tool_name: tool, tool_input: { file_path: file }, cwd: dirname(file) });

  /**
   * What the decision says, as far as the process protocol carries it. A
   * reason travels on stderr up to its trailing whitespace — runHook ends it
   * with a newline, decide trims the end — and the header to insert ends with
   * one of its own.
   */
  const carried = (decision) => ({ block: decision.block, reason: decision.reason?.trimEnd(), message: decision.message });

  const FIXTURES = [
    ['a source file without the header', () => wrote(join(repo, 'src/bare.ts'))],
    ['an edit of one', () => wrote(join(repo, 'src/bare.ts'), 'Edit')],
    ['a source file with the header', () => wrote(join(repo, 'src/headed.ts'))],
    ['a schema source', () => wrote(join(repo, 'src/schemas/settings.ts'))],
    ['a file neither check is for', () => wrote(join(repo, 'src/notes.md'))],
    ['a source file in another repository', () => wrote(join(other, 'src/bare.ts'))],
    ['a file that is not there', () => wrote(join(repo, 'src/gone.ts'))],
    ['no file', () => ({ ...wrote(join(repo, 'src/bare.ts')), tool_input: {} })],
  ];

  for (const [label, payloadOf] of FIXTURES) {
    test(label, async () => {
      const direct = carried(await handlePostWrite(payloadOf(), { event: 'post-write', pluginRoot: ROOT }));
      const through = carried(await invoke('post-write', payloadOf(), { root: ROOT }));

      assert.deepEqual(through, direct);
    });
  }

  test('the fixtures cover every outcome: a refusal, a pass, and a pass with a message', async () => {
    const outcomes = new Set();
    for (const [, payloadOf] of FIXTURES) {
      const decision = await handlePostWrite(payloadOf(), { event: 'post-write', pluginRoot: ROOT });
      outcomes.add(decision.block ? 'refuse' : decision.message ? 'message' : 'pass');
    }
    assert.deepEqual([...outcomes].sort(), ['message', 'pass', 'refuse']);
  });
});

// The same for post-claim: post-claim.js imported, and the same payload through
// bin/pdkit, on each of its outcomes — the reminder that runHook sends as
// additionalContext after a tool, and silence. It never refuses.
describe('invoke agrees with handle, for post-claim', () => {
  let home;
  let repo;
  let other;
  let previousHome;

  before(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-runner-claim-home-')));
    previousHome = process.env.PDKIT_HOME;
    process.env.PDKIT_HOME = home;
    // The clone the configuration names: post-claim searches no other.
    await writeFile(join(home, 'config.yaml'), 'repo:\n  fork: someone/podman-desktop\n');
    repo = await realpath(await podmanDesktopClone('pdkit-runner-claim-repo-'));
    await execFileAsync('git', ['remote', 'add', 'origin', 'git@github.com:someone/podman-desktop.git'], { cwd: repo });
    other = await realpath(await otherRepository('pdkit-runner-claim-other-'));
    // The local name is there; the borrowed one is only in the document that
    // proposes it, which the search leaves out (post-claim.test.js).
    await mkdir(join(repo, 'docs'), { recursive: true });
    await writeFile(join(repo, 'api.d.ts'), 'export namespace env {\n  export const urlProtocol: string;\n}\n');
    await writeFile(join(repo, 'docs', 'design.md'), 'Add `env.uriScheme` here.\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
  });

  after(async () => {
    if (previousHome === undefined) delete process.env.PDKIT_HOME;
    else process.env.PDKIT_HOME = previousHome;
    for (const dir of [home, repo, other]) await rm(dir, { recursive: true, force: true });
  });

  const wrote = (file, content, cwd = repo) => ({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: file, content }, cwd });

  /**
   * What the decision says, as far as the process protocol carries it. The
   * reminder names the rule under the plugin's root as runHook passes it
   * (PLUGIN_ROOT), which is what the direct call is given too.
   */
  const carried = (decision) => ({ block: decision.block, reason: decision.reason, message: decision.message });

  const FIXTURES = [
    ['a proposed member that matches nothing outside the document', () => wrote(join(repo, 'docs/design.md'), 'Add `env.uriScheme` here.')],
    ['a name said to be missing that is there', () => wrote(join(repo, 'docs/notes.md'), 'There is no `urlProtocol` yet.')],
    ['the new text of an edit', () => ({ ...wrote(join(repo, 'docs/notes.md')), tool_name: 'Edit', tool_input: { file_path: join(repo, 'docs/notes.md'), old_string: 'x', new_string: 'Do we need `env.uriScheme`?' } })],
    ['a claim that names its search', () => wrote(join(repo, 'docs/design.md'), 'Add `env.uriScheme`; searched: git grep -i "scheme|protocol" -- api -> 0.')],
    ['a search that names nothing', () => wrote(join(repo, 'docs/design.md'), 'The API has no `uriScheme`; searched: yes.')],
    ['not markdown', () => wrote(join(repo, 'docs/a.ts'), 'Add `env.uriScheme` here.')],
    ['outside podman-desktop', () => wrote(join(other, 'design.md'), 'Add `env.uriScheme` here.', other)],
    ['a session in a subdirectory', () => wrote(join(repo, 'docs/design.md'), 'Add `env.uriScheme` here.', join(repo, 'docs'))],
    ['no file', () => ({ ...wrote(join(repo, 'docs/design.md'), 'Add `env.uriScheme` here.'), tool_input: {} })],
  ];

  for (const [label, payloadOf] of FIXTURES) {
    test(label, async () => {
      const direct = carried(await handlePostClaim(payloadOf(), { event: 'post-claim', pluginRoot: PLUGIN_ROOT }));
      const through = carried(await invoke('post-claim', payloadOf(), { root: ROOT }));

      assert.deepEqual(through, direct);
    });
  }

  test('the fixtures cover every outcome: a pass, and a pass with a message', async () => {
    const outcomes = new Set();
    for (const [, payloadOf] of FIXTURES) {
      const decision = await handlePostClaim(payloadOf(), { event: 'post-claim', pluginRoot: PLUGIN_ROOT });
      outcomes.add(decision.block ? 'refuse' : decision.message ? 'message' : 'pass');
    }
    assert.deepEqual([...outcomes].sort(), ['message', 'pass']);
  });
});

// The same for post-bash: post-bash.js imported, and the same payload through
// bin/pdkit, on each of its outcomes — the rule that runHook sends as
// additionalContext after a tool, and silence. It never refuses, and reads no
// repository: the work directory is any directory.
describe('invoke agrees with handle, for post-bash', () => {
  /** A namespace a window cut before its brace, and the same one read to it (post-bash.test.js). */
  const CUT = ['4522:  export namespace env {', '4526-    export const appName: string;', '4579-    export function createTelemetryLogger(): TelemetryLogger;'].join('\n');
  const WHOLE = `${CUT}\n4590-    export const urlProtocol: string;\n4591-  }`;

  const ran = (command, stdout) => ({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout }, cwd: work });

  /** What the decision says, as far as the process protocol carries it; the rule is named under PLUGIN_ROOT, as runHook passes it. */
  const carried = (decision) => ({ block: decision.block, reason: decision.reason, message: decision.message });

  const FIXTURES = [
    ['a context grep that stopped inside a block', () => ran('grep -n "namespace env" -A60 api.d.ts', CUT)],
    ['a sed range, the same', () => ran('sed -n 1555,1600p loader.ts', CUT)],
    ['head of a file printed by cat', () => ran('cat api.d.ts | head -100', CUT)],
    ['several windows in one command', () => ran('head -40 a.ts; tail -20 b.ts', CUT)],
    ['the window reached the closing brace', () => ran('grep -n "namespace env" -A70 api.d.ts', WHOLE)],
    ['no window, however open the output', () => ran('cat api.d.ts', CUT)],
    ['head trimming a list of matches', () => ran('grep -n "start() {" loader.ts | head -15', CUT)],
    ['a log followed', () => ran('tail -f app.log', CUT)],
    ['another tool', () => ({ ...ran('head -40 a.ts', CUT), tool_name: 'Read' })],
    ['no command', () => ({ ...ran('', CUT), tool_input: {} })],
  ];

  for (const [label, payloadOf] of FIXTURES) {
    test(label, async () => {
      const direct = carried(await handlePostBash(payloadOf(), { event: 'post-bash', pluginRoot: PLUGIN_ROOT }));
      const through = carried(await invoke('post-bash', payloadOf(), { root: ROOT }));

      assert.deepEqual(through, direct);
    });
  }

  test('the fixtures cover every outcome: a pass, and a pass with a message', async () => {
    const outcomes = new Set();
    for (const [, payloadOf] of FIXTURES) {
      const decision = await handlePostBash(payloadOf(), { event: 'post-bash', pluginRoot: PLUGIN_ROOT });
      outcomes.add(decision.block ? 'refuse' : decision.message ? 'message' : 'pass');
    }
    assert.deepEqual([...outcomes].sort(), ['message', 'pass']);
  });
});

// The same for post-read: post-read.js imported, and the same payload through
// bin/pdkit, on each of its outcomes — the rule that runHook sends as
// additionalContext after a tool, and silence. It never refuses, and reads no
// repository. The fixtures are post-read.test.js's: Claude Code's Read and
// Grep responses, the shapes the bridge builds.
describe('invoke agrees with handle, for post-read', () => {
  /** A namespace cut before its last member and its brace, and the same one read to it (post-read.test.js). */
  const CUT = ['  export namespace env {', '    export const appName: string;'].join('\n');
  const WHOLE = `${CUT}\n    export const urlProtocol: string;\n  }`;

  const read = (file) => ({
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_input: { file_path: join(work, 'api.d.ts') },
    tool_response: { type: 'text', file: { filePath: join(work, 'api.d.ts'), ...file } },
    cwd: work,
  });
  const grep = (input, response) => ({
    hook_event_name: 'PostToolUse',
    tool_name: 'Grep',
    tool_input: { pattern: 'namespace env', ...input },
    tool_response: { mode: 'content', ...response },
    cwd: work,
  });

  /** What the decision says, as far as the process protocol carries it; the rule is named under PLUGIN_ROOT, as runHook passes it. */
  const carried = (decision) => ({ block: decision.block, reason: decision.reason, message: decision.message });

  const FIXTURES = [
    ['a page that stopped inside a block', () => read({ content: CUT, startLine: 1, numLines: 2000, totalLines: 4700 })],
    ['a page inside the file, the same', () => read({ content: CUT, startLine: 4500, numLines: 2, totalLines: 4700 })],
    ['a whole file cut by a cap', () => read({ content: CUT, startLine: 1, numLines: 2, totalLines: 2, truncatedByTokenCap: true })],
    ['a page that closed its block', () => read({ content: WHOLE, startLine: 4500, numLines: 4, totalLines: 4700 })],
    ['a whole file, however open', () => read({ content: CUT, startLine: 1, numLines: 2, totalLines: 2 })],
    ['matches cut at a limit, inside a block', () => grep({}, { content: CUT, appliedLimit: 100 })],
    ['matches with context', () => grep({ '-A': 60 }, { content: CUT })],
    ['every match', () => grep({}, { content: CUT })],
    ['a search outside content mode', () => grep({ output_mode: 'files_with_matches' }, { mode: 'files_with_matches', filenames: ['a'] })],
    ['another tool', () => ({ ...read({ content: CUT, startLine: 1, numLines: 2000, totalLines: 4700 }), tool_name: 'Bash' })],
  ];

  for (const [label, payloadOf] of FIXTURES) {
    test(label, async () => {
      const direct = carried(await handlePostRead(payloadOf(), { event: 'post-read', pluginRoot: PLUGIN_ROOT }));
      const through = carried(await invoke('post-read', payloadOf(), { root: ROOT }));

      assert.deepEqual(through, direct);
    });
  }

  test('the fixtures cover every outcome: a pass, and a pass with a message', async () => {
    const outcomes = new Set();
    for (const [, payloadOf] of FIXTURES) {
      const decision = await handlePostRead(payloadOf(), { event: 'post-read', pluginRoot: PLUGIN_ROOT });
      outcomes.add(decision.block ? 'refuse' : decision.message ? 'message' : 'pass');
    }
    assert.deepEqual([...outcomes].sort(), ['message', 'pass']);
  });
});

// The same for subagent-stop: task-completed.js imported, and the same payload
// through bin/pdkit, on each of its outcomes — exit 2 with the reason that
// holds the subagent, the message runHook writes to stdout as it lets one go,
// and silence. Every call is a stop the handler counts, and the stall limit
// counts a run's stops: so the run handed to handle() and the one handed to
// invoke() are two, each with the same stops before it. The task is arranged
// once for both: the text at the ceiling names when its count started.
describe('invoke agrees with handle, for subagent-stop', () => {
  const ISSUE = 18248;
  let home;
  let repo;
  let previousHome;

  before(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-runner-stop-home-')));
    previousHome = process.env.PDKIT_HOME;
    process.env.PDKIT_HOME = home;
    repo = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-runner-stop-repo-')));
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    await transition(ISSUE, 'triaged', { home });
    await setOwns(ISSUE, 'T1', ['src/owned.ts'], { home });
  });

  after(async () => {
    await stop({ worktree: repo, home });
    if (previousHome === undefined) delete process.env.PDKIT_HOME;
    else process.env.PDKIT_HOME = previousHome;
    for (const dir of [home, repo]) await rm(dir, { recursive: true, force: true });
  });

  const receipt = () => join(issueDir(home, ISSUE), 'receipts', 'T1.md');
  const captured = (exitCode) => ({ command: 'pnpm test', exitCode, stdout: 'ok\n', stderr: '', durationMs: 10, at: '2026-07-31T10:00:00.000Z', complete: true });

  /** The payload Open Code's bridge builds (opencode/bridge/payload.js), for a run. */
  const stopped = (agentId, fields = {}) => ({
    hook_event_name: 'SubagentStop',
    agent_id: agentId,
    agent_type: 'pd-implementer',
    session_id: 'ses_person',
    cwd: repo,
    stop_hook_active: false,
    ...fields,
  });

  /** What the decision says, as far as the process protocol carries it. */
  const carried = (decision) => ({ block: decision.block, reason: decision.reason, message: decision.message });

  /** The tree's task, its receipt and its attempts, from scratch: `exitCode` null for no receipt. */
  const task = ({ exitCode = null, failed = 0, edited = false, running = true } = {}) => async () => {
    await stop({ worktree: repo, home });
    await rm(receipt(), { force: true });
    await unblockTask({ issue: ISSUE, taskId: 'T1', reason: 'a fixture of its own', home });
    if (exitCode !== null) await writeReceipt({ issue: ISSUE, taskId: 'T1', run: captured(exitCode), home });
    if (edited) await writeFile(receipt(), (await readFile(receipt(), 'utf8')).replace('ok', 'fine'));
    for (let i = 0; i < failed; i += 1) await recordAttempt({ issue: ISSUE, taskId: 'T1', exitCode: 1, home });
    if (running) await start({ issue: ISSUE, taskId: 'T1', worktree: repo, session: 'ses_person', home });
  };

  /** Stops of a run before the one compared, with nothing captured between. */
  const stalled = (count) => async (agentId) => {
    for (let i = 0; i < count; i += 1) await handleSubagentStop(stopped(agentId), { event: 'subagent-stop', pluginRoot: ROOT });
  };

  const FIXTURES = [
    ['no receipt', (id) => stopped(id), task()],
    ['an edited receipt', (id) => stopped(id), task({ exitCode: 0, edited: true })],
    ['a receipt of a failed command', (id) => stopped(id), task({ exitCode: 1 })],
    ['a receipt that passes', (id) => stopped(id), task({ exitCode: 0 })],
    ['the third stop with nothing captured', (id) => stopped(id), task(), stalled(2)],
    ['the fourth', (id) => stopped(id), task(), stalled(3)],
    ['the attempts ceiling', (id) => stopped(id), task({ exitCode: 1, failed: 3 })],
    ['the ceiling, already told', (id) => stopped(id, { stop_hook_active: true }), task({ exitCode: 1, failed: 3 })],
    ['another agent', (id) => stopped(id, { agent_type: 'pd-scout' }), task()],
    ["an agent the host does not name", (id) => stopped(id, { agent_type: undefined }), task()],
    ["another session's agent", (id) => stopped(id, { session_id: 'ses_elsewhere' }), task()],
    ['no task running', (id) => stopped(id), task({ running: false })],
  ];

  let runs = 0;
  for (const [label, payloadOf, arrange, before = async () => {}] of FIXTURES) {
    test(label, async () => {
      const direct = `ses_direct${(runs += 1)}`;
      await arrange();
      await before(direct);
      const expected = carried(await handleSubagentStop(payloadOf(direct), { event: 'subagent-stop', pluginRoot: ROOT }));

      const through = `ses_through${runs}`;
      await before(through);
      const actual = carried(await invoke('subagent-stop', payloadOf(through), { root: ROOT }));

      assert.deepEqual(actual, expected);
    });
  }

  test('the fixtures cover every outcome: a hold, a pass, and a pass with a message', async () => {
    const outcomes = new Set();
    for (const [, payloadOf, arrange, before = async () => {}] of FIXTURES) {
      const id = `ses_cover${(runs += 1)}`;
      await arrange();
      await before(id);
      const decision = await handleSubagentStop(payloadOf(id), { event: 'subagent-stop', pluginRoot: ROOT });
      outcomes.add(decision.block ? 'refuse' : decision.message ? 'message' : 'pass');
    }
    assert.deepEqual([...outcomes].sort(), ['message', 'pass', 'refuse']);
  });
});

// The same for session-start: session-start.js imported, and the same payload
// through bin/pdkit, on each of its outcomes — a summary of a task running, of
// a blocked one, of an issue between phases, the way out of the main
// checkout, and silence — and for each reason the bridge runs it.
describe('invoke agrees with handle, for session-start', () => {
  const ISSUE = 18248;
  const BRANCH_OF_ISSUE = `DESKTOP-${ISSUE}/join-container-command`;
  let home;
  let repo;
  let linked;
  let previousHome;
  const git = (cwd, ...args) => execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd });

  before(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-runner-start-home-')));
    previousHome = process.env.PDKIT_HOME;
    process.env.PDKIT_HOME = home;
    repo = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-runner-start-repo-')));
    await git(repo, 'init', '-q', '-b', 'main');
    await git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    linked = join(await realpath(tmpdir()), `pdkit-runner-start-linked-${process.pid}`, 'issue-tree');
    await git(repo, 'worktree', 'add', '-q', '-b', BRANCH_OF_ISSUE, linked);
    await transition(ISSUE, 'triaged', { home });
    await setOwns(ISSUE, 'T1', ['src/owned.ts'], { home });
    await mkdir(join(issueDir(home, ISSUE), 'tasks'), { recursive: true });
    await writeFile(join(issueDir(home, ISSUE), 'tasks', 'T1.md'), '# T1: join the command arguments\n\n- Issue: 18248\n');
  });

  after(async () => {
    await stop({ worktree: repo, home });
    if (previousHome === undefined) delete process.env.PDKIT_HOME;
    else process.env.PDKIT_HOME = previousHome;
    await git(repo, 'worktree', 'remove', '--force', linked);
    for (const dir of [home, repo, dirname(linked)]) await rm(dir, { recursive: true, force: true });
  });

  /** The payload Open Code's bridge builds (opencode/bridge/payload.js), for a session in `cwd`. */
  const started = (cwd, source = 'startup') => ({ hook_event_name: 'SessionStart', source, session_id: 'ses_person', cwd });

  /** What the decision says, as far as the process protocol carries it. */
  const carried = (decision) => ({ block: decision.block, reason: decision.reason, message: decision.message });

  /** The tree's task and its attempts, from scratch, and the main checkout on `head`. */
  const tree = ({ running = true, failed = 0, head = 'main' } = {}) => async () => {
    await stop({ worktree: repo, home });
    await unblockTask({ issue: ISSUE, taskId: 'T1', reason: 'a fixture of its own', home });
    for (let i = 0; i < failed; i += 1) await recordAttempt({ issue: ISSUE, taskId: 'T1', exitCode: 1, home });
    if (running) await start({ issue: ISSUE, taskId: 'T1', worktree: repo, session: 'ses_person', home });
    await git(repo, 'symbolic-ref', 'HEAD', `refs/heads/${head}`);
  };

  const FIXTURES = [
    ['a task running', () => started(repo), tree()],
    ['a blocked task', () => started(repo), tree({ failed: 3 })],
    ['between phases, in the issue tree', () => started(linked), tree({ running: false })],
    ["the main checkout on the issue's branch", () => started(repo), tree({ running: false, head: BRANCH_OF_ISSUE })],
    ['silence: no task, and no issue named by the branch', () => started(repo), tree({ running: false })],
    ['a fork', () => started(repo, 'resume'), tree()],
    ['after a compaction', () => started(repo, 'compact'), tree()],
  ];

  for (const [label, payloadOf, arrange] of FIXTURES) {
    test(label, async () => {
      await arrange();
      const expected = carried(await handleSessionStart(payloadOf(), { event: 'session-start', pluginRoot: ROOT }));
      const actual = carried(await invoke('session-start', payloadOf(), { root: ROOT }));

      assert.deepEqual(actual, expected);
    });
  }

  test('the fixtures cover every outcome: a summary, and silence', async () => {
    const outcomes = new Set();
    for (const [, payloadOf, arrange] of FIXTURES) {
      await arrange();
      const decision = await handleSessionStart(payloadOf(), { event: 'session-start', pluginRoot: ROOT });
      outcomes.add(decision.block ? 'refuse' : decision.message ? 'message' : 'pass');
    }
    await git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    assert.deepEqual([...outcomes].sort(), ['message', 'pass']);
  });
});

// The same for pre-compact, whose work is not its decision but the journal
// entry it writes: session-start.js imported, and the same payload through
// bin/pdkit, each writing what it writes — the task, the state, the route,
// or nothing.
describe('invoke agrees with handle, for pre-compact', () => {
  const ISSUE = 18249;
  let home;
  let repo;
  let previousHome;
  const git = (cwd, ...args) => execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd });

  before(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-runner-compact-home-')));
    previousHome = process.env.PDKIT_HOME;
    process.env.PDKIT_HOME = home;
    repo = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-runner-compact-repo-')));
    await git(repo, 'init', '-q', '-b', 'main');
    await git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  });

  after(async () => {
    await stop({ worktree: repo, home });
    if (previousHome === undefined) delete process.env.PDKIT_HOME;
    else process.env.PDKIT_HOME = previousHome;
    for (const dir of [home, repo]) await rm(dir, { recursive: true, force: true });
  });

  /** The payload Open Code's bridge builds (opencode/bridge/payload.js), for a compaction in the repository. */
  const compacting = () => ({ hook_event_name: 'PreCompact', session_id: 'ses_person', cwd: repo });

  /** What the decision says, as far as the process protocol carries it. */
  const carried = (decision) => ({ block: decision.block, reason: decision.reason, message: decision.message });

  /** The `compact` entries a call wrote, without the time they were written at. */
  const writtenBy = async (call) => {
    const before = (await readJournal({ event: 'compact' }, { home })).length;
    const decision = await call();
    const written = (await readJournal({ event: 'compact' }, { home })).slice(before).map(({ issue, event, detail }) => ({ issue, event, detail }));
    return { decision: carried(decision), written };
  };

  /** The issue in `state` on `route`, with its task running in the repository or not. */
  const issue = ({ state = 'triaged', route, running = true } = {}) => async () => {
    await stop({ worktree: repo, home });
    await rm(issueDir(home, ISSUE), { recursive: true, force: true });
    await transition(ISSUE, 'triaged', { home, ...(route ? { route } : {}) });
    if (state !== 'triaged') await transition(ISSUE, state, { home });
    if (running) await start({ issue: ISSUE, taskId: 'T1', worktree: repo, session: 'ses_person', home });
  };

  const FIXTURES = [
    ['a task running, the issue on no route yet', issue()],
    ['a task running, the issue on a route', issue({ route: 'standard' })],
    ['no task running', issue({ running: false })],
  ];

  for (const [label, arrange] of FIXTURES) {
    test(label, async () => {
      await arrange();
      const expected = await writtenBy(() => handleSessionStart(compacting(), { event: 'pre-compact', pluginRoot: ROOT }));
      await arrange();
      const actual = await writtenBy(() => invoke('pre-compact', compacting(), { root: ROOT }));

      assert.deepEqual(actual, expected);
    });
  }

  test('the fixtures cover every outcome: an entry, and none', async () => {
    const outcomes = new Set();
    for (const [, arrange] of FIXTURES) {
      await arrange();
      const { decision, written } = await writtenBy(() => handleSessionStart(compacting(), { event: 'pre-compact', pluginRoot: ROOT }));
      assert.deepEqual(decision, { block: false, reason: undefined, message: undefined });
      outcomes.add(written.length === 0 ? 'none' : written.map(({ detail }) => detail).join());
    }
    assert.deepEqual([...outcomes].sort(), ['T1 active, issue triaged', 'T1 active, issue triaged (standard)', 'none']);
  });
});

// The same for prompt-submit, on the payload the bridge builds from a pdkit
// command's label (opencode/bridge/payload.js): the command as typed, in the
// session's directory. Its fixtures are the tree question's outcomes —
// another issue's tree, no tree yet for the code, the issue's own tree, an
// issue nothing names — and a prompt that is no command at all.
describe('invoke agrees with handle, for prompt-submit', () => {
  const HERE = 4201;
  const AWAY = 4202;
  let home;
  let base;
  let main;
  let away;
  let fresh;
  let previousHome;
  const git = (cwd, ...args) => execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd });

  before(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-runner-prompt-home-')));
    previousHome = process.env.PDKIT_HOME;
    process.env.PDKIT_HOME = home;
    base = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-runner-prompt-repo-')));
    main = join(base, 'podman-desktop');
    away = join(base, `DESKTOP-${AWAY}`);
    fresh = join(base, 'fresh-clone');
    for (const dir of [main, fresh]) {
      await mkdir(dir);
      await git(dir, 'init', '-q', '-b', 'main');
      await git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
    }
    await git(main, 'switch', '-q', '-c', `DESKTOP-${HERE}/1-reconnect-the-event-stream`);
    await git(main, 'worktree', 'add', '-q', '-b', `DESKTOP-${AWAY}/1-quit-and-install`, away, 'main');
    await transition(AWAY, 'triaged', { home });
  });

  after(async () => {
    if (previousHome === undefined) delete process.env.PDKIT_HOME;
    else process.env.PDKIT_HOME = previousHome;
    for (const dir of [home, base]) await rm(dir, { recursive: true, force: true });
  });

  /** The payload Open Code's bridge builds (opencode/bridge/payload.js), for a command sent in `cwd`. */
  const submitted = (prompt, cwd) => ({ hook_event_name: 'UserPromptSubmit', prompt, session_id: 'ses_person', cwd });

  /** What the decision says, as far as the process protocol carries it. */
  const carried = (decision) => ({ block: decision.block, reason: decision.reason, message: decision.message, notice: decision.notice });

  const FIXTURES = [
    ["another issue's tree", () => submitted(`/pd:preflight ${AWAY}`, main)],
    ['code to write, and no tree for it yet', () => submitted('/pd:exec 4203', fresh)],
    ["the issue's own tree", () => submitted(`/pd:preflight ${AWAY}`, away)],
    ['an issue nothing names yet', () => submitted('/pd:triage 4204', main)],
    ['no pdkit command', () => submitted('what is left to do?', main)],
  ];

  for (const [label, payloadOf] of FIXTURES) {
    test(label, async () => {
      const expected = carried(await handlePromptSubmit(payloadOf(), { event: 'prompt-submit', pluginRoot: ROOT, env: {} }));
      const actual = carried(await invoke('prompt-submit', payloadOf(), { root: ROOT }));

      assert.deepEqual(actual, expected);
    });
  }

  test('the fixtures cover every outcome: a message, and silence', async () => {
    const outcomes = new Set();
    for (const [, payloadOf] of FIXTURES) {
      const decision = await handlePromptSubmit(payloadOf(), { event: 'prompt-submit', pluginRoot: ROOT, env: {} });
      outcomes.add(decision.block ? 'refuse' : decision.notice ? 'notice' : decision.message ? 'message' : 'pass');
    }
    assert.deepEqual([...outcomes].sort(), ['message', 'pass']);
  });
});

// The refusal for a handler that cannot run is written twice — in runHook, for
// the child that finds out, and here, for the host that finds out instead —
// and the person must not be able to tell which one spoke.
describe("a refusal for want of an answer reads like runHook's", () => {
  let plugin;

  before(async () => {
    plugin = await mkdtemp(join(tmpdir(), 'pdkit-runner-plugin-'));
    for (const entry of ['bin', 'lib', 'defaults', 'package.json']) {
      await cp(join(ROOT, entry), join(plugin, entry), { recursive: true });
    }
  });

  after(async () => {
    await rm(plugin, { recursive: true, force: true });
  });

  test('a handler that does not load: runHook refuses, and the advice is the same word for word', async () => {
    const file = join(plugin, 'lib', 'hooks', 'dispatch.js');
    const original = await readFile(file, 'utf8');
    await writeFile(file, 'this is not valid javascript {{{\n');

    try {
      const outcome = await run('pre-bash', payload(), { root: plugin });

      assert.equal(outcome.code, 2, 'runHook refuses a handler that does not load');
      assert.match(outcome.stderr, /^pdkit: hook "pre-bash" handler "dispatch\.js" is unavailable/);
      assert.equal(outcome.stderr.trimEnd().slice(-ADVICE.length), ADVICE);
      assert.equal(decide('pre-bash', outcome).reason, outcome.stderr.trimEnd());
    } finally {
      await writeFile(file, original);
    }
  });

  test('a CLI that does not load: no runHook to refuse, so this module does, with the same advice', async () => {
    const file = join(plugin, 'lib', 'cli.js');
    const original = await readFile(file, 'utf8');
    await writeFile(file, 'this is not valid javascript {{{\n');

    try {
      const decision = await invoke('pre-bash', payload(), { root: plugin });

      assert.equal(decision.block, true);
      assert.match(decision.undecided, /^exited with code 1 \(SyntaxError: .*; Node\.js v\d+/);
      assert.ok(decision.reason.endsWith(ADVICE));
    } finally {
      await writeFile(file, original);
    }
  });
});
