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

// session-start in Open Code, end to end short of the host: the callbacks a
// stand-in for setup()'s context collects — the prompt hook, the fork hook,
// the stream of compactions — called as Open Code calls them, with sessions
// shaped as Open Code records them (F54, F270). Behind them is everything
// real — the bridge, the runner, a node process running bin/pdkit,
// session-start.js, the gate's tokens — in a repository with a task running,
// against a throwaway $PDKIT_HOME.
//
// Claude Code put what the handler printed in the session's context. Here the
// summary is the session's instruction entry (F69), so each rule of
// docs/specification/06-hooks.md for session-start is asserted as the entries
// put or withdrawn — the handler's own words, or none — and the tokens left.
// Then when it runs: a session's first prompt, a fork, a compaction, and
// nothing else. Then the other half: whatever fails leaves the entry as it
// was, lets the prompt through, and says why.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import plugin from '../opencode/server.js';
import { createBridge } from '../opencode/bridge/hooks.js';
import { start, stop as stopTask } from '../lib/active.js';
import { record as recordAttempt, unblock as unblockTask } from '../lib/attempts.js';
import { issueDir, paths } from '../lib/config.js';
import { handle } from '../lib/hooks/session-start.js';
import { setOwns, transition } from '../lib/state.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const POSIX = process.platform !== 'win32';
const execFileAsync = promisify(execFile);

const ISSUE = 18248;

/** The key the bridge keeps the summary under: the plugin's ID. */
const KEY = 'opencode-pdkit';

/** The session a person drives, which started the task. */
const PERSON = 'ses_person';

let home;
let repo;
let linked;
let previousHome;

const git = (cwd, ...args) => execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd });

before(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-session-start-home-')));
  // The child process takes $PDKIT_HOME from the server's environment, as it
  // would in a session; here the server is this process.
  previousHome = process.env.PDKIT_HOME;
  process.env.PDKIT_HOME = home;
  repo = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-session-start-repo-')));
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  // Between phases a session stands in the issue's tree, not the main checkout.
  linked = join(await realpath(tmpdir()), `pdkit-session-start-linked-${process.pid}`, 'issue-tree');
  await git(repo, 'worktree', 'add', '-q', '-b', `DESKTOP-${ISSUE}/join-container-command`, linked);
  await transition(ISSUE, 'triaged', { home });
  await setOwns(ISSUE, 'T1', ['packages/main/src/plugin/container-registry.ts'], { home });
  await mkdir(join(issueDir(home, ISSUE), 'tasks'), { recursive: true });
  await writeFile(join(issueDir(home, ISSUE), 'tasks', 'T1.md'), '# T1: join the command arguments\n\n- Issue: 18248\n- Satisfies: R1\n');
});

beforeEach(async () => {
  await rm(join(home, 'config.yaml'), { force: true });
  await rm(paths(home).gates, { recursive: true, force: true });
  await unblockTask({ issue: ISSUE, taskId: 'T1', reason: 'a test of its own', home });
  await start({ issue: ISSUE, taskId: 'T1', worktree: repo, session: PERSON, home });
});

after(async () => {
  if (previousHome === undefined) delete process.env.PDKIT_HOME;
  else process.env.PDKIT_HOME = previousHome;
  await git(repo, 'worktree', 'remove', '--force', linked);
  for (const dir of [home, repo, dirname(linked)]) await rm(dir, { recursive: true, force: true });
});

/** Consent tokens, as `pdkit gate open` leaves them: two outstanding. */
async function tokens() {
  await mkdir(paths(home).gates, { recursive: true });
  for (const name of ['DESKTOP-18248__1-one', 'pr-1234']) {
    await writeFile(join(paths(home).gates, `${name}.json`), `${JSON.stringify({ token: name, issue: ISSUE, expiresAt: '2999-01-01T00:00:00.000Z' })}\n`);
  }
}

/** The tokens still outstanding. */
const outstanding = async () => (await readdir(paths(home).gates).catch(() => [])).filter((name) => name.endsWith('.json'));

/** A session as ctx.session.get gives one that has never run (F270): created, nothing more. */
const fresh = (id = PERSON, { directory = repo, parentID } = {}) => ({
  id,
  ...(parentID ? { parentID } : {}),
  projectID: 'global',
  time: { created: 1794850025467, updated: 1794850025472 },
  location: { directory },
});

/** A session that has run: an execution started, ended and left an outcome (F270). */
const ran = (id = PERSON, options) => ({ ...fresh(id, options), outcome: 'succeeded', time: { created: 1794850025467, updated: 1794850025924, busy: 1794850025888, idle: 1794850025921 } });

/** A fork, as ctx.session.get gives it right after the fork (F271): the session it came from, no parent. */
const forkOf = (id, from = PERSON, options) => ({ ...fresh(id, options), fork: { sessionID: from, boundary: { type: 'through', messageID: 'msg_1' } } });

/**
 * A stand-in for setup()'s context, in the repository: just enough for the
 * entry point to load in full, with the sessions it knows. `prompt`, `fork`
 * call the hooks as Open Code does, and give back what the bridge did to the
 * session's instruction entries; `compacted` sends the event on the streams
 * the bridge subscribed to. `fail` names the calls that throw, and is read at
 * each call.
 */
function host({ sessions = {}, fail = {}, events = true, instructions = true } = {}) {
  const hooks = new Map();
  const done = [];
  const looked = [];
  const streams = [];
  const registered = { dispose: async () => {} };
  const transforms = { transform: async () => registered };
  const entry = {
    put: async (input) => {
      if (fail.put) throw new Error(fail.put);
      done.push({ op: 'put', ...input });
    },
    remove: async (input) => {
      if (fail.remove) throw new Error(fail.remove);
      done.push({ op: 'remove', ...input });
    },
    list: async () => [],
  };
  const ctx = {
    app: { name: 'cli', version: '2.3.0', channel: 'latest' },
    location: { directory: repo, project: { id: 'global', directory: repo, canonical: repo } },
    tool: { hook: async () => registered },
    session: {
      hook: async (name, callback) => {
        if (fail.hook === name) throw new Error(`unknown session hook: ${name}`);
        hooks.set(name, callback);
        return registered;
      },
      get: async ({ sessionID }) => {
        looked.push(sessionID);
        if (fail.get) throw new Error(fail.get);
        if (!Object.hasOwn(sessions, sessionID)) throw new Error(`Session not found: ${sessionID}`);
        return sessions[sessionID];
      },
      ...(instructions ? { instructions: { entry } } : {}),
    },
    shell: { hook: async () => registered },
    permission: { hook: async () => registered },
    agent: transforms,
    command: transforms,
    skill: transforms,
  };
  if (events) ctx.event = { subscribe: (options) => stream(options, streams) };
  const since = async (call) => {
    const before = done.length;
    const returned = await call();
    assert.equal(returned, undefined, 'the callback gives the host nothing back');
    return done.slice(before);
  };
  return {
    ctx,
    sessions,
    looked,
    streams,
    done,
    prompt: (sessionID) => since(() => hooks.get('prompt')({ sessionID, messageID: 'msg_1', prompt: { text: 'hello' }, metadata: {}, delivery: 'steer' })),
    fork: (sessionID) => since(() => hooks.get('fork')({ sessionID })),
    compacted: (sessionID, type = 'session.compaction.ended') => {
      for (const { push } of streams) push({ type, data: { sessionID, reason: 'manual' } });
    },
  };
}

/**
 * An event stream as ctx.event.subscribe gives one: an async iterable, ended
 * by the signal it was given. `push` sends it an event of a type it asked for.
 */
function stream(options, streams) {
  const queue = [];
  let wake = () => {};
  const signal = options?.signal;
  signal?.addEventListener('abort', () => wake(), { once: true });
  streams.push({
    options,
    push: (event) => {
      if (!options?.types || options.types.includes(event.type)) queue.push(event);
      wake();
    },
  });
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

/** What setup() and the callbacks write to the server's stderr. */
function logOf(t) {
  const error = t.mock.method(console, 'error', () => {});
  return () => error.mock.calls.map((entry) => entry.arguments.join(' '));
}

/** The plugin in this checkout, loaded, with the sessions given. */
async function loaded(t, options) {
  const log = logOf(t);
  const stand = host(options);
  const cleanup = await plugin.setup(stand.ctx);
  return { ...stand, log, cleanup };
}

/**
 * The bridge alone, with the stand-in's context: for what the entry point
 * starts and does not wait on — a compaction on the stream — called and
 * waited on here.
 */
function bridgeOf(options) {
  const lines = [];
  const stand = host(options);
  const bridge = createBridge(stand.ctx, { root: ROOT, settings: { models: {} }, log: (line) => lines.push(line) });
  return { ...stand, bridge, log: () => lines };
}

/** The summary the handler gives itself, for a session in `cwd`: what the model must read. */
async function said(cwd = repo) {
  const decision = await handle({ cwd }, { event: 'session-start', pluginRoot: ROOT });
  assert.equal(decision.block, false);
  return decision.message;
}

/** The summary put as the session's entry, once, in the handler's words. */
function instructed(done, sessionID, summary) {
  assert.equal(typeof summary, 'string', 'the handler has a summary here');
  assert.deepEqual(done, [{ op: 'put', sessionID, key: KEY, value: summary }]);
}

/** Wait for a condition the bridge meets on its own, on the stream. */
async function until(condition, ms = 10_000) {
  for (const deadline = Date.now() + ms; !condition(); ) {
    if (Date.now() > deadline) assert.fail('the bridge did not get there in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("the rules of 06-hooks.md for session-start, on a session's first prompt", () => {
  test('HK-22: a session in the tree a task runs in is told the issue, the task and the next step', async (t) => {
    const { prompt, log } = await loaded(t, { sessions: { [PERSON]: fresh() } });
    const summary = await said();

    instructed(await prompt(PERSON), PERSON, summary);
    assert.match(summary, /^pdkit: issue 18248 — triaged/);
    assert.match(summary, /T1 \(join the command arguments\)/);
    assert.deepEqual(log(), []);
  });

  // D12: the command a step names sets the phase's model, and it lasts; there
  // is no `/model` to type here (§13 DV4).
  test('HK-22: the summary names no model to switch to', async (t) => {
    await stopTask({ worktree: repo, home });
    const { prompt } = await loaded(t, { sessions: { [PERSON]: fresh(PERSON, { directory: linked }) } });

    const [put] = await prompt(PERSON);
    assert.match(put.value, /run {5}: \/pd:plan 18248/);
    assert.doesNotMatch(put.value, /model {3}:|\/model /);
  });

  test('HK-22: a blocked task survives the restart that lost the reason it is blocked', async (t) => {
    for (let i = 0; i < 3; i += 1) await recordAttempt({ issue: ISSUE, taskId: 'T1', exitCode: 1, home });
    const { prompt } = await loaded(t, { sessions: { [PERSON]: fresh() } });

    const [put] = await prompt(PERSON);
    assert.match(put.value, /tried {3}: 3 of 3 failed capture\(s\) — BLOCKED/);
    assert.match(put.value, /pdkit task unblock/);
  });

  test('HK-36: every consent token is revoked', async (t) => {
    await tokens();
    const { prompt } = await loaded(t, { sessions: { [PERSON]: fresh() } });

    await prompt(PERSON);
    assert.deepEqual(await outstanding(), []);
  });

  test('HK-37: between phases, the issue tree tells the state and what to run', async (t) => {
    await stopTask({ worktree: repo, home });
    const { prompt } = await loaded(t, { sessions: { [PERSON]: fresh(PERSON, { directory: linked }) } });
    const summary = await said(linked);

    instructed(await prompt(PERSON), PERSON, summary);
    assert.match(summary, /task {4}: none running/);
  });

  test('HK-37: a tree on no issue\'s branch, with no task, is silence: no entry, and the tokens still go', async (t) => {
    await stopTask({ worktree: repo, home });
    await tokens();
    const { prompt, log } = await loaded(t, { sessions: { [PERSON]: fresh() } });

    assert.equal(await said(), undefined);
    assert.deepEqual(await prompt(PERSON), [], 'nothing put, and nothing to withdraw on a new session');
    assert.deepEqual(await outstanding(), []);
    assert.deepEqual(log(), []);
  });
});

describe('when it runs', () => {
  // Claude Code ran SessionStart on startup, resume, clear and compact. A
  // session continued as it is has no event here (§13 DV10): a later prompt
  // neither recounts the summary nor revokes a token — one granted for a
  // push in this session outlives the person's next message.
  test('not on a prompt of a session that has run: no process, and the tokens stay', async (t) => {
    await tokens();
    const { prompt, log, looked } = await broken(t, { 'lib/cli.js': 'this is not valid javascript {{{\n' }, { sessions: { [PERSON]: ran() } });

    assert.deepEqual(await prompt(PERSON), []);
    assert.deepEqual(looked, [PERSON], 'one lookup');
    assert.deepEqual(log(), [], 'no process: a broken CLI would have said so');
    assert.equal((await outstanding()).length, 2);
  });

  for (const [label, record] of [
    ['one whose run is under way', { ...fresh(), time: { created: 1, updated: 2, busy: 2 } }],
    ['one whose run ended', { ...fresh(), time: { created: 1, updated: 3, idle: 3 } }],
    ['one with an outcome', { ...fresh(), outcome: 'interrupted' }],
  ]) {
    test(`nor on a prompt of ${label}`, async (t) => {
      const { prompt, log } = await broken(t, { 'lib/cli.js': 'this is not valid javascript {{{\n' }, { sessions: { [PERSON]: record } });

      assert.deepEqual(await prompt(PERSON), []);
      assert.deepEqual(log(), []);
    });
  }

  // Claude Code ran no SessionStart for a subagent, and Open Code gives the
  // child none of its parent's entries (F71).
  test("nor on a subagent's first prompt — its task", async (t) => {
    const child = 'ses_child';
    const { prompt, log } = await broken(t, { 'lib/cli.js': 'this is not valid javascript {{{\n' }, { sessions: { [child]: fresh(child, { parentID: PERSON }) } });

    assert.deepEqual(await prompt(child), []);
    assert.deepEqual(log(), []);
  });

  // The fork hook has spoken for it already (F271).
  test("nor on a fork's first prompt", async (t) => {
    const id = 'ses_fork';
    const { prompt, log } = await broken(t, { 'lib/cli.js': 'this is not valid javascript {{{\n' }, { sessions: { [id]: forkOf(id) } });

    assert.deepEqual(await prompt(id), []);
    assert.deepEqual(log(), []);
  });

  test('on a fork: the summary of now replaces the one it carried, and the tokens go', async (t) => {
    await tokens();
    const id = 'ses_fork';
    const { fork, log } = await loaded(t, { sessions: { [id]: forkOf(id) } });

    instructed(await fork(id), id, await said());
    assert.deepEqual(await outstanding(), []);
    assert.deepEqual(log(), []);
  });

  // A fork carries its session's entry (F71); a summary that is now empty
  // must not leave it reading one that was true when it was written.
  test('on a fork whose summary is now empty: the entry it carried is withdrawn', async (t) => {
    await stopTask({ worktree: repo, home });
    const id = 'ses_fork';
    const { fork } = await loaded(t, { sessions: { [id]: forkOf(id) } });

    assert.deepEqual(await fork(id), [{ op: 'remove', sessionID: id, key: KEY }]);
  });

  test("not on a subagent's fork", async (t) => {
    const id = 'ses_fork';
    const { fork, log } = await broken(t, { 'lib/cli.js': 'this is not valid javascript {{{\n' }, { sessions: { [id]: forkOf(id, PERSON, { parentID: PERSON }) } });

    assert.deepEqual(await fork(id), []);
    assert.deepEqual(log(), []);
  });

  test('after a compaction, on the stream: the summary of now, and the tokens go', async (t) => {
    await tokens();
    const { compacted, done, streams, log } = await loaded(t, { sessions: { [PERSON]: ran() } });
    const summary = await said();

    const compactions = streams.find((entry) => entry.options.types?.includes('session.compaction.ended'));
    assert.deepEqual(compactions.options.types, ['session.compaction.ended']);
    compacted(PERSON);
    await until(() => done.length > 0);

    instructed(done, PERSON, summary);
    assert.deepEqual(await outstanding(), []);
    assert.deepEqual(log(), []);
  });

  test('after a compaction whose summary is now empty: the entry is withdrawn', async () => {
    await stopTask({ worktree: repo, home });
    const { bridge, done } = bridgeOf({ sessions: { [PERSON]: ran() } });

    await bridge.startOnCompaction({ type: 'session.compaction.ended', data: { sessionID: PERSON } });
    assert.deepEqual(done, [{ op: 'remove', sessionID: PERSON, key: KEY }]);
  });

  // Every loaded instance sees every session's events (F137): the one of the
  // session's directory runs it, once.
  test("not after a compaction of another directory's session: that instance runs it", async () => {
    await tokens();
    const { bridge, done, log } = bridgeOf({ sessions: { [PERSON]: ran(PERSON, { directory: linked }) } });

    await bridge.startOnCompaction({ type: 'session.compaction.ended', data: { sessionID: PERSON } });
    assert.deepEqual(done, []);
    assert.deepEqual(log(), []);
    assert.equal((await outstanding()).length, 2, 'no process');
  });

  test("not after a subagent's compaction", async () => {
    const child = 'ses_child';
    const { bridge, done, log } = bridgeOf({ sessions: { [child]: ran(child, { parentID: PERSON }) } });

    await bridge.startOnCompaction({ type: 'session.compaction.ended', data: { sessionID: child } });
    assert.deepEqual(done, []);
    assert.deepEqual(log(), []);
  });

  // Asked of the host; not relied on. A compaction that failed changed nothing.
  test('not on any other event the stream sends', async () => {
    const { bridge, done, looked } = bridgeOf({ sessions: { [PERSON]: ran() } });

    for (const type of ['session.compaction.started', 'session.compaction.failed', 'session.execution.succeeded']) {
      await bridge.startOnCompaction({ type, data: { sessionID: PERSON } });
    }
    assert.deepEqual(done, []);
    assert.deepEqual(looked, []);
  });

  test('cleanup ends the watch on compactions', async (t) => {
    const { streams, cleanup } = await loaded(t, { sessions: {} });

    await cleanup();
    for (const { options } of streams) assert.equal(options.signal.aborted, true);
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
  const dir = await mkdtemp(join(tmpdir(), 'pdkit-session-start-plugin-'));
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
  const log = logOf(t);
  const stand = host(options);
  await copy.setup(stand.ctx);
  return { ...stand, log };
}

/** The one line a session start left without an answer writes: session-start's, saying `problem`. */
const allowing = (log, problem) => {
  assert.equal(log().length, 1, log().join('\n'));
  assert.match(log()[0], new RegExp(`^opencode-pdkit: pdkit: hook "session-start" ${problem}.*; allowing$`, 's'));
};

// session-start fails open (FAIL_CLOSED names pre-bash alone): a summary that
// cannot be had must not stop the session. Here it must not lose the person's
// prompt either — an exception out of the prompt hook, or one that never
// returns, would (C36). And a run that gave no answer is not an empty summary:
// the entry a fork carries is left as it is, not withdrawn.
describe('no answer leaves the entry as it was, lets the prompt through, and says why', () => {
  const handler = (body) => ({ 'lib/hooks/session-start.js': `export async function handle() { ${body} }\n` });

  test('no node on the PATH of the server', { skip: !POSIX && 'T10.10' }, async (t) => {
    const { prompt, log } = await loaded(t, { sessions: { [PERSON]: fresh() } });
    const path = process.env.PATH;
    process.env.PATH = home;
    t.after(() => (process.env.PATH = path));

    assert.deepEqual(await prompt(PERSON), []);
    allowing(log, 'cannot run: "node" was not found on the PATH of the process that runs hooks \\(ENOENT\\)');
  });

  test('a session directory that does not exist', async (t) => {
    const { prompt, log } = await loaded(t, { sessions: { [PERSON]: fresh(PERSON, { directory: join(repo, 'missing') }) } });

    assert.deepEqual(await prompt(PERSON), []);
    allowing(log, 'cannot run: its working directory does not exist: ');
  });

  test('a session record without a directory', async (t) => {
    const { prompt, log } = await loaded(t, { sessions: { [PERSON]: { ...fresh(), location: undefined } } });

    assert.deepEqual(await prompt(PERSON), []);
    allowing(log, 'cannot run: the payload names no working directory');
  });

  test('a CLI that does not load: exit 1 — and a fork keeps the entry it carried', async (t) => {
    const id = 'ses_fork';
    const { fork, log } = await broken(t, { 'lib/cli.js': 'this is not valid javascript {{{\n' }, { sessions: { [id]: forkOf(id) } });

    assert.deepEqual(await fork(id), [], 'neither put nor withdrawn');
    allowing(log, 'exited with code 1 \\(SyntaxError: ');
  });

  test('a handler that does not load: runHook allows, as under Claude Code', async (t) => {
    const { prompt, log } = await broken(t, { 'lib/hooks/session-start.js': 'this is not valid javascript {{{\n' }, { sessions: { [PERSON]: fresh() } });

    assert.deepEqual(await prompt(PERSON), []);
    allowing(log, 'handler "session-start\\.js" is unavailable');
  });

  test('a handler that throws: runHook allows, as under Claude Code', async (t) => {
    const { prompt, log } = await broken(t, handler("throw new Error('the journal broke');"), { sessions: { [PERSON]: fresh() } });

    assert.deepEqual(await prompt(PERSON), []);
    allowing(log, 'failed \\(the journal broke\\)');
  });

  // Open Code waits on the prompt hook without end, and the person's input
  // with it: the deadline is the bridge's.
  test('a handler that hangs: stopped at the deadline, and the prompt goes on', async (t) => {
    const { prompt, log } = await broken(
      t,
      {
        'lib/hooks/session-start.js': 'export function handle() { return new Promise(() => setInterval(() => {}, 1000)); }\n',
        'lib/hooks/runner.js': (source) => source.replace('export const DEADLINE_MS = 10_000;', 'export const DEADLINE_MS = 2_000;'),
      },
      { sessions: { [PERSON]: fresh() } },
    );

    assert.deepEqual(await prompt(PERSON), []);
    allowing(log, 'gave no answer within 2s and was stopped');
  });

  // Claude Code showed a SessionStart hook's exit-2 stderr to the person
  // alone; there is no way to the person here (D12), so it goes to the log.
  test('a refusal reaches no one, and changes no entry', async (t) => {
    const { prompt, log } = await broken(t, handler("return { block: true, reason: 'pdkit: no summary today' };"), { sessions: { [PERSON]: fresh() } });

    assert.deepEqual(await prompt(PERSON), []);
    assert.deepEqual(log(), ['opencode-pdkit: session-start reason, which reaches no one here: pdkit: no summary today']);
  });

  test('a notice reaches no one; the summary beside it is put', async (t) => {
    const { prompt, log } = await broken(t, handler("return { block: false, message: 'pdkit: a summary', notice: 'pdkit: a line for the person' };"), { sessions: { [PERSON]: fresh() } });

    instructed(await prompt(PERSON), PERSON, 'pdkit: a summary');
    assert.deepEqual(log(), ['opencode-pdkit: session-start notice, which reaches no one here: pdkit: a line for the person']);
  });

  test('a session that cannot be looked up', async (t) => {
    const { prompt, fork, log } = await loaded(t, { sessions: { [PERSON]: fresh() }, fail: { get: 'the store is closed' } });

    assert.deepEqual(await prompt(PERSON), []);
    assert.deepEqual(await fork(PERSON), []);
    assert.equal(log().length, 2);
    for (const line of log()) assert.equal(line, 'opencode-pdkit: pdkit: hook "session-start" failed in the hook bridge (the store is closed); allowing');
  });

  test('an entry that cannot be put', async (t) => {
    const { prompt, log } = await loaded(t, { sessions: { [PERSON]: fresh() }, fail: { put: 'the database is locked' } });

    assert.deepEqual(await prompt(PERSON), []);
    allowing(log, 'failed in the hook bridge \\(the database is locked\\)');
  });

  test('an entry that cannot be withdrawn', async (t) => {
    await stopTask({ worktree: repo, home });
    const id = 'ses_fork';
    const { fork, log } = await loaded(t, { sessions: { [id]: forkOf(id) }, fail: { remove: 'the database is locked' } });

    assert.deepEqual(await fork(id), []);
    allowing(log, 'failed in the hook bridge \\(the database is locked\\)');
  });

  // The entries are an experimental API (F69): an Open Code without them is a
  // summary that cannot be put, said once per session start.
  test('an Open Code without session instructions', async (t) => {
    await tokens();
    const { prompt, log } = await loaded(t, { sessions: { [PERSON]: fresh() }, instructions: false });

    assert.deepEqual(await prompt(PERSON), []);
    allowing(log, 'failed in the hook bridge \\(this Open Code has no session\\.instructions\\.entry, which is experimental\\)');
    assert.deepEqual(await outstanding(), [], 'the handler ran: the tokens went');
  });

  test('a compaction that fails in the bridge says so, and the watch goes on', async (t) => {
    const fail = { get: 'the store is closed' };
    const { compacted, done, log } = await loaded(t, { sessions: { [PERSON]: ran() }, fail });

    compacted(PERSON);
    await until(() => log().length > 0);
    allowing(log, 'failed in the hook bridge \\(the store is closed\\)');

    delete fail.get;
    compacted(PERSON);
    await until(() => done.length > 0);
    assert.equal(done[0].op, 'put');
  });

  test('a callback without a session to look at says nothing, and does nothing', async (t) => {
    const { prompt, fork, log, looked } = await loaded(t, { sessions: {} });

    for (const sessionID of [undefined, '']) {
      assert.deepEqual(await prompt(sessionID), []);
      assert.deepEqual(await fork(sessionID), []);
    }
    assert.deepEqual(looked, []);
    assert.deepEqual(log(), []);
  });

  // Without the stream a compacted session keeps the summary it had; the
  // rest is as before. Said once, at setup.
  test('a host with no event stream: says what it cannot do, and starts sessions as before', async (t) => {
    const { prompt, log } = await loaded(t, { sessions: { [PERSON]: fresh() }, events: false });
    await new Promise((resolve) => setImmediate(resolve));
    const lines = log().filter((line) => /compactions/.test(line));

    assert.equal(lines.length, 1, log().join('\n'));
    assert.match(lines[0], /^opencode-pdkit: pdkit: the hook bridge cannot follow compactions \(.+\); a compacted session keeps the summary it had$/);
    instructed(await prompt(PERSON), PERSON, await said());
  });
});

describe('where it is registered', () => {
  // A host without the fork hook must leave the prompt hook registered, and
  // say which point it lacks.
  test('a point the host does not have leaves the rest registered, and is reported', async (t) => {
    const { prompt, log } = await loaded(t, { sessions: { [PERSON]: fresh() }, fail: { hook: 'fork' } });

    assert.deepEqual(log(), ['opencode-pdkit: cannot register its hooks (unknown session hook: fork); the gate and the rest are unaffected']);
    instructed(await prompt(PERSON), PERSON, await said());
  });
});
