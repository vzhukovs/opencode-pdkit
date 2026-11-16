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
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEADLINE_MS, childEnv, decide, invoke, refusal, run } from '../lib/hooks/runner.js';
import { FAIL_CLOSED } from '../lib/hooks/events.js';
import { handle } from '../lib/hooks/dispatch.js';
import * as gate from '../lib/gate.js';
import { BRANCH, otherRepository, podmanDesktopClone, readyIssue } from './helpers/gate-fixture.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
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
