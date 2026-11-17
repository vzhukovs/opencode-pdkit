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

// pre-compact in Open Code, end to end short of the host: the compaction hook
// a stand-in for setup()'s context collects, called as Open Code calls it —
// with the event a compaction gives (F72), in the plugin instance of the
// session's directory. Behind it is everything real — the bridge, the runner,
// a node process running bin/pdkit, session-start.js, the journal — in a
// repository with a task running, against a throwaway $PDKIT_HOME.
//
// Claude Code ran PreCompact before it compacted, and the handler wrote the
// active task in the journal for the compaction not to take it away; it put
// nothing in the conversation. So the rule of docs/specification/06-hooks.md
// for pre-compact is asserted as the journal's entries, and the compaction's
// event as left alone. Then the order Claude Code kept with SessionStart
// after a compaction. Then the other half: Open Code waits on the hook, and
// an exception from it fails the compaction — an automatic one the person's
// turn (F73) — so whatever fails lets the compaction go on, in time, and says
// why.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import plugin from '../opencode/server.js';
import { createBridge } from '../opencode/bridge/hooks.js';
import { start, stop as stopTask } from '../lib/active.js';
import { issueDir } from '../lib/config.js';
import { read as readJournal } from '../lib/journal.js';
import { setOwns, transition } from '../lib/state.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const POSIX = process.platform !== 'win32';
const execFileAsync = promisify(execFile);

const ISSUE = 18248;

/** The session a person drives, which started the task. */
const PERSON = 'ses_person';

/** What the handler writes for the task running in the repository (HK-23). */
const DETAIL = 'T1 active, issue triaged (standard)';

let home;
let repo;
let linked;
let previousHome;

const git = (cwd, ...args) => execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd });

before(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-pre-compact-home-')));
  // The child process takes $PDKIT_HOME from the server's environment, as it
  // would in a session; here the server is this process.
  previousHome = process.env.PDKIT_HOME;
  process.env.PDKIT_HOME = home;
  repo = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-pre-compact-repo-')));
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  // Another tree of the repository, where no task runs.
  linked = join(await realpath(tmpdir()), `pdkit-pre-compact-linked-${process.pid}`, 'issue-tree');
  await git(repo, 'worktree', 'add', '-q', '-b', `DESKTOP-${ISSUE}/join-container-command`, linked);
  await transition(ISSUE, 'triaged', { home, route: 'standard' });
  await setOwns(ISSUE, 'T1', ['packages/main/src/plugin/container-registry.ts'], { home });
  await mkdir(join(issueDir(home, ISSUE), 'tasks'), { recursive: true });
  await writeFile(join(issueDir(home, ISSUE), 'tasks', 'T1.md'), '# T1: join the command arguments\n\n- Issue: 18248\n- Satisfies: R1\n');
});

beforeEach(async () => {
  await start({ issue: ISSUE, taskId: 'T1', worktree: repo, session: PERSON, home });
});

after(async () => {
  if (previousHome === undefined) delete process.env.PDKIT_HOME;
  else process.env.PDKIT_HOME = previousHome;
  await git(repo, 'worktree', 'remove', '--force', linked);
  for (const dir of [home, repo, dirname(linked)]) await rm(dir, { recursive: true, force: true });
});

/** The `compact` entries of the issue so far. */
const compacts = async () => readJournal({ issue: ISSUE, event: 'compact' }, { home });

/** The compaction hook's event, as Open Code passes it (F72): the session, and what it is about to summarize. */
const compacting = (sessionID = PERSON) => ({
  sessionID,
  model: { id: 'echo', providerID: 'mock' },
  system: ['You are a coding agent.'],
  messages: [{ role: 'user', content: 'join the command arguments' }],
  options: {},
  agent: 'build',
  tools: {},
});

/** A session that has run, as ctx.session.get gives it (F270). */
const ran = (id = PERSON, { directory = repo, parentID } = {}) => ({
  id,
  ...(parentID ? { parentID } : {}),
  projectID: 'global',
  outcome: 'succeeded',
  time: { created: 1794850025467, updated: 1794850025924, busy: 1794850025888, idle: 1794850025921 },
  location: { directory },
});

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

/**
 * A stand-in for setup()'s context, in `directory`: just enough for the entry
 * point to load in full, with the sessions it knows. `hooks` holds the
 * callbacks of each session hook, in the order registered. `compact` calls the
 * compaction hook as Open Code does — each callback in turn — and checks that
 * they leave the event as it was and give nothing back; `compacted` sends the end of a
 * compaction on the streams the bridge subscribed to. `directory: null` is an
 * instance with no location; `fail.hook` names a hook point the host does not
 * have.
 */
function host({ directory = repo, sessions = {}, fail = {} } = {}) {
  const hooks = new Map();
  const looked = [];
  const streams = [];
  const entries = [];
  const registered = { dispose: async () => {} };
  const transforms = { transform: async () => registered };
  const ctx = {
    app: { name: 'cli', version: '2.3.0', channel: 'latest' },
    location: directory === null ? undefined : { directory, project: { id: 'global', directory, canonical: directory } },
    tool: { hook: async () => registered },
    session: {
      hook: async (name, callback) => {
        if (fail.hook === name) throw new Error(`unknown session hook: ${name}`);
        hooks.set(name, [...(hooks.get(name) ?? []), callback]);
        return registered;
      },
      get: async ({ sessionID }) => {
        looked.push(sessionID);
        if (!Object.hasOwn(sessions, sessionID)) throw new Error(`Session not found: ${sessionID}`);
        return sessions[sessionID];
      },
      instructions: {
        entry: {
          put: async (input) => entries.push({ op: 'put', ...input }),
          remove: async (input) => entries.push({ op: 'remove', ...input }),
          list: async () => [],
        },
      },
    },
    shell: { hook: async () => registered },
    permission: { hook: async () => registered },
    agent: transforms,
    command: transforms,
    skill: transforms,
    event: { subscribe: (options) => stream(options, streams) },
  };
  return {
    ctx,
    hooks,
    looked,
    entries,
    compact: async (sessionID) => {
      const event = compacting(sessionID);
      for (const callback of hooks.get('compaction')) {
        assert.equal(await callback(event), undefined, 'a callback gives the host nothing back');
      }
      assert.deepEqual(event, compacting(sessionID), 'the callbacks leave the compaction as it was: no result, no text');
    },
    compacted: (sessionID) => {
      for (const { push } of streams) push({ type: 'session.compaction.ended', data: { sessionID, reason: 'manual' } });
    },
  };
}

/** What setup() and the callbacks write to the server's stderr. */
function logOf(t) {
  const error = t.mock.method(console, 'error', () => {});
  return () => error.mock.calls.map((entry) => entry.arguments.join(' '));
}

/** The plugin in this checkout, loaded in the stand-in's directory. */
async function loaded(t, options) {
  const log = logOf(t);
  const stand = host(options);
  const cleanup = await plugin.setup(stand.ctx);
  t.after(() => cleanup?.());
  return { ...stand, log };
}

/**
 * A copy of the plugin with some files replaced, loaded in the repository.
 *
 * @param {import('node:test').TestContext} t
 * @param {Record<string, string|((text: string) => string)|null>} files
 */
async function broken(t, files, options) {
  const dir = await mkdtemp(join(tmpdir(), 'pdkit-pre-compact-plugin-'));
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
  const cleanup = await copy.setup(stand.ctx);
  t.after(() => cleanup?.());
  return { ...stand, log };
}

/** Wait for a condition the bridge meets on its own, on the stream. */
async function until(condition, ms = 10_000) {
  for (const deadline = Date.now() + ms; !condition(); ) {
    if (Date.now() > deadline) assert.fail('the bridge did not get there in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('the rule of 06-hooks.md for pre-compact', () => {
  test('HK-23: a compaction with a task running writes the task, the state and the route to the journal', async (t) => {
    const { compact, log, looked } = await loaded(t);
    const before = (await compacts()).length;

    await compact(PERSON);

    const written = (await compacts()).slice(before);
    assert.equal(written.length, 1);
    assert.equal(written[0].detail, DETAIL);
    assert.deepEqual(log(), []);
    assert.deepEqual(looked, [], 'no lookup the compaction would wait on');
  });

  // Nothing injected: "the point of the entry is that it survives
  // compaction, and a message here would be the first thing compaction
  // discards". compact() checks the event is left as it was.
  test('HK-23: nothing goes into the compaction', async (t) => {
    const { compact, log } = await loaded(t);

    await compact(PERSON);
    assert.deepEqual(log(), []);
  });

  test('HK-23: a compaction with no task running writes nothing', async (t) => {
    await stopTask({ worktree: repo, home });
    const { compact, log } = await loaded(t);
    const before = (await compacts()).length;

    await compact(PERSON);

    assert.equal((await compacts()).length, before);
    assert.deepEqual(log(), []);
  });

  // Open Code calls the hook once per compaction, and a turn may compact more
  // than once (F72); Claude Code ran PreCompact before each of its own.
  test('each compaction is its own entry', async (t) => {
    const { compact } = await loaded(t);
    const before = (await compacts()).length;

    for (let i = 0; i < 3; i += 1) await compact(PERSON);

    assert.deepEqual((await compacts()).slice(before).map((entry) => entry.detail), [DETAIL, DETAIL, DETAIL]);
  });

  // A subagent's session is compacted like a person's; the entry is the
  // directory's either way, and costs no lookup of its parent.
  test("a subagent's compaction writes the same entry", async (t) => {
    const { compact, looked } = await loaded(t);
    const before = (await compacts()).length;

    await compact('ses_child');

    assert.deepEqual((await compacts()).slice(before).map((entry) => entry.detail), [DETAIL]);
    assert.deepEqual(looked, []);
  });

  // The event names no directory: the instance's is the session's (F72, F137).
  test("the task is the instance directory's: in another tree, where none runs, nothing", async (t) => {
    const { compact, log } = await loaded(t, { directory: linked });
    const before = (await compacts()).length;

    await compact(PERSON);

    assert.equal((await compacts()).length, before);
    assert.deepEqual(log(), []);
  });
});

// Claude Code ran PreCompact before it compacted and SessionStart (`compact`)
// after, so the entry was in the summary the session got back. Open Code
// waits on the compaction hook before it asks for the summary, and ends the
// compaction after (F72); session-start runs on that end (F272).
describe('in the order Claude Code kept', () => {
  test('the entry is in the summary session-start gives after the compaction', async (t) => {
    const { compact, compacted, entries } = await loaded(t, { sessions: { [PERSON]: ran() } });

    await compact(PERSON);
    compacted(PERSON);
    await until(() => entries.length > 0);

    assert.equal(entries.length, 1);
    assert.equal(entries[0].op, 'put');
    const recent = entries[0].value.split('\n').filter((line) => /^ {4}\S+ {2}compact {2}/.test(line));
    assert.ok(recent.length > 0, entries[0].value);
    assert.match(recent.at(-1), new RegExp(`compact {2}${DETAIL.replace(/[()]/g, '\\$&')}$`));
  });
});

/** The one line a compaction left without an answer writes: pre-compact's, saying `problem`. */
const allowing = (log, problem) => {
  assert.equal(log().length, 1, log().join('\n'));
  assert.match(log()[0], new RegExp(`^opencode-pdkit: pdkit: hook "pre-compact" ${problem}.*; allowing$`, 's'));
};

// pre-compact fails open (FAIL_CLOSED names pre-bash alone): an entry that
// cannot be written must not stop the compaction. Open Code waits on the hook
// without end and fails the compaction on an exception from it — an automatic
// one, the person's turn (F73) — so here every failure returns, in time.
describe('no answer lets the compaction go on, and says why', () => {
  const handler = (body) => ({ 'lib/hooks/session-start.js': `export async function handle() { ${body} }\n` });

  test('no node on the PATH of the server', { skip: !POSIX && 'T10.10' }, async (t) => {
    const { compact, log } = await loaded(t);
    const path = process.env.PATH;
    process.env.PATH = home;
    t.after(() => (process.env.PATH = path));

    await compact(PERSON);
    allowing(log, 'cannot run: "node" was not found on the PATH of the process that runs hooks \\(ENOENT\\)');
  });

  test('an instance directory that does not exist', async (t) => {
    const { compact, log } = await loaded(t, { directory: join(repo, 'missing') });

    await compact(PERSON);
    allowing(log, 'cannot run: its working directory does not exist: ');
  });

  test('a CLI that does not load: exit 1', async (t) => {
    const { compact, log } = await broken(t, { 'lib/cli.js': 'this is not valid javascript {{{\n' });

    await compact(PERSON);
    allowing(log, 'exited with code 1 \\(SyntaxError: ');
  });

  test('a handler that does not load: runHook allows, as under Claude Code', async (t) => {
    const { compact, log } = await broken(t, { 'lib/hooks/session-start.js': 'this is not valid javascript {{{\n' });

    await compact(PERSON);
    allowing(log, 'handler "session-start\\.js" is unavailable');
  });

  test('a handler that throws: runHook allows, as under Claude Code', async (t) => {
    const { compact, log } = await broken(t, handler("throw new Error('the journal broke');"));

    await compact(PERSON);
    allowing(log, 'failed \\(the journal broke\\)');
  });

  // Open Code would hold the compaction, and the turn, for as long as the
  // hook takes (F73): the deadline is the bridge's.
  test('a handler that hangs: stopped at the deadline, and the compaction goes on', async (t) => {
    const { compact, log } = await broken(t, {
      'lib/hooks/session-start.js': 'export function handle() { return new Promise(() => setInterval(() => {}, 1000)); }\n',
      'lib/hooks/runner.js': (source) => source.replace('export const DEADLINE_MS = 10_000;', 'export const DEADLINE_MS = 2_000;'),
    });
    const started = Date.now();

    await compact(PERSON);

    assert.ok(Date.now() - started < 8_000, `returned after ${Date.now() - started} ms`);
    allowing(log, 'gave no answer within 2s and was stopped');
  });

  // The handler never refuses; one that does stops nothing — a throw would
  // fail the compaction, not skip it — and its reason goes to the log.
  test('a refusal stops nothing, and reaches no one', async (t) => {
    const { compact, log } = await broken(t, handler("return { block: true, reason: 'pdkit: not now' };"));

    await compact(PERSON);
    assert.deepEqual(log(), ['opencode-pdkit: pre-compact reason, which reaches no one here: pdkit: not now']);
  });

  test('a message and a notice reach no one', async (t) => {
    const { compact, log } = await broken(t, handler("return { block: false, message: 'pdkit: for the model', notice: 'pdkit: for the person' };"));

    await compact(PERSON);
    assert.deepEqual(log(), [
      'opencode-pdkit: pre-compact message, which reaches no one here: pdkit: for the model',
      'opencode-pdkit: pre-compact notice, which reaches no one here: pdkit: for the person',
    ]);
  });

  test('an instance without a directory', async (t) => {
    const { compact, log } = await loaded(t, { directory: null });

    await compact(PERSON);
    allowing(log, 'cannot run: the payload names no working directory');
  });

  test('a bridge that fails before the run', async () => {
    const lines = [];
    const stand = host();
    Object.defineProperty(stand.ctx, 'location', {
      get() {
        throw new Error('the location is gone');
      },
    });
    const bridge = createBridge(stand.ctx, { root: ROOT, settings: { models: {} }, log: (line) => lines.push(line) });
    const before = (await compacts()).length;

    assert.equal(await bridge.preCompact(compacting()), undefined);
    assert.deepEqual(lines, ['pdkit: hook "pre-compact" failed in the hook bridge (the location is gone); allowing']);
    assert.equal((await compacts()).length, before);
  });

  test('a callback without a session says nothing, and does nothing', async (t) => {
    const { hooks, log } = await loaded(t);
    const before = (await compacts()).length;

    for (const event of [undefined, {}, { sessionID: '' }, { sessionID: 7 }]) {
      for (const callback of hooks.get('compaction')) assert.equal(await callback(event), undefined);
    }
    assert.equal((await compacts()).length, before);
    assert.deepEqual(log(), []);
  });
});

describe('where it is registered', () => {
  // A host without the compaction hook must leave the rest registered, and
  // say which point it lacks — once for pre-compact, once for the agents'
  // hiding of tools, which stands on the same point (opencode/agents.js).
  test('a point the host does not have leaves the rest registered, and is reported', async (t) => {
    const { hooks, log } = await loaded(t, { fail: { hook: 'compaction' } });

    assert.deepEqual(log(), [
      'opencode-pdkit: cannot register its hooks (unknown session hook: compaction); the gate and the rest are unaffected',
      'opencode-pdkit: cannot register its hiding of tools (unknown session hook: compaction); pd-implementer, pd-thread-resolver may be offered opencode_worktree_remove, which Claude Code did not give them',
    ]);
    assert.deepEqual([...hooks.keys()].sort(), ['context', 'experimental.idle', 'fork', 'generate', 'prompt']);
  });
});
