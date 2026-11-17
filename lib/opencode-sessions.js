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

// Open Code's session data, read into calls: one call per step, from the
// SQLite database Open Code keeps for every project of the user.
//
// One source of calls and nothing else. What a call cost, which issue and
// phase it belongs to, and how the report reads are lib/cost.js's.
//
// The database is Open Code's own and its schema is internal (2.3.0 is the
// version this was written against and tested on). It is opened read-only,
// with node:sqlite, while the service may be writing to it: the journal mode is
// WAL and a reader takes no lock the service waits for. Before a row is read,
// the tables and columns used here are checked; a database without them is a
// skip with what is missing, never a report of zeros.
//
// What the rows hold, and what this module exists to get right:
//
//   - A step — one request to a provider — is one `assistant` message, with
//     its tokens on it once the step has ended. A step without tokens is still
//     running or failed; it is counted apart, as the transcripts' unreadable
//     lines were, and not as a call.
//   - `output` there is the visible output alone; reasoning is counted apart.
//     Claude Code's `output_tokens` included thinking, so a call's output here
//     is the two summed.
//   - A subagent runs in a session of its own whose parent is the session
//     that started it. Its steps are only in its own messages, never in the
//     parent's. One child session is one agent run.
//   - A fork copies the messages of its source up to the point it was forked
//     at, tokens and times included. Those copies are the source's calls, and
//     counting them would count the calls twice.
//   - A session can move: `session_move` changes its directory, and only the
//     current one is on the session. Where each step was taken is recovered
//     from the `location-switched` messages, and a step counts for the
//     repository when it was taken in the clone or under `worktrees.root`.
//   - The session's own token totals are not used: they hold the title and
//     `generate` calls, which have no message, no model and no time, and keep
//     steps a revert removed, while they leave out the copies of a fork.
//   - A compaction is a message of its own, with tokens. Claude Code's
//     transcripts never carried a compaction's tokens, so they are returned
//     apart from the calls.

import { access, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { get } from './config.js';

/**
 * The columns read, table by table. Anything missing makes the database one
 * of a schema this module does not know.
 */
export const REQUIRED_COLUMNS = Object.freeze({
  session_v2: ['id', 'parent_id', 'fork_session_id', 'fork_boundary', 'directory', 'time_created'],
  session_message: ['id', 'session_id', 'type', 'seq', 'time_created', 'data'],
});

/** How long a query waits on a lock the service holds before it gives up. */
const BUSY_TIMEOUT_MS = 2000;

/**
 * The provider whose steps record the input and cache of their last request
 * alone: a step of the Claude Agent SDK can span several of its messages, and
 * Open Code 2.3.0 sums their output but keeps only the last one's input.
 */
const LAST_MESSAGE_INPUT_PROVIDER = 'claude-agent';

/**
 * The fields of one message's `data`, as SQL can pull them out.
 */
const MESSAGES = `
select m.id, m.session_id, m.type, m.seq, m.time_created,
       json_extract(m.data, '$.time.created') as created,
       json_extract(m.data, '$.time.completed') as completed,
       json_extract(m.data, '$.model.providerID') as provider,
       json_extract(m.data, '$.model.id') as model,
       json_extract(m.data, '$.model.variant') as variant,
       json_extract(m.data, '$.status') as status,
       json_type(m.data, '$.tokens') as tokens,
       json_extract(m.data, '$.tokens.input') as input,
       json_extract(m.data, '$.tokens.output') as output,
       json_extract(m.data, '$.tokens.reasoning') as reasoning,
       json_extract(m.data, '$.tokens.cache.read') as cache_read,
       json_extract(m.data, '$.tokens.cache.write') as cache_write
from session_message m
where m.type in ('assistant', 'compaction')
  and m.session_id in (select value from json_each(:ids))
order by m.time_created, m.id`;

/** Every session, with where its fork's copies end, if it is a fork. */
const SESSIONS = `
select s.id, s.parent_id as parent, s.fork_session_id as fork_of, s.directory, s.time_created as created,
       json_extract(s.fork_boundary, '$.type') as boundary_type,
       (select b.seq from session_message b
          where b.session_id = s.fork_session_id
            and b.id = json_extract(s.fork_boundary, '$.messageID')) as boundary_seq
from session_v2 s`;

/** Every move of a session, in order. */
const MOVES = `
select session_id, seq,
       json_extract(data, '$.location.directory') as directory,
       json_extract(data, '$.previous.location.directory') as previous
from session_message
where type = 'location-switched'
order by session_id, seq`;

/**
 * What the database said about the calls of one repository.
 *
 * @typedef {object} Source
 * @property {string} db
 * @property {number} sessions            top-level sessions with a step in the repository
 * @property {number} subagentSessions    child sessions with a step in the repository
 * @property {number} steps               steps counted as calls
 * @property {number} unfinishedSteps     steps with no tokens: still running, or failed
 * @property {number} forkCopies          messages a fork copied from its source, not counted again
 * @property {number} elsewhereSteps      steps of those sessions taken outside the repository
 * @property {number} lastMessageInputSteps  steps whose input and cache are their last request's alone
 */

/**
 * A completed compaction: its tokens, apart from the calls.
 *
 * @typedef {object} Compaction
 * @property {string} at
 * @property {string|null} sessionId
 * @property {string|null} agent
 * @property {string} model
 * @property {import('./cost.js').Usage} usage
 */

/**
 * What a read found, before any attribution.
 *
 * @typedef {object} Scan
 * @property {import('./cost.js').Call[]} calls
 * @property {Compaction[]} compactions
 * @property {Source} source
 * @property {{reason: string}|null} skip   nothing was measured, and why
 */

/**
 * Where Open Code keeps its database: OPENCODE_DB if set (a relative name is
 * taken from Open Code's data directory), else `opencode.db` in that
 * directory, which is `$XDG_DATA_HOME/opencode`, or `~/.local/share/opencode`
 * on every platform. The name Open Code gives a database of a build that is
 * not a release (`opencode-<channel>.db`) is not guessed: `--db` names it.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null} null when OPENCODE_DB is `:memory:`, which keeps no file
 */
export function databasePath(env = process.env) {
  const data = env.XDG_DATA_HOME ? join(env.XDG_DATA_HOME, 'opencode') : join(homedir(), '.local', 'share', 'opencode');
  const named = env.OPENCODE_DB;
  if (named === ':memory:') return null;
  if (named) return isAbsolute(named) ? named : join(data, named);
  return join(data, 'opencode.db');
}

/**
 * node:sqlite, without the warning Node prints on its first import up to
 * 24.15 ("SQLite is an experimental feature"): that line would land in the
 * middle of a report on stderr, about a module this one only reads with.
 *
 * @returns {Promise<typeof import('node:sqlite')>}
 */
async function loadSqlite() {
  const emit = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
    const text = typeof warning === 'string' ? warning : warning?.message;
    const experimental = type === 'ExperimentalWarning' || warning?.name === 'ExperimentalWarning';
    if (experimental && /SQLite/i.test(String(text))) return undefined;
    return emit.call(this, warning, ...rest);
  };
  try {
    return await import('node:sqlite');
  } finally {
    process.emitWarning = emit;
  }
}

/**
 * Open the database for reading only.
 *
 * @param {string} file
 * @returns {Promise<{prepare: (sql: string) => {all: (...args: unknown[]) => object[]}, close: () => void}>}
 */
export async function openReadOnly(file) {
  const { DatabaseSync } = await loadSqlite();
  return new DatabaseSync(file, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
}

/**
 * The tables and columns this module reads that the database lacks.
 *
 * @param {{prepare: (sql: string) => {all: () => object[]}}} db
 * @returns {string[]} `table` or `table.column`, empty when all are there
 */
export function missingColumns(db) {
  const missing = [];
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const present = new Set(db.prepare(`pragma table_info(${table})`).all().map((row) => row.name));
    if (present.size === 0) {
      missing.push(table);
      continue;
    }
    for (const column of columns) if (!present.has(column)) missing.push(`${table}.${column}`);
  }
  return missing;
}

/**
 * Every spelling of a directory that can come back from the database: as
 * given, and resolved. Open Code records the directory the way the process
 * saw it, and on macOS the temporary directory sits behind a symbolic link.
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function spellings(dir) {
  const forms = new Set([resolve(dir)]);
  try {
    forms.add(await realpath(dir));
  } catch {
    // A directory that is not there now can still be where a session was.
  }
  return [...forms];
}

/**
 * Whether a directory is one of the roots or inside one.
 *
 * @param {string[]} roots
 * @returns {(dir: string|null|undefined) => boolean}
 */
function within(roots) {
  return (dir) => {
    if (typeof dir !== 'string' || dir === '') return false;
    const at = resolve(dir);
    return roots.some((root) => at === root || at.startsWith(root.endsWith(sep) ? root : root + sep));
  };
}

/**
 * The directory a session was in at a given message, from its moves.
 *
 * @param {{directory: string}} session
 * @param {Array<{seq: number, directory: string|null, previous: string|null}>} moves in order
 * @param {number} seq
 * @returns {string|null}
 */
function directoryAt(session, moves, seq) {
  if (moves.length === 0) return session.directory;
  let at = moves[0].previous;
  for (const move of moves) {
    if (move.seq >= seq) break;
    at = move.directory;
  }
  return at;
}

/**
 * Whether a message of a forked session is a copy of its source's.
 *
 * The copies are the messages up to the boundary the fork names — that one
 * included for `through`, excluded for `before`. When the boundary message
 * cannot be found in the source any longer, the copies are told by their
 * time: a copy keeps the time of the step it copies, which is before the fork
 * existed.
 *
 * @param {{fork_of: string|null, boundary_type: string|null, boundary_seq: number|null, created: number}} session
 * @param {{seq: number, created: number|null, time_created: number}} row
 * @returns {boolean}
 */
function isForkCopy(session, row) {
  if (!session.fork_of) return false;
  if (Number.isFinite(session.boundary_seq)) {
    if (session.boundary_type === 'through') return row.seq <= session.boundary_seq;
    if (session.boundary_type === 'before') return row.seq < session.boundary_seq;
  }
  return (row.created ?? row.time_created) < session.created;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function count(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * A model as Open Code names it, `provider/model`, with the variant when it is
 * not the default one.
 *
 * @param {{provider: string|null, model: string|null, variant: string|null}} row
 * @returns {string}
 */
export function modelName(row) {
  if (!row.provider || !row.model) return 'unknown';
  const variant = row.variant && row.variant !== 'default' ? `#${row.variant}` : '';
  return `${row.provider}/${row.model}${variant}`;
}

/**
 * @param {unknown} ms
 * @returns {string|null}
 */
function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Read the calls of one repository.
 *
 * @param {object} input
 * @param {string|null} input.db           the database file; null when there is none to read
 * @param {string} input.repoRoot          the clone
 * @param {object} [input.config]          for `worktrees.root`
 * @param {(file: string) => Promise<object>} [input.open]  opens the database read-only; node:sqlite by default
 * @returns {Promise<Scan>}
 */
export async function read(input) {
  /** @type {Scan} */
  const scan = {
    calls: [],
    compactions: [],
    source: {
      db: input.db,
      sessions: 0,
      subagentSessions: 0,
      steps: 0,
      unfinishedSteps: 0,
      forkCopies: 0,
      elsewhereSteps: 0,
      lastMessageInputSteps: 0,
    },
    skip: null,
  };

  if (input.db === null) {
    scan.skip = { reason: 'OPENCODE_DB is :memory:, so Open Code keeps no database file to read; pass --db <file>' };
    return scan;
  }
  try {
    await access(input.db);
  } catch {
    scan.skip = {
      reason:
        `no Open Code database at ${input.db} — another machine, or a different OPENCODE_DB or XDG_DATA_HOME; ` +
        'pass --db <file> if it is elsewhere',
    };
    return scan;
  }

  let db;
  try {
    db = await (input.open ?? openReadOnly)(input.db);
    const missing = missingColumns(db);
    if (missing.length > 0) {
      db.close();
      scan.skip = {
        reason:
          `the Open Code database at ${input.db} has no ${missing.join(', ')} — a schema this reader does not know ` +
          '(it reads the one of Open Code 2.3.0); nothing was measured',
      };
      return scan;
    }
  } catch (error) {
    db?.close();
    scan.skip = { reason: `the Open Code database at ${input.db} could not be read: ${error.message}` };
    return scan;
  }

  try {
    const worktrees = get(input.config ?? {}, 'worktrees.root');
    const roots = [
      ...(await spellings(input.repoRoot)),
      ...(typeof worktrees === 'string' && worktrees !== '' ? await spellings(resolve(input.repoRoot, worktrees)) : []),
    ];
    const inRepo = within(roots);

    /** @type {Map<string, object>} */
    const sessions = new Map(db.prepare(SESSIONS).all().map((row) => [row.id, row]));
    /** @type {Map<string, Array<{seq: number, directory: string|null, previous: string|null}>>} */
    const moves = new Map();
    for (const row of db.prepare(MOVES).all()) {
      if (!moves.has(row.session_id)) moves.set(row.session_id, []);
      moves.get(row.session_id).push(row);
    }

    // Only the sessions that were ever in the repository are read further.
    const candidates = [...sessions.values()]
      .filter((session) => {
        if (inRepo(session.directory)) return true;
        return (moves.get(session.id) ?? []).some((move) => inRepo(move.directory) || inRepo(move.previous));
      })
      .map((session) => session.id);

    const rootOf = (id) => {
      let session = sessions.get(id);
      const seen = new Set();
      while (session?.parent && sessions.has(session.parent) && !seen.has(session.id)) {
        seen.add(session.id);
        session = sessions.get(session.parent);
      }
      return session?.id ?? id;
    };

    const tops = new Set();
    const children = new Set();

    for (const row of db.prepare(MESSAGES).all({ ids: JSON.stringify(candidates) })) {
      const session = sessions.get(row.session_id);
      if (isForkCopy(session, row)) {
        scan.source.forkCopies += 1;
        continue;
      }

      const taken = row.type === 'assistant';
      if (!inRepo(directoryAt(session, moves.get(session.id) ?? [], row.seq))) {
        if (taken) scan.source.elsewhereSteps += 1;
        continue;
      }

      if (session.parent) children.add(session.id);
      else tops.add(session.id);

      const sessionId = rootOf(session.id);
      const agent = session.parent ? session.id : null;
      const model = modelName(row);
      const usage = {
        input: count(row.input),
        cacheRead: count(row.cache_read),
        cacheWrite: count(row.cache_write),
        output: count(row.output) + count(row.reasoning),
      };

      if (!taken) {
        if (row.status === 'completed') {
          scan.compactions.push({ at: iso(row.created ?? row.time_created), sessionId, agent, model, usage });
        }
        continue;
      }

      if (row.tokens !== 'object') {
        scan.source.unfinishedSteps += 1;
        continue;
      }

      scan.source.steps += 1;
      if (row.provider === LAST_MESSAGE_INPUT_PROVIDER) scan.source.lastMessageInputSteps += 1;
      scan.calls.push({ at: iso(row.completed ?? row.created ?? row.time_created), model, sessionId, agent, usage });
    }

    scan.source.sessions = tops.size;
    scan.source.subagentSessions = children.size;
  } finally {
    db.close();
  }

  return scan;
}
