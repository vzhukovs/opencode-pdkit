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
// else: the server merges every config document a directory has, loads the
// plugins they add (this one among them, or not), starts the MCP servers they
// name, and appends the person's own rules to every agent's, the plugin's
// agents included. So the doctor asks the server, through
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
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

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
 * @typedef {{providerID: string, id: string, variant?: string}} ModelRef
 */

/**
 * @param {unknown} model `{ providerID, <idKey>, variant? }`
 * @param {string} idKey where the model's own ID is: `id` on an agent, `model` in a config document
 * @returns {ModelRef|undefined}
 */
function refOf(model, idKey) {
  const providerID = model?.providerID;
  const id = model?.[idKey];
  if (typeof providerID !== 'string' || typeof id !== 'string') return undefined;
  return typeof model.variant === 'string' ? { providerID, id, variant: model.variant } : { providerID, id };
}

/**
 * The model each agent ends up with, from the answer to `GET /api/agent`:
 * the plugin's, or what Open Code's config and agent files put over it.
 * `null` is an agent with no model, which runs on the model of the session
 * that calls it.
 *
 * @param {unknown} answer
 * @returns {Map<string, ModelRef|null>} by agent ID
 */
export function agentModels(answer) {
  const models = new Map();
  for (const agent of Array.isArray(answer?.data) ? answer.data : []) {
    if (typeof agent?.id === 'string') models.set(agent.id, refOf(agent.model, 'id') ?? null);
  }
  return models;
}

/**
 * What the config documents say about agents by ID, from the answer to
 * `GET /api/config`: the model of `agents.<id>.model` and the document it is
 * in, and the document that sets `agents.<id>.disabled`. The last document
 * that says it wins, as Open Code reads them: a project's over the person's.
 *
 * A document's `info` is what Open Code read, not what was written: a model
 * comes as `{ providerID, model, variant }`, and an `agents.<id>` whose model
 * is not `provider/model#variant` is not there at all — Open Code drops the
 * whole entry and says so only in its log (F229).
 *
 * @param {unknown} documents
 * @returns {Map<string, {model?: {ref: ModelRef, document: string}, disabled?: string}>}
 */
export function configuredAgents(documents) {
  const agents = new Map();
  for (const file of Array.isArray(documents) ? documents : []) {
    if (file?.type !== 'document') continue;
    for (const [id, agent] of Object.entries(file.info?.agents ?? {})) {
      const known = agents.get(id) ?? {};
      const ref = refOf(agent?.model, 'model');
      if (ref) known.model = { ref, document: String(file.path) };
      if (agent?.disabled === true) known.disabled = String(file.path);
      agents.set(id, known);
    }
  }
  return agents;
}

/**
 * The models Open Code can use for a directory, from the answer to
 * `GET /api/model`, with what the catalog check reads of each and nothing
 * more: an entry also carries its provider's settings, keys included.
 *
 * @param {unknown} answer
 * @returns {Array<{providerID: string, id: string, modelID?: string, enabled?: boolean, variants: Array<{id: string}>}>}
 */
export function catalog(answer) {
  const models = [];
  for (const entry of Array.isArray(answer?.data) ? answer.data : []) {
    if (typeof entry?.providerID !== 'string' || typeof entry.id !== 'string') continue;
    const model = { providerID: entry.providerID, id: entry.id };
    if (typeof entry.modelID === 'string') model.modelID = entry.modelID;
    if (typeof entry.enabled === 'boolean') model.enabled = entry.enabled;
    model.variants = (Array.isArray(entry.variants) ? entry.variants : [])
      .filter((variant) => typeof variant?.id === 'string')
      .map((variant) => ({ id: variant.id }));
    models.push(model);
  }
  return models;
}

/**
 * A `plugins` entry's target as Open Code loads it: a `file://` URL as its
 * path, a relative path from the document's directory, anything else as it is
 * (src/config/plugin/source.ts).
 *
 * @param {string} target
 * @param {string} document
 * @returns {string}
 */
function configuredTarget(target, document) {
  if (target.startsWith('file://')) return fileURLToPath(target);
  if (target.startsWith('./') || target.startsWith('../')) return resolvePath(dirname(document), target);
  return target;
}

/**
 * The entry whose `options` Open Code hands a plugin, from the answer to
 * `GET /api/config`, for a plugin known by `name` — its ID, which is also its
 * package's name — and the entries that add it whose options it does not.
 *
 * Open Code goes through the `plugins` of every document in the order it read
 * them (src/plugin/supervisor.ts; F317). The first entry that adds the plugin
 * loads it, with that entry's options. A later entry with the same target
 * loads it again with its own, and replaces it — unless the target is the
 * plugin's ID, which then only turns on the plugin already loaded. A later
 * entry with another target loads a second copy, which Open Code refuses:
 * "Duplicate plugin ID". An entry adds the plugin when its target names it,
 * as in turnedOff. Whether the plugin runs at all is the `plugin` check's
 * question.
 *
 * @param {unknown} documents
 * @param {string} name
 * @returns {{
 *   entry?: {document: string, target: string, options: unknown},
 *   unread: Array<{document: string, target: string, why: string}>,
 * }} `unread`: the entries that add the plugin with options it is not handed
 */
export function pluginEntry(documents, name) {
  let entry;
  const unread = [];
  const skip = (dropped, why) => {
    if (dropped.options !== undefined) unread.push({ document: dropped.document, target: dropped.target, why });
  };
  for (const file of Array.isArray(documents) ? documents : []) {
    if (file?.type !== 'document') continue;
    const document = String(file.path);
    for (const raw of Array.isArray(file.info?.plugins) ? file.info.plugins : []) {
      const written = typeof raw === 'string' ? raw : raw?.package;
      if (typeof written !== 'string' || written.startsWith('-') || !written.includes(name)) continue;
      const added = { document, target: configuredTarget(written, document), options: typeof raw === 'string' ? undefined : raw.options };
      if (entry === undefined) entry = added;
      else if (added.target === name) skip(added, `it names the plugin by its ID, which only turns on the one ${entry.document} loads`);
      else if (added.target === entry.target) {
        skip(entry, `${added.document} names the same target later, and Open Code loads it with the options there`);
        entry = added;
      } else skip(added, `${entry.document} loads the plugin first, and Open Code refuses a second copy`);
    }
  }
  return entry === undefined ? { unread } : { entry, unread };
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

/**
 * @typedef {object} PluginRecord
 * @property {string} [id] missing on a plugin that failed to load: the ID is what loading it would have told
 * @property {boolean} builtin one of Open Code's own
 * @property {string} source where it comes from: a package's target, a local plugin's path; '' for a built-in one
 * @property {string} [version] a package's
 * @property {true} [outdated] a package with a newer version published, which Open Code looks for when it loads the
 *   plugin and once a day, and does not install by itself
 * @property {string} status `active`, or `failed` with an error and a ref to the server's log
 * @property {string} [error]
 * @property {string} [ref]
 */

/**
 * The plugins Open Code runs for a directory, from the answer to
 * `GET /api/plugin`, in the order their hooks run: Open Code's own first (the
 * one that repairs a tool call is always the first), then the ones the config
 * adds, then its own again. A plugin a config document removes, or a policy
 * keeps from loading, is not in the list at all; one that failed to load is,
 * as `failed`. An empty list is a directory the server is still loading.
 *
 * @param {unknown} answer
 * @returns {PluginRecord[]}
 */
export function plugins(answer) {
  const records = [];
  for (const entry of Array.isArray(answer?.data) ? answer.data : []) {
    const source = entry?.source ?? {};
    const record = {
      builtin: source.type === 'builtin',
      source: String(source.path ?? source.target ?? ''),
      status: String(entry?.state?.status ?? ''),
    };
    if (typeof entry?.id === 'string') record.id = entry.id;
    if (typeof source.version === 'string') record.version = source.version;
    if (source.outdated === true) record.outdated = true;
    if (typeof entry?.state?.error === 'string') record.error = entry.state.error;
    if (typeof entry?.state?.ref === 'string') record.ref = entry.state.ref;
    records.push(record);
  }
  return records;
}

/**
 * What Open Code loads for a `plugins` entry, and checks a policy against:
 * a path as it is, a relative one from the document's directory, a package
 * without its version. Open Code's own reading (src/plugin/module.ts).
 *
 * @param {string} target
 * @param {string} document the config document the entry is in
 * @returns {string}
 */
function loadTarget(target, document) {
  if (target.startsWith('./') || target.startsWith('../')) return resolvePath(dirname(document), target);
  const at = target.lastIndexOf('@');
  return isAbsolute(target) || at <= 0 ? target : target.slice(0, at);
}

/**
 * Where the config of a directory turns a plugin off, from the answer to
 * `GET /api/config`, for a plugin known by `name` — its ID, which is also the
 * name of its package.
 *
 * Three ways, all silent in Open Code (F212): `-<ID>` in the `plugins` of any
 * document (`removed`); a `plugin.use` policy whose last word on an entry that
 * adds the plugin is `deny` (`denied`) — decided as Open Code decides it,
 * every document's policies with the earliest document's last; and, for what
 * is left to say, the entries that do add it (`added`). An entry adds it when
 * its target names it: the package, a tarball or a directory named after it.
 * One under another name is not found here.
 *
 * @param {unknown} documents
 * @param {string} name
 * @returns {{
 *   removed: string[],
 *   denied: Array<{document: string, resource: string, target: string}>,
 *   added: Array<{document: string, target: string}>,
 * }} documents by path
 */
export function turnedOff(documents, name) {
  const files = (Array.isArray(documents) ? documents : []).filter((entry) => entry?.type === 'document');
  const removed = [];
  const added = [];
  for (const file of files) {
    for (const entry of Array.isArray(file.info?.plugins) ? file.info.plugins : []) {
      const target = typeof entry === 'string' ? entry : entry?.package;
      if (typeof target !== 'string') continue;
      if (target.startsWith('-')) {
        if (target.slice(1) === name) removed.push(String(file.path));
      } else if (target.includes(name)) {
        added.push({ document: String(file.path), target });
      }
    }
  }

  const statements = files
    .toReversed()
    .flatMap((file) => (Array.isArray(file.info?.policies) ? file.info.policies : []).map((policy) => ({ ...policy, document: String(file.path) })));
  const denied = [];
  for (const { document, target } of added) {
    const loaded = loadTarget(target, document);
    const rule = statements.findLast((policy) => policy?.action === 'plugin.use' && wildcard(loaded, String(policy.resource)));
    if (rule?.effect === 'deny') denied.push({ document: rule.document, resource: String(rule.resource), target });
  }

  return { removed, denied, added };
}
