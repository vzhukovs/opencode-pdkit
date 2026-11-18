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

// A session database of Open Code's own schema, built for a test.
//
// The schema is the one of Open Code 2.3.0 (test/fixtures/opencode-schema-2.3.0.sql),
// the rows are the ones a test names, and the file is wherever the test puts
// it — a temporary directory, never the database Open Code keeps for the user.
//
// Outside `test/*.test.js`, so the runner does not collect it as a suite.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The schema of Open Code 2.3.0. */
export const SCHEMA = join(dirname(dirname(fileURLToPath(import.meta.url))), 'fixtures', 'opencode-schema-2.3.0.sql');

/**
 * A database of the 2.3.0 schema in WAL mode, as Open Code keeps its own.
 *
 * @param {string} file
 * @param {{sessions: object[], messages: object[]}} rows
 *   a session: `{id, directory, created, parent?, forkOf?, boundary?}`;
 *   a message: `{id, session, type, seq, data}`, with `data.time.created`
 */
export async function database(file, rows) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec(await readFile(SCHEMA, 'utf8'));
  db.exec('pragma journal_mode = wal');
  // node:sqlite enforces foreign keys, and every session belongs to a project.
  db.prepare("insert into project (id, worktree, time_created, time_updated, sandboxes) values ('project-1', '/', 0, 0, '[]')").run();
  const session = db.prepare(
    'insert into session_v2 (id, project_id, parent_id, fork_session_id, fork_boundary, slug, directory, version, time_created, time_updated) ' +
      "values (?, 'project-1', ?, ?, ?, 'slug', ?, '2.3.0', ?, ?)",
  );
  for (const row of rows.sessions) {
    session.run(row.id, row.parent ?? null, row.forkOf ?? null, row.boundary ? JSON.stringify(row.boundary) : null, row.directory, row.created, row.created);
  }
  const message = db.prepare('insert into session_message (id, session_id, type, seq, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?, ?)');
  for (const row of rows.messages) {
    message.run(row.id, row.session, row.type, row.seq, row.data.time.created, row.data.time.created, JSON.stringify(row.data));
  }
  db.close();
}
