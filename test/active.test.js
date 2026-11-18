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

// Tests for lib/active.js.
//
// The property under test is isolation between working trees. Everything else
// here is bookkeeping; the case that matters is two trees sharing one
// $PDKIT_HOME and not seeing each other's task, because that is the whole
// reason the pointer is not a field on the issue record.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { current, keyFor, list, start, stop } from '../lib/active.js';
import { paths } from '../lib/config.js';
import { read as readJournal } from '../lib/journal.js';
import { CHAIN_LIMIT } from '../lib/opencode-parents.js';
import { database } from './helpers/opencode-db.js';

let home;
// Open Code's database, as `pdkit task start` finds it from a shell: a file of
// the 2.3.0 schema with the sessions the tests name, a few of them subagents'.
let DB;
// A chain one parent longer than a lookup follows: the link at index i has i
// parents above it.
const LINKS = Array.from({ length: CHAIN_LIMIT + 2 }, (_, i) => `ses_link_${i}`);

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-active-'));
  DB = join(home, 'opencode.db');
  const top = (id) => ({ id, directory: '/work/fork', created: 1 });
  const child = (id, parent) => ({ id, parent, directory: '/work/fork', created: 2 });
  await database(DB, {
    sessions: [
      top('ses_from_env'),
      top('ses_this_one'),
      top('ses_person'),
      child('ses_worker', 'ses_person'),
      child('ses_nested', 'ses_worker'),
      top(LINKS[0]),
      ...LINKS.slice(1).map((id, i) => child(id, LINKS[i])),
    ],
    messages: [],
  });
});

beforeEach(async () => {
  await rm(paths(home).active, { recursive: true, force: true });
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

/**
 * Set (a string) or unset (undefined) environment variables for one test, and
 * put back what was there when it ends.
 *
 * @param {import('node:test').TestContext} t
 * @param {Record<string, string | undefined>} values
 */
function withEnv(t, values) {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  const apply = (entries) => {
    for (const [name, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  t.after(() => apply(saved));
  apply(values);
}

describe('the pointer', () => {
  test('records what is running and reads it back', async () => {
    await start({ issue: 18248, taskId: 'T1', worktree: '/work/fork', home });

    const found = await current({ worktree: '/work/fork', home });
    assert.equal(found.issue, 18248);
    assert.equal(found.taskId, 'T1');
    // Resolved, which is what the pointer stores and what keyFor hashes. On
    // Windows `resolve('/work/fork')` gains the current drive, so comparing
    // against the literal asserted that the path had NOT been normalized.
    assert.equal(found.worktree, resolve('/work/fork'));
    assert.ok(Date.parse(found.startedAt) > 0);
  });

  // The variable is named here literally, not imported from lib/harness.js:
  // the name is Open Code's, and a test that read it from the module under
  // test would pass with any name the module chose.
  test('records the session that started it, from the shell Open Code runs it in', async (t) => {
    withEnv(t, { OPENCODE_SESSION_ID: 'ses_from_env', CLAUDE_CODE_SESSION_ID: undefined, OPENCODE_DB: DB });

    await start({ issue: 18248, taskId: 'T1', worktree: '/work/fork', home });
    assert.equal((await current({ worktree: '/work/fork', home })).session, 'ses_from_env');

    // A person's `!pdkit …` in the TUI: Open Code sets no session there.
    delete process.env.OPENCODE_SESSION_ID;
    await start({ issue: 18248, taskId: 'T1', worktree: '/work/fork', home });
    assert.equal('session' in (await current({ worktree: '/work/fork', home })), false, 'no session is recorded rather than an empty one');
  });

  // Left over in the environment when the client or the server was started
  // from a Claude Code session, and naming that session. Recording it would
  // make this session's own agents look like another session's.
  test("does not take Claude Code's session variable for one", async (t) => {
    withEnv(t, { OPENCODE_SESSION_ID: undefined, CLAUDE_CODE_SESSION_ID: 'e7fee23a-left-over', OPENCODE_DB: DB });

    await start({ issue: 18248, taskId: 'T1', worktree: '/work/fork', home });
    assert.equal('session' in (await current({ worktree: '/work/fork', home })), false);

    process.env.OPENCODE_SESSION_ID = 'ses_this_one';
    await start({ issue: 18248, taskId: 'T1', worktree: '/work/fork', home });
    assert.equal((await current({ worktree: '/work/fork', home })).session, 'ses_this_one');
  });

  // D10: $PDKIT_HOME is shared with the Claude Code version, and a task it
  // started left a pointer naming a session of that harness. It is read as it
  // is — nothing here translates or drops it — and /pd:exec starting the task
  // again from an Open Code session puts that session in its place. Whose
  // agents the old one holds meanwhile is test/task-completed.test.js's.
  test('a pointer the Claude Code version wrote is read as it is, until the task is started again here', async (t) => {
    withEnv(t, { OPENCODE_SESSION_ID: 'ses_person', CLAUDE_CODE_SESSION_ID: undefined, OPENCODE_DB: DB });
    const written = {
      issue: 18248,
      taskId: 'T1',
      worktree: resolve('/work/fork'),
      startedAt: '2026-11-10T09:00:00.000Z',
      session: '0e1f7c52-3b9a-4d8e-a6f1-5c2d9b7e4a10',
    };
    await mkdir(paths(home).active, { recursive: true });
    await writeFile(join(paths(home).active, `${keyFor('/work/fork')}.json`), `${JSON.stringify(written, null, 2)}\n`);

    assert.deepEqual(await current({ worktree: '/work/fork', home }), written);

    await start({ issue: 18248, taskId: 'T1', worktree: '/work/fork', home });
    assert.equal((await current({ worktree: '/work/fork', home })).session, 'ses_person');
  });

  // T7.17: a subagent's shell names the subagent's own session, and no stop
  // names that one — the hook bridge gives the top of the stopping agent's
  // chain of parents. In Claude Code a subagent's shell named its parent's
  // session, so the pointer always named a session a stop could name.
  describe('the session is the one at the top of the chain of parents', () => {
    const startIn = async (t, session, db = DB) => {
      withEnv(t, { OPENCODE_SESSION_ID: session, CLAUDE_CODE_SESSION_ID: undefined, OPENCODE_DB: db });
      await start({ issue: 18248, taskId: 'T1', worktree: '/work/fork', home });
      return current({ worktree: '/work/fork', home });
    };

    test("from a subagent's shell, the session that started the subagent", async (t) => {
      assert.equal((await startIn(t, 'ses_worker')).session, 'ses_person');
    });

    test("from a subagent's subagent's, the session at the top", async (t) => {
      assert.equal((await startIn(t, 'ses_nested')).session, 'ses_person');
      assert.equal((await startIn(t, LINKS[CHAIN_LIMIT])).session, LINKS[0], `${CHAIN_LIMIT} parents up is still found`);
    });

    test('from the top, itself', async (t) => {
      assert.equal((await startIn(t, 'ses_person')).session, 'ses_person');
    });

    // The pointer then holds the implementer of any session — the gate's
    // default — and never names a session no stop can name.
    describe('when the top cannot be found, no session is recorded, not the shell\'s own', () => {
      const none = async (t, session, db) => {
        const pointer = await startIn(t, session, db);
        assert.equal(pointer.taskId, 'T1', 'the task is started all the same');
        assert.equal('session' in pointer, false, JSON.stringify(pointer));
      };

      test('no database', async (t) => {
        await none(t, 'ses_worker', join(home, 'absent.db'));
      });

      test('a database Open Code keeps in memory only', async (t) => {
        await none(t, 'ses_worker', ':memory:');
      });

      test('no row for the session', async (t) => {
        await none(t, 'ses_not_in_the_database', DB);
      });

      test('no row for a parent on the way up', async (t) => {
        const db = join(home, 'orphan.db');
        await database(db, { sessions: [{ id: 'ses_orphan', directory: '/work/fork', created: 1 }], messages: [] });
        const { DatabaseSync } = await import('node:sqlite');
        const handle = new DatabaseSync(db);
        // Foreign keys off for this one write: a parent that is gone is what is being made.
        handle.exec('pragma foreign_keys = off');
        handle.prepare("update session_v2 set parent_id = 'ses_gone' where id = 'ses_orphan'").run();
        handle.close();
        await none(t, 'ses_orphan', db);
      });

      test('a database of another schema', async (t) => {
        const db = join(home, 'other-schema.db');
        const { DatabaseSync } = await import('node:sqlite');
        const handle = new DatabaseSync(db);
        handle.exec("create table session_v2 (id text primary key); insert into session_v2 (id) values ('ses_worker')");
        handle.close();
        await none(t, 'ses_worker', db);
      });

      test(`a chain longer than ${CHAIN_LIMIT} parents`, async (t) => {
        await none(t, LINKS[CHAIN_LIMIT + 1], DB);
      });
    });

    test('a session the caller names is recorded as it is, without a lookup', async (t) => {
      withEnv(t, { OPENCODE_SESSION_ID: 'ses_worker', OPENCODE_DB: DB });
      await start({ issue: 18248, taskId: 'T1', worktree: '/work/fork', session: 'ses_worker', home });
      assert.equal((await current({ worktree: '/work/fork', home })).session, 'ses_worker');
    });
  });

  test('a tree with nothing running has no pointer', async () => {
    assert.equal(await current({ worktree: '/work/untouched', home }), null);
  });

  test('starting again replaces the pointer rather than adding one', async () => {
    await start({ issue: 18248, taskId: 'T1', worktree: '/work/fork', home });
    await start({ issue: 18248, taskId: 'T2', worktree: '/work/fork', home });

    assert.equal((await current({ worktree: '/work/fork', home })).taskId, 'T2');
    assert.equal((await readdir(paths(home).active)).length, 1);
  });

  test('stop clears it', async () => {
    await start({ issue: 18248, taskId: 'T1', worktree: '/work/fork', home });

    const stopped = await stop({ worktree: '/work/fork', home });
    assert.equal(stopped.ok, true);
    assert.equal(stopped.record.taskId, 'T1');
    assert.equal(await current({ worktree: '/work/fork', home }), null);
  });
});

describe('working trees are isolated', () => {
  // The reason this module exists rather than a field on the issue record.
  // Two worktrees on the same issue at different slices is the normal shape of
  // stage 3, and one field could not hold both answers.
  test('two trees on the same issue keep their own task', async () => {
    await start({ issue: 18248, taskId: 'T1', worktree: '/work/slice-1', home });
    await start({ issue: 18248, taskId: 'T3', worktree: '/work/slice-3', home });

    assert.equal((await current({ worktree: '/work/slice-1', home })).taskId, 'T1');
    assert.equal((await current({ worktree: '/work/slice-3', home })).taskId, 'T3');
  });

  test('stopping one does not stop the other', async () => {
    await start({ issue: 18248, taskId: 'T1', worktree: '/work/slice-1', home });
    await start({ issue: 18248, taskId: 'T3', worktree: '/work/slice-3', home });

    await stop({ worktree: '/work/slice-1', home });

    assert.equal(await current({ worktree: '/work/slice-1', home }), null);
    assert.equal((await current({ worktree: '/work/slice-3', home })).taskId, 'T3');
  });

  test('keyFor is stable and distinguishes trees', () => {
    assert.equal(keyFor('/work/fork'), keyFor('/work/fork'));
    assert.equal(keyFor('/work/fork'), keyFor('/work/fork/'));
    assert.notEqual(keyFor('/work/fork'), keyFor('/work/other'));
  });
});

describe('unreadable pointers', () => {
  // A corrupt pointer must not block every write in the tree. The audit counts
  // files written outside any Owns set regardless, so a hook that goes quiet
  // is caught later rather than never.
  test('a file that does not parse reads as no active task', async () => {
    await start({ issue: 18248, taskId: 'T1', worktree: '/work/fork', home });
    await writeFile(join(paths(home).active, `${keyFor('/work/fork')}.json`), 'not json');

    assert.equal(await current({ worktree: '/work/fork', home }), null);
  });

  // The file is named after the tree; trusting the name over the contents
  // would apply one tree's ownership rules to another.
  test('a pointer naming a different tree is not honored', async () => {
    await start({ issue: 18248, taskId: 'T1', worktree: '/work/fork', home });
    await writeFile(
      join(paths(home).active, `${keyFor('/work/fork')}.json`),
      JSON.stringify({ issue: 1, taskId: 'T9', worktree: '/work/elsewhere', startedAt: new Date().toISOString() }),
    );

    assert.equal(await current({ worktree: '/work/fork', home }), null);
  });
});

describe('list and journal', () => {
  test('list reports every tree with something running', async () => {
    await start({ issue: 18248, taskId: 'T1', worktree: '/work/slice-1', home });
    await start({ issue: 17221, taskId: 'T2', worktree: '/work/other', home });

    const running = await list({ home });
    assert.equal(running.length, 2);
    assert.deepEqual(running.map((entry) => entry.taskId).sort(), ['T1', 'T2']);
  });

  test('start and stop are journaled', async () => {
    await start({ issue: 18248, taskId: 'T1', worktree: '/work/fork', home });
    await stop({ worktree: '/work/fork', home });

    const events = (await readJournal({ issue: 18248 }, { home })).map((entry) => entry.event);
    assert.ok(events.includes('task-start'));
    assert.ok(events.includes('task-stop'));
  });
});
