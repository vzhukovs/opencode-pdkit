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

// Open Code's session data, from the SQLite database Open Code keeps for every
// project of the user: the calls of one repository, one call per step, for
// `pdkit cost`; and the subagents that ran in it, for `pdkit doctor`.
//
// A source of facts and nothing else. What a call cost, which issue and phase
// it belongs to, and how the report reads are lib/cost.js's; what a subagent
// that left no agent-done means is lib/doctor.js's.
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
 * The columns the calls are read from, table by table. Anything missing makes
 * the database one of a schema this module does not know.
 */
export const REQUIRED_COLUMNS = Object.freeze({
  session_v2: ['id', 'parent_id', 'fork_session_id', 'fork_boundary', 'directory', 'time_created'],
  session_message: ['id', 'session_id', 'type', 'seq', 'time_created', 'data'],
});

/** The columns the subagent runs are read from, the same way. */
export const RUN_COLUMNS = Object.freeze({
  session_v2: ['id', 'parent_id', 'agent', 'directory', 'time_created', 'idle_outcome'],
  session_message: ['session_id', 'type', 'seq', 'data'],
});

/**
 * How Open Code 2.3.0 records the end of a session's last execution:
 * `succeeded`, `failed` or `interrupted`, and nothing while it runs or after
 * the service shut down under it. A session that `succeeded` finished its
 * model's work with nothing waiting, which is when Open Code calls the
 * `experimental.idle` hook the subagent-stop hook stands on — before the
 * outcome is written. A failed or interrupted one may never have got there.
 */
const STOPPED = 'succeeded';

/** Every outcome Open Code 2.3.0 records. */
const OUTCOMES = new Set([STOPPED, 'failed', 'interrupted']);

/**
 * What `pdkit cost` can do about a database it cannot read, by kind: its
 * `--db` names another file.
 *
 * @type {Record<Unread['kind'], string>}
 */
const CALLS_ADVICE = {
  memory: '; pass --db <file>',
  absent: '; pass --db <file> if it is elsewhere',
  schema: '; nothing was measured',
  unreadable: '',
};

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

/** The subagent sessions started since a time, oldest first. */
const CHILDREN = `
select id, agent, directory, time_created as created, idle_outcome as outcome
from session_v2
where parent_id is not null and time_created >= :since
order by time_created, id`;

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
 * The tables and columns a reader reads that the database lacks.
 *
 * @param {{prepare: (sql: string) => {all: () => object[]}}} db
 * @param {Readonly<Record<string, string[]>>} [required] the calls' columns when not given
 * @returns {string[]} `table` or `table.column`, empty when all are there
 */
export function missingColumns(db, required = REQUIRED_COLUMNS) {
  const missing = [];
  for (const [table, columns] of Object.entries(required)) {
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
 * Why a database cannot be read, by kind, so that each reader can say what
 * its own caller can do about it.
 *
 * @typedef {{kind: 'memory'|'absent'|'schema'|'unreadable', reason: string}} Unread
 */

/**
 * Open the database read-only, once it is known to have what a reader reads.
 *
 * @param {string|null} file  null when OPENCODE_DB is `:memory:`
 * @param {Readonly<Record<string, string[]>>} required
 * @param {((file: string) => Promise<object>)|undefined} open
 * @returns {Promise<{db: {prepare: Function, close: () => void}, unread?: undefined} | {db?: undefined, unread: Unread}>}
 */
async function openChecked(file, required, open) {
  if (file === null) {
    return { unread: { kind: 'memory', reason: 'OPENCODE_DB is :memory:, so Open Code keeps no database file to read' } };
  }
  try {
    await access(file);
  } catch {
    return {
      unread: { kind: 'absent', reason: `no Open Code database at ${file} — another machine, or a different OPENCODE_DB or XDG_DATA_HOME` },
    };
  }

  let db;
  try {
    db = await (open ?? openReadOnly)(file);
    const missing = missingColumns(db, required);
    if (missing.length === 0) return { db };
    db.close();
    return {
      unread: {
        kind: 'schema',
        reason:
          `the Open Code database at ${file} has no ${missing.join(', ')} — a schema this reader does not know ` +
          '(it reads the one of Open Code 2.3.0)',
      },
    };
  } catch (error) {
    db?.close();
    return { unread: { kind: 'unreadable', reason: `the Open Code database at ${file} could not be read: ${error.message}` } };
  }
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
 * Whether a directory is the repository's: the clone, anything under it, or
 * under `worktrees.root`. A sibling whose name starts with the clone's is not.
 *
 * @param {string} repoRoot
 * @param {object} [config]  for `worktrees.root`
 * @returns {Promise<(dir: string|null|undefined) => boolean>}
 */
async function repository(repoRoot, config) {
  const worktrees = get(config ?? {}, 'worktrees.root');
  return within([
    ...(await spellings(repoRoot)),
    ...(typeof worktrees === 'string' && worktrees !== '' ? await spellings(resolve(repoRoot, worktrees)) : []),
  ]);
}

/**
 * Whether a session was ever in the repository: where it is now, or where
 * any of its moves took it from or to.
 *
 * @param {(dir: string|null|undefined) => boolean} inRepo
 * @param {{directory: string|null}} session
 * @param {Array<{directory: string|null, previous: string|null}>} moves
 * @returns {boolean}
 */
function everIn(inRepo, session, moves) {
  return inRepo(session.directory) || moves.some((move) => inRepo(move.directory) || inRepo(move.previous));
}

/**
 * The moves of every session, in order, by session.
 *
 * @param {{prepare: (sql: string) => {all: () => object[]}}} db
 * @returns {Map<string, Array<{seq: number, directory: string|null, previous: string|null}>>}
 */
function movesOf(db) {
  const moves = new Map();
  for (const row of db.prepare(MOVES).all()) {
    if (!moves.has(row.session_id)) moves.set(row.session_id, []);
    moves.get(row.session_id).push(row);
  }
  return moves;
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

  const { db, unread } = await openChecked(input.db, REQUIRED_COLUMNS, input.open);
  if (unread) {
    scan.skip = { reason: `${unread.reason}${CALLS_ADVICE[unread.kind]}` };
    return scan;
  }

  try {
    const inRepo = await repository(input.repoRoot, input.config);

    /** @type {Map<string, object>} */
    const sessions = new Map(db.prepare(SESSIONS).all().map((row) => [row.id, row]));
    const moves = movesOf(db);

    // Only the sessions that were ever in the repository are read further.
    const candidates = [...sessions.values()]
      .filter((session) => everIn(inRepo, session, moves.get(session.id) ?? []))
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

/**
 * One subagent's run: a child session, which is one agent run (one child per
 * run, as above).
 *
 * @typedef {object} SubagentRun
 * @property {string} id
 * @property {string|null} agent        the agent Open Code ran it as
 * @property {string} created           when it started
 * @property {'succeeded'|'failed'|'interrupted'|null} outcome  how its last execution ended; null while it runs
 * @property {boolean} stopped          it finished its work, so Open Code has called the hook a subagent's stop is caught with
 */

/**
 * Read the subagents that ran in one repository since a time.
 *
 * A child session counts for the repository when it was ever in it — where
 * it is now, or where a move took it — by the same rule as the calls. Its
 * parent's directory does not matter: a subagent runs where it was started.
 *
 * @param {object} input
 * @param {string|null} input.db           the database file; null when there is none to read
 * @param {string} input.repoRoot          the clone
 * @param {object} [input.config]          for `worktrees.root`
 * @param {number} input.since             milliseconds; runs started earlier are not read
 * @param {(file: string) => Promise<object>} [input.open]  opens the database read-only; node:sqlite by default
 * @returns {Promise<{db: string|null, runs: SubagentRun[], skip: {reason: string}|null}>}  runs oldest first
 */
export async function readSubagentRuns(input) {
  const { db, unread } = await openChecked(input.db, RUN_COLUMNS, input.open);
  if (unread) return { db: input.db, runs: [], skip: { reason: unread.reason } };

  try {
    const inRepo = await repository(input.repoRoot, input.config);
    const moves = movesOf(db);
    const runs = db
      .prepare(CHILDREN)
      .all({ since: input.since })
      .filter((row) => everIn(inRepo, row, moves.get(row.id) ?? []))
      .map((row) => ({
        id: row.id,
        agent: typeof row.agent === 'string' && row.agent !== '' ? row.agent : null,
        created: iso(row.created),
        outcome: OUTCOMES.has(row.outcome) ? row.outcome : null,
        stopped: row.outcome === STOPPED,
      }));
    return { db: input.db, runs, skip: null };
  } finally {
    db.close();
  }
}
