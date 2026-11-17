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

// Claude Code's transcripts, read into calls: one JSON line per message,
// carrying `message.usage`, under ~/.claude/projects/<slug of the directory>.
//
// One source of calls and nothing else. What a call cost, which issue and
// phase it belongs to, and how the report reads are lib/cost.js's.
//
// TODO(T7.2): only `pdkit cost --planning` reads this now; it goes once
// lib/planning.js reads Open Code's session data as lib/cost.js does.
//
// Two things about the transcripts that the first analysis got wrong, and that
// this module exists partly to get right:
//
//   - One API response is written as several lines, one per content block
//     (thinking, text, tool_use), and every one of them carries the same
//     `message.usage`. Summing lines counts most calls two or three times. Calls
//     are counted once per `message.id`; the lines dropped are reported.
//   - A subagent's calls are not in the session file. They are in
//     `<session>/subagents/agent-<id>.jsonl`, and a reader of the top-level
//     files alone never sees them. They are read, and kept apart: the split
//     between parent and subagent is by file, because `isSidechain` is absent
//     from a third of the parent's lines and cannot be relied on.

import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { get } from './config.js';

/**
 * What a scan of the transcripts found, before any attribution.
 *
 * @typedef {object} Scan
 * @property {import('./cost.js').Call[]} calls
 * @property {Array<{at: string, sessionId: string|null}>} compactions
 * @property {string[]} dirs            the directories asked for
 * @property {string[]} missing         those of them that do not exist
 * @property {number} files             session files read
 * @property {number} subagentFiles     subagent files read
 * @property {number} duplicateLines    lines dropped as a repeat of a call already counted
 * @property {number} unreadableLines   lines that were not JSON
 */

/**
 * Claude Code's project directory name for a working directory: every
 * character that is not a letter or a digit becomes a dash.
 *
 * @param {string} path absolute
 * @returns {string}
 */
export function slugOf(path) {
  return String(path).replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Where Claude Code keeps its transcripts. CLAUDE_CONFIG_DIR moves the whole
 * configuration, transcripts included.
 *
 * @returns {string}
 */
export function projectsRoot() {
  const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(base, 'projects');
}

/**
 * The transcript directories that belong to a repository: its own, and one per
 * worktree under `worktrees.root`, since a session opened in a worktree is
 * filed under the worktree's path.
 *
 * @param {{repoRoot: string, config?: object, root?: string}} input
 * @returns {Promise<string[]>}
 */
export async function transcriptDirs(input) {
  const root = input.root ?? projectsRoot();
  const dirs = [join(root, slugOf(input.repoRoot))];

  const worktrees = get(input.config ?? {}, 'worktrees.root');
  if (typeof worktrees === 'string' && worktrees !== '') {
    const prefix = `${slugOf(resolve(input.repoRoot, worktrees))}-`;
    try {
      for (const name of (await readdir(root)).sort()) {
        if (name.startsWith(prefix)) dirs.push(join(root, name));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  return dirs;
}

/**
 * The four counters of a `message.usage`, with anything absent or not a number
 * read as zero.
 *
 * Older lines carry no cache fields at all, and `undefined + 1` is NaN — which
 * would then poison every sum it reached without an error anywhere.
 *
 * @param {object|undefined} raw
 * @returns {import('./cost.js').Usage}
 */
export function readUsage(raw) {
  const count = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
  return {
    input: count(raw?.input_tokens),
    cacheRead: count(raw?.cache_read_input_tokens),
    cacheWrite: count(raw?.cache_creation_input_tokens),
    output: count(raw?.output_tokens),
  };
}

/**
 * Read one transcript file line by line into the scan.
 *
 * Line by line because the corpus is tens of megabytes and grows with every
 * session; reading whole files would hold all of it at once for no reason.
 *
 * @param {string} file
 * @param {string|null} agent
 * @param {Scan} scan
 * @param {Set<string>} seen ids of calls already counted
 */
async function readTranscript(file, agent, scan, seen) {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.trim()) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      scan.unreadableLines += 1;
      continue;
    }

    if (record?.isCompactSummary === true && record.timestamp) {
      scan.compactions.push({ at: record.timestamp, sessionId: record.sessionId ?? null });
    }

    const usage = record?.message?.usage;
    if (!usage || !record.timestamp) continue;

    // One response, several lines, the same usage on each. The id is the
    // API's, so it is unique across sessions too — which also stops a resumed
    // session that copied its history from being counted twice.
    const id = record.message.id ?? record.requestId ?? null;
    if (id !== null) {
      if (seen.has(id)) {
        scan.duplicateLines += 1;
        continue;
      }
      seen.add(id);
    }

    scan.calls.push({
      at: record.timestamp,
      model: String(record.message.model ?? 'unknown'),
      sessionId: record.sessionId ?? null,
      agent: agent ?? record.agentId ?? null,
      usage: readUsage(usage),
    });
  }
}

/**
 * Read every call in the given transcript directories.
 *
 * Session files are the `*.jsonl` at the top of each directory; subagent files
 * are `<session>/subagents/*.jsonl` beneath it. A directory that does not exist
 * is listed in `missing` rather than thrown about — another machine, a cleared
 * cache or a different CLAUDE_CONFIG_DIR are ordinary, and the caller decides
 * what an absence means.
 *
 * @param {string[]} dirs
 * @returns {Promise<Scan>}
 */
export async function scan(dirs) {
  /** @type {Scan} */
  const result = {
    calls: [],
    compactions: [],
    dirs: [...dirs],
    missing: [],
    files: 0,
    subagentFiles: 0,
    duplicateLines: 0,
    unreadableLines: 0,
  };
  const seen = new Set();

  for (const dir of dirs) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        result.missing.push(dir);
        continue;
      }
      throw error;
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        result.files += 1;
        await readTranscript(join(dir, entry.name), null, result, seen);
        continue;
      }
      if (!entry.isDirectory()) continue;

      const subagents = join(dir, entry.name, 'subagents');
      let agents;
      try {
        agents = (await readdir(subagents)).filter((name) => name.endsWith('.jsonl')).sort();
      } catch {
        continue;
      }
      for (const name of agents) {
        result.subagentFiles += 1;
        await readTranscript(join(subagents, name), name.replace(/^agent-/, '').replace(/\.jsonl$/, ''), result, seen);
      }
    }
  }

  return result;
}
