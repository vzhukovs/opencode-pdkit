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

// What the running Open Code server says about a directory.
//
// Some of what `pdkit doctor` asks has its answer in the server and nowhere
// else: the server merges every config document a directory has, starts the
// MCP servers they name, and appends the person's own rules to every agent's,
// the plugin's agents included. So the doctor asks the server, through
// `opencode api`, and this module is where lib/ does that and where the shapes
// of the answers are known.
//
// Two things about asking, both measured on Open Code 2.3.0:
//
//   - `opencode api` talks to the background service, and starts it if none is
//     running. A private server (`--standalone`) answers before it has read
//     any config, so it is never used.
//   - The service loads a directory on the first question about it and does
//     not wait for that to finish. The config documents are there at once; the
//     MCP servers and the plugins' agents come about a second later. An empty
//     answer is a reason to ask again, not an answer — hence waitFor.

import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

/** The header that tells the server which directory a request is about. Without it, the service's own. */
export const DIRECTORY_HEADER = 'x-opencode-directory';

/** How long to wait for a directory the server is still loading. Measured: about a second. */
export const WAIT_MS = 5000;

/** Between two questions while waiting. */
const PAUSE_MS = 250;

/**
 * @typedef {{ok: true, data: any} | {ok: false, error: string}} Answer
 */

/**
 * Ask the server a GET question about a directory.
 *
 * `opencode api` prints the body on stdout either way; a status other than
 * 2xx exits 1 with `HTTP <code> <text>` on stderr, and so does a server it
 * cannot reach, with its own message there.
 *
 * @param {string} path e.g. `/api/mcp`
 * @param {{directory: string, exec?: Function}} options
 * @returns {Promise<Answer>}
 */
export async function get(path, options) {
  const runner = options.exec ?? execFile;

  const result = await new Promise((resolve) => {
    runner(
      'opencode',
      ['api', 'GET', path, '-H', `${DIRECTORY_HEADER}:${options.directory}`],
      { encoding: 'utf8', timeout: 15000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }),
    );
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') return { ok: false, error: 'opencode: not found' };
    const said = result.stderr.split('\n').map((line) => line.trim()).find(Boolean);
    return { ok: false, error: `opencode api GET ${path}: ${said ?? String(result.error.message).split('\n')[0]}` };
  }

  try {
    return { ok: true, data: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, error: `opencode api GET ${path}: not JSON: ${result.stdout.trim().slice(0, 80)}` };
  }
}

/**
 * Ask until the answer is the one being waited for, or the time is up.
 *
 * Returns the last answer either way: a failed question is returned at once,
 * since asking again does not change why it failed, and an answer still not
 * settled when the time is up is the caller's to describe.
 *
 * @param {() => Promise<Answer>} ask
 * @param {(data: any) => boolean} settled
 * @param {{wait?: number, pause?: (ms: number) => Promise<unknown>, now?: () => number}} [options]
 * @returns {Promise<Answer & {settled: boolean}>}
 */
export async function waitFor(ask, settled, options = {}) {
  const wait = options.wait ?? WAIT_MS;
  const pause = options.pause ?? sleep;
  const now = options.now ?? Date.now;
  const until = now() + wait;

  for (;;) {
    const answer = await ask();
    if (!answer.ok) return { ...answer, settled: false };
    if (settled(answer.data)) return { ...answer, settled: true };
    if (now() >= until) return { ...answer, settled: false };
    await pause(PAUSE_MS);
  }
}

/**
 * The MCP servers a directory's config turns on, by name, from the answer to
 * `GET /api/config`: the documents of every layer, in the order the server
 * read them.
 *
 * Open Code takes each server whole from the last document that names it,
 * and a server that document disables is not started. What is kept is the
 * command line — the only place it is, since the status says nothing of it —
 * and none of `environment`, whose values are the person's.
 *
 * @param {unknown} documents
 * @returns {Map<string, {command: string}>} name → the command, or the URL of a remote server
 */
export function mcpServers(documents) {
  /** @type {Map<string, any>} */
  const last = new Map();
  for (const entry of Array.isArray(documents) ? documents : []) {
    if (entry?.type !== 'document') continue;
    for (const [name, server] of Object.entries(entry.info?.mcp?.servers ?? {})) last.set(name, server);
  }

  const servers = new Map();
  for (const [name, server] of last) {
    if (server?.disabled === true) continue;
    const command = Array.isArray(server?.command) ? server.command.join(' ') : String(server?.url ?? '');
    servers.set(name, { command });
  }
  return servers;
}

/**
 * What the server says each MCP server is doing, from the answer to
 * `GET /api/mcp`: `connected`, `pending`, `disabled`, or `failed` and
 * `needs_auth`, each with an error.
 *
 * @param {unknown} answer
 * @returns {Map<string, {status: string, error?: string}>}
 */
export function mcpStatuses(answer) {
  const statuses = new Map();
  for (const server of Array.isArray(answer?.data) ? answer.data : []) {
    if (typeof server?.name !== 'string') continue;
    const status = String(server.status?.status ?? '');
    const error = server.status?.error;
    statuses.set(server.name, typeof error === 'string' && error !== '' ? { status, error } : { status });
  }
  return statuses;
}

/**
 * The rules an agent ends up with, from the answer to `GET /api/agent`:
 * its own, then those of every config document, appended.
 *
 * @param {unknown} answer
 * @param {string} id
 * @returns {Array<{action: string, resource: string, effect: string}> | undefined} undefined: no such agent here
 */
export function agentRules(answer, id) {
  const agent = (Array.isArray(answer?.data) ? answer.data : []).find((entry) => entry?.id === id);
  return agent === undefined ? undefined : Array.isArray(agent.permissions) ? agent.permissions : [];
}

/**
 * The prefix of the tools an MCP server gives a model: `<server>_`, with every
 * character but letters, digits, `_` and `-` made `_`, as Open Code names them.
 *
 * @param {string} server
 * @returns {string}
 */
export function toolPrefix(server) {
  return `${server.replace(/[^A-Za-z0-9_-]/g, '_')}_`;
}

/**
 * Whether a name fits a pattern of a rule: `*` is any run of characters, `?`
 * one, a trailing ` *` also matches nothing, and the whole name has to fit. On
 * Windows, without regard to case. Open Code's own matching (Wildcard.match).
 *
 * @param {string} input
 * @param {string} pattern
 * @returns {boolean}
 */
export function wildcard(input, pattern) {
  let escaped = String(pattern)
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  if (escaped.endsWith(' .*')) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, process.platform === 'win32' ? 'si' : 's').test(String(input).replaceAll('\\', '/'));
}

/**
 * The rule that takes a tool away from an agent, if one does.
 *
 * Open Code offers a tool unless the last rule whose action fits the tool's
 * name denies it on every resource; such a tool is not in the model's list at
 * all.
 *
 * @param {string} tool
 * @param {ReadonlyArray<{action: string, resource: string, effect: string}>} rules
 * @returns {{action: string, resource: string, effect: string} | undefined}
 */
export function takenBy(tool, rules) {
  const rule = rules.findLast((entry) => wildcard(tool, entry.action));
  return rule?.resource === '*' && rule.effect === 'deny' ? rule : undefined;
}
