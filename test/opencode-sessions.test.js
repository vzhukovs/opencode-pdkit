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

// Tests for lib/opencode-sessions.js: Open Code's session database read into
// calls.
//
// Each of the things the module header lists would, read carelessly, change
// every number pdkit cost prints without an error anywhere: a fork counted
// twice, a subagent's calls lost or given to the parent, reasoning left out
// of the output, a step taken in another project counted for this one, a
// database of another schema read as zeros. Each is pinned here, on a small
// database built from the schema of Open Code 2.3.0
// (test/fixtures/opencode-schema-2.3.0.sql, test/helpers/opencode-db.js) in a
// temporary directory. Nothing here opens the database Open Code keeps for the
// user.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { tally, unitsOf } from '../lib/cost.js';
import { databasePath, modelName, openReadOnly, read } from '../lib/opencode-sessions.js';
import { database } from './helpers/opencode-db.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MODULE = join(ROOT, 'lib', 'opencode-sessions.js');

const T0 = Date.parse('2026-11-16T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

const SONNET = { id: 'sonnet', providerID: 'claude-agent', variant: 'medium' };
const GPT = { id: 'gpt-6.1-sol', providerID: 'openai', variant: 'default' };
const API = { id: 'claude-sonnet-5-5', providerID: 'anthropic' };

/** @param {number} input @param {number} output */
const tokens = (input, output, reasoning = 0, read = 0, write = 0) => ({ input, output, reasoning, cache: { read, write } });

/** One step, ended: its tokens are on it. */
const step = (at, usage, model = API) => ({
  time: { created: at, firstToken: at + 200, completed: at + 500 },
  agent: 'build',
  model,
  finish: 'stop',
  cost: 0,
  tokens: usage,
});

/** A step still running: no tokens yet. */
const running = (at, model = API) => ({ time: { created: at }, agent: 'build', model });

const moved = (at, from, to) => ({ time: { created: at }, location: { directory: to }, previous: { location: { directory: from } } });

describe('where the database is', () => {
  test('OPENCODE_DB first, a relative name in the data directory, else opencode.db there', () => {
    assert.equal(databasePath({ OPENCODE_DB: join(ROOT, 'x.db') }), join(ROOT, 'x.db'));
    assert.equal(databasePath({ OPENCODE_DB: 'other.db', XDG_DATA_HOME: join(ROOT, 'data') }), join(ROOT, 'data', 'opencode', 'other.db'));
    assert.equal(databasePath({ XDG_DATA_HOME: join(ROOT, 'data') }), join(ROOT, 'data', 'opencode', 'opencode.db'));
    assert.equal(databasePath({}), join(homedir(), '.local', 'share', 'opencode', 'opencode.db'));
  });

  test('an in-memory database has no file to read', () => {
    assert.equal(databasePath({ OPENCODE_DB: ':memory:' }), null);
  });
});

describe('a model as Open Code names it', () => {
  test('provider/model, with the variant unless it is the default one', () => {
    assert.equal(modelName({ provider: 'claude-agent', model: 'opus', variant: 'high' }), 'claude-agent/opus#high');
    assert.equal(modelName({ provider: 'openai', model: 'gpt-6.1-sol', variant: 'default' }), 'openai/gpt-6.1-sol');
    assert.equal(modelName({ provider: 'anthropic', model: 'claude-sonnet-5-5', variant: null }), 'anthropic/claude-sonnet-5-5');
    assert.equal(modelName({ provider: null, model: null, variant: null }), 'unknown');
  });
});

describe('reading the calls of one clone', () => {
  let dir;
  let file;
  let repo;
  let trees;
  let scan;

  const call = (agentOrSession) => scan.calls.find((entry) => (entry.agent ?? entry.sessionId) === agentOrSession);

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pdkit-oc-sessions-'));
    repo = join(dir, 'clone');
    trees = join(dir, 'trees');
    const elsewhere = join(dir, 'elsewhere');
    for (const path of [repo, join(repo, 'packages', 'main'), join(trees, 'DESKTOP-1'), elsewhere, join(dir, 'clone-other')]) {
      await mkdir(path, { recursive: true });
    }
    file = join(dir, 'opencode.db');

    const top = { id: 'top-1', directory: repo, created: T0 };
    await database(file, {
      sessions: [
        top,
        { id: 'child-1', parent: 'top-1', directory: repo, created: T0 + 3000 },
        { id: 'grandchild-1', parent: 'child-1', directory: repo, created: T0 + 3500 },
        // A worktree, spelled as the process saw it: behind /var -> /private/var on macOS.
        { id: 'tree-1', directory: join(await realpath(trees), 'DESKTOP-1'), created: T0 },
        { id: 'sub-1', directory: join(repo, 'packages', 'main'), created: T0 },
        // Starts with the clone's path, and is another directory.
        { id: 'other-1', directory: join(dir, 'clone-other'), created: T0 },
        { id: 'moved-in', directory: repo, created: T0 },
        { id: 'moved-out', directory: elsewhere, created: T0 },
        { id: 'fork-1', forkOf: 'top-1', boundary: { type: 'through', messageID: 'm-top-2' }, directory: repo, created: T0 + 60_000 },
        { id: 'fork-2', forkOf: 'top-1', boundary: { type: 'before', messageID: 'm-top-4' }, directory: repo, created: T0 + 60_000 },
        { id: 'fork-3', forkOf: 'top-1', boundary: { type: 'through', messageID: 'm-gone' }, directory: repo, created: T0 + 60_000 },
      ],
      messages: [
        { id: 'm-top-1', session: 'top-1', type: 'user', seq: 1, data: { time: { created: T0 + 500 } } },
        { id: 'm-top-2', session: 'top-1', type: 'assistant', seq: 2, data: step(T0 + 1000, tokens(100, 10, 5, 1000, 50), SONNET) },
        { id: 'm-top-3', session: 'top-1', type: 'assistant', seq: 3, data: running(T0 + 2000) },
        {
          id: 'm-top-4',
          session: 'top-1',
          type: 'compaction',
          seq: 4,
          data: { time: { created: T0 + 5000 }, status: 'completed', reason: 'auto', model: { id: 'opus', providerID: 'claude-agent', variant: 'high' }, cost: 0, tokens: tokens(2, 500, 100, 0, 17_000) },
        },
        { id: 'm-top-5', session: 'top-1', type: 'compaction', seq: 5, data: { time: { created: T0 + 6000 }, status: 'failed', reason: 'manual' } },

        { id: 'm-child-1', session: 'child-1', type: 'assistant', seq: 1, data: step(T0 + 3100, tokens(50, 5), GPT) },
        { id: 'm-grand-1', session: 'grandchild-1', type: 'assistant', seq: 1, data: step(T0 + 3600, tokens(10, 1)) },
        { id: 'm-tree-1', session: 'tree-1', type: 'assistant', seq: 1, data: step(T0 + 100, tokens(7, 1)) },
        { id: 'm-sub-1', session: 'sub-1', type: 'assistant', seq: 1, data: step(T0 + 100, tokens(8, 1)) },
        { id: 'm-other-1', session: 'other-1', type: 'assistant', seq: 1, data: step(T0 + 100, tokens(9999, 1)) },

        { id: 'm-in-1', session: 'moved-in', type: 'assistant', seq: 1, data: step(T0 + 100, tokens(1000, 1)) },
        { id: 'm-in-2', session: 'moved-in', type: 'location-switched', seq: 2, data: moved(T0 + 200, elsewhere, repo) },
        { id: 'm-in-3', session: 'moved-in', type: 'assistant', seq: 3, data: step(T0 + 300, tokens(3, 1)) },
        { id: 'm-out-1', session: 'moved-out', type: 'assistant', seq: 1, data: step(T0 + 100, tokens(4, 1)) },
        { id: 'm-out-2', session: 'moved-out', type: 'location-switched', seq: 2, data: moved(T0 + 200, repo, elsewhere) },
        { id: 'm-out-3', session: 'moved-out', type: 'assistant', seq: 3, data: step(T0 + 300, tokens(2000, 1)) },

        // Copies keep the source's data, times and tokens included.
        { id: 'm-top-2_2', session: 'fork-1', type: 'assistant', seq: 2, data: step(T0 + 1000, tokens(100, 10, 5, 1000, 50), SONNET) },
        { id: 'm-fork1-3', session: 'fork-1', type: 'assistant', seq: 3, data: step(T0 + 61_000, tokens(20, 2)) },
        { id: 'm-top-2_2b', session: 'fork-2', type: 'assistant', seq: 2, data: step(T0 + 1000, tokens(100, 10, 5, 1000, 50), SONNET) },
        { id: 'm-fork2-4', session: 'fork-2', type: 'assistant', seq: 4, data: step(T0 + 61_000, tokens(30, 3)) },
        { id: 'm-top-2_2c', session: 'fork-3', type: 'assistant', seq: 2, data: step(T0 + 1000, tokens(100, 10, 5, 1000, 50), SONNET) },
        { id: 'm-fork3-3', session: 'fork-3', type: 'assistant', seq: 3, data: step(T0 + 61_000, tokens(40, 4)) },
      ],
    });

    scan = await read({ db: file, repoRoot: repo, config: { worktrees: { root: '../trees' } } });
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('is not a skip, and says what it read', () => {
    assert.equal(scan.skip, null);
    assert.deepEqual(scan.source, {
      db: file,
      sessions: 8,
      subagentSessions: 2,
      steps: 10,
      unfinishedSteps: 1,
      forkCopies: 3,
      elsewhereSteps: 2,
      lastMessageInputSteps: 1,
    });
    assert.equal(scan.calls.length, 10);
  });

  test('one call per ended step: its four counters, output with reasoning, at its end, on its model', () => {
    assert.deepEqual(call('top-1'), {
      at: iso(T0 + 1500),
      model: 'claude-agent/sonnet#medium',
      sessionId: 'top-1',
      agent: null,
      usage: { input: 100, cacheRead: 1000, cacheWrite: 50, output: 15 },
    });
  });

  test('a subagent is its child session, under the top-level session, however deep', () => {
    assert.deepEqual(call('child-1'), {
      at: iso(T0 + 3600),
      model: 'openai/gpt-6.1-sol',
      sessionId: 'top-1',
      agent: 'child-1',
      usage: { input: 50, cacheRead: 0, cacheWrite: 0, output: 5 },
    });
    assert.equal(call('grandchild-1').sessionId, 'top-1');
    assert.equal(call('grandchild-1').agent, 'grandchild-1');
  });

  test('the clone, a directory in it and a worktree count; a sibling that shares the prefix does not', () => {
    assert.ok(call('tree-1'));
    assert.ok(call('sub-1'));
    assert.equal(call('other-1'), undefined);
    assert.equal(scan.calls.some((entry) => entry.usage.input === 9999), false);
  });

  test('a step counts where it was taken: before a move in, after a move out, it does not', () => {
    assert.deepEqual(
      scan.calls.filter((entry) => entry.sessionId === 'moved-in' || entry.sessionId === 'moved-out').map((entry) => [entry.sessionId, entry.usage.input]),
      [
        ['moved-out', 4],
        ['moved-in', 3],
      ],
    );
  });

  test("a fork's copies are not counted again, by boundary or, when that is gone, by time", () => {
    const forks = scan.calls.filter((entry) => entry.sessionId.startsWith('fork-')).map((entry) => [entry.sessionId, entry.usage.input]);
    assert.deepEqual(forks.sort(), [
      ['fork-1', 20],
      ['fork-2', 30],
      ['fork-3', 40],
    ]);
    // The source's step itself is counted once, in the source.
    assert.equal(scan.calls.filter((entry) => entry.usage.input === 100).length, 1);
  });

  test('a completed compaction is returned apart, with its tokens; a failed one is not', () => {
    assert.deepEqual(scan.compactions, [
      {
        at: iso(T0 + 5000),
        sessionId: 'top-1',
        agent: null,
        model: 'claude-agent/opus#high',
        usage: { input: 2, cacheRead: 0, cacheWrite: 17_000, output: 600 },
      },
    ]);
    assert.equal(scan.calls.some((entry) => entry.usage.cacheWrite === 17_000), false);
  });

  test('without worktrees.root, a worktree outside the clone is not the clone', async () => {
    const narrow = await read({ db: file, repoRoot: repo, config: {} });
    assert.equal(narrow.calls.some((entry) => entry.sessionId === 'tree-1'), false);
    assert.equal(narrow.source.steps, 9);
  });

  test('reads while another connection is writing, and sees only what was committed', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const service = new DatabaseSync(file);
    try {
      service.exec('begin immediate');
      service
        .prepare('insert into session_message (id, session_id, type, seq, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?, ?)')
        .run('m-top-9', 'top-1', 'assistant', 9, T0 + 9000, T0 + 9000, JSON.stringify(step(T0 + 9000, tokens(5, 5))));

      const during = await read({ db: file, repoRoot: repo, config: { worktrees: { root: '../trees' } } });
      assert.equal(during.source.steps, 10);

      service.exec('commit');
      const afterwards = await read({ db: file, repoRoot: repo, config: { worktrees: { root: '../trees' } } });
      assert.equal(afterwards.source.steps, 11);
    } finally {
      service.close();
    }
  });

  test('opens the database for reading only', async () => {
    const db = await openReadOnly(file);
    try {
      assert.throws(() => db.prepare("delete from session_message where id = 'm-top-2'").run(), /readonly/);
    } finally {
      db.close();
    }
  });

  test('prints no ExperimentalWarning about SQLite into the output it shares a stream with', async () => {
    const script =
      `const { openReadOnly } = await import(${JSON.stringify(pathToFileURL(MODULE).href)});\n` +
      `const db = await openReadOnly(${JSON.stringify(file)});\n` +
      "db.close(); console.log('read');\n";
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script]);
    assert.equal(stdout, 'read\n');
    assert.doesNotMatch(stderr, /ExperimentalWarning|SQLite is an experimental/);
  });
});

describe('what is a skip, never zeros', () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pdkit-oc-skip-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('no database file', async () => {
    const scan = await read({ db: join(dir, 'none.db'), repoRoot: dir });
    assert.match(scan.skip.reason, /^no Open Code database at .*none\.db .*pass --db <file>/);
    assert.deepEqual(scan.calls, []);
  });

  test('a database kept in memory', async () => {
    const scan = await read({ db: null, repoRoot: dir });
    assert.match(scan.skip.reason, /:memory:/);
  });

  test('a schema without what is read, naming each missing table and column', async () => {
    const file = join(dir, 'older.db');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file);
    db.exec('create table session_v2 (id text primary key, parent_id text, fork_session_id text, directory text, time_created integer)');
    db.close();

    const scan = await read({ db: file, repoRoot: dir });
    assert.match(scan.skip.reason, /has no session_v2\.fork_boundary, session_message — a schema this reader does not know/);
    assert.match(scan.skip.reason, /nothing was measured/);
  });

  test('a file that is not a database', async () => {
    const file = join(dir, 'garbage.db');
    await writeFile(file, 'not a database, not even close\n'.repeat(200));
    const scan = await read({ db: file, repoRoot: dir });
    assert.match(scan.skip.reason, /could not be read: /);
  });

  test('a database that cannot be opened', async () => {
    const file = join(dir, 'present.db');
    await writeFile(file, '');
    const scan = await read({
      db: file,
      repoRoot: dir,
      open: async () => {
        throw new Error('no such built-in module: node:sqlite');
      },
    });
    assert.match(scan.skip.reason, /could not be read: no such built-in module/);
  });
});

// Moved here from test/cost.test.js with Claude Code's reader: the rule is the
// reader's, that a counter the source leaves out is a zero. `undefined + 1` is
// NaN, which would poison every sum it reached without an error anywhere.
describe('a counter a step does not carry', () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pdkit-oc-counters-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('reads as zero, not NaN: no cache, no reasoning, or no counter at all', async () => {
    const file = join(dir, 'opencode.db');
    await database(file, {
      sessions: [{ id: 'top-1', directory: dir, created: T0 }],
      messages: [
        { id: 'm-1', session: 'top-1', type: 'assistant', seq: 1, data: step(T0 + 100, { input: 12, output: 3 }) },
        { id: 'm-2', session: 'top-1', type: 'assistant', seq: 2, data: step(T0 + 200, {}) },
      ],
    });

    const scan = await read({ db: file, repoRoot: dir });
    assert.deepEqual(
      scan.calls.map((entry) => entry.usage),
      [
        { input: 12, cacheRead: 0, cacheWrite: 0, output: 3 },
        { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      ],
    );
    assert.equal(unitsOf(scan.calls[0].usage, scan.calls[0].model), 27);
    assert.equal(tally(scan.calls).units, 27);
  });
});
