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

// Which session a session belongs to: the one at the top of its chain of
// parents, from the database Open Code keeps for the user.
//
// A subagent runs in a child session, and its shell names that child. The
// session a person drives is the one at the top, and it is the one the hook
// bridge compares a subagent's stop with. lib/active.js asks here when the
// task is started from a shell, so that both sides name the same session
// whichever shell ran `pdkit task start`: in Claude Code a subagent's shell
// named its parent's session, and both sides agreed by themselves.
//
// The database, not the server. `opencode api` asks the background service,
// not the server that runs the session, and when that service is not running
// it starts one, which takes over every session another server is running on
// the same database, the one asking included. The database answers in a
// millisecond, with no server and nothing started. It is read as
// lib/opencode-sessions.js reads it — the same file, read-only — and, the
// schema being internal to Open Code, any failure is no answer.

import { access } from 'node:fs/promises';

import { databasePath, openReadOnly } from './opencode-sessions.js';

/**
 * How many parents a lookup follows before it gives up. Open Code nests one
 * level unless a person raises `experimental.subagent_depth`; the hook bridge
 * follows as many (DEPTH_LIMIT in opencode/bridge/hooks.js).
 */
export const CHAIN_LIMIT = 16;

/**
 * The session at the top of `id`'s chain of parents: `id` itself when it has
 * no parent.
 *
 * Null when the database cannot say — no file, no node:sqlite, a schema
 * without the column, no row for a session on the way up, or a chain longer
 * than CHAIN_LIMIT. Never a session from the middle of the chain, and never
 * `id` itself unless the database says it has no parent: a caller records
 * nothing rather than a session it cannot vouch for.
 *
 * @param {string} id
 * @param {{db?: string|null, env?: NodeJS.ProcessEnv}} [options]
 *   db: the database file, default where Open Code keeps it for `env`
 * @returns {Promise<string|null>}
 */
export async function sessionAtTop(id, options = {}) {
  const file = options.db === undefined ? databasePath(options.env) : options.db;
  if (typeof id !== 'string' || id === '' || !file) return null;

  let db;
  try {
    // Opening a file that is not there would be a question about why; this is an answer.
    await access(file);
    db = await openReadOnly(file);
    const parentOf = db.prepare('select parent_id from session_v2 where id = ?');
    let session = id;
    for (let step = 0; step <= CHAIN_LIMIT; step += 1) {
      const row = parentOf.all(session)[0];
      if (row === undefined) return null;
      const parent = row.parent_id;
      if (parent === null || parent === undefined || parent === '') return session;
      if (typeof parent !== 'string') return null;
      session = parent;
    }
    return null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
