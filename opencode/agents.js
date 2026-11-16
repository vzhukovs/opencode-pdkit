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

// The agents: agents/*.md registered with Open Code, each on its own model.
//
// Claude Code read agents/ from the plugin directory by itself. Open Code
// reads agent files only from its own config directories, so the plugin adds
// its agents through ctx.agent.transform instead, one for each file:
//
//   name:          the agent's ID, as it is. Open Code reports an agent by the
//                  ID it was registered under, with no prefix, and the receipt
//                  gate knows the implementer by that ID: registered under
//                  another, the implementer would be let go as any agent is;
//   description:   the line the model choosing a subagent reads;
//   mode:          subagent. Left out, an agent is a primary one, which a
//                  subagent call refuses to run;
//   model:         see below;
//   tools:         the permissions. Each tool becomes the action Open Code
//                  checks it by, after a first rule that denies everything:
//                  what the agent was not given, it does not see. To read the
//                  plugin's files and the plans under $PDKIT_HOME, every agent
//                  gets those two directories too (opencode/access.js);
//   the body:      the system prompt, with ${CLAUDE_PLUGIN_ROOT} spelled out:
//                  Open Code has no such variable, and the model reads the
//                  files the prompt names by their absolute path.
//
// The model is the user's choice in the plugin's options, `models.<id>`, then
// the `model:` of the frontmatter, then none: an agent without one runs on the
// model of the session that calls it. Open Code applies `agents.<id>.model`
// from its own config after every plugin, and that wins; this file does not
// fight it. A value that is not provider/model#variant is dropped and the
// agent keeps its default; so is a key that names no agent or command. Both
// go to the log, since a setting that silently does nothing looks like one
// that works.
//
// The files are read once, in setup(). Open Code calls the transform again on
// every change to its config and to its agent files, without setup(); each
// call only applies what was read. It must not throw: Open Code disables a
// plugin whose transform fails, and with it the gate.

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { resolveHome } from '../lib/config.js';
import { parse } from '../lib/yaml.js';
import { directoryRule } from './access.js';
import { PREFIX } from './commands.js';
import { modelRef } from './options.js';

/** How a prompt names the plugin's root. Claude Code expanded it; the registrar does here. */
export const ROOT_TOKEN = '${CLAUDE_PLUGIN_ROOT}';

/**
 * Claude Code's tools, by the action Open Code checks each one by. `edit`
 * covers every tool that writes a file: write, edit and patch.
 */
export const ACTIONS = Object.freeze({
  Read: 'read',
  Grep: 'grep',
  Glob: 'glob',
  Bash: 'shell',
  Write: 'edit',
  Edit: 'edit',
});

/** Claude Code's name for a tool of an MCP server: mcp__<server>__<tool>. */
const MCP = /^mcp__(.+?)__(.+)$/;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * @param {unknown} error
 * @returns {string}
 */
const reason = (error) => (error instanceof Error ? error.message : String(error));

/**
 * The action Open Code checks a Claude Code tool by, or undefined for a tool
 * it has no counterpart of. An MCP tool is `<server>_<tool>`, each part with
 * every character but letters, digits, `_` and `-` made `_`, as Open Code
 * names it.
 *
 * @param {string} tool
 * @returns {string|undefined}
 */
export function actionOf(tool) {
  if (Object.hasOwn(ACTIONS, tool)) return ACTIONS[tool];
  const mcp = MCP.exec(tool);
  if (!mcp) return undefined;
  const clean = (part) => part.replace(/[^A-Za-z0-9_-]/g, '_');
  return `${clean(mcp[1])}_${clean(mcp[2])}`;
}

/**
 * @typedef {{action: string, resource: string, effect: 'allow'|'deny'}} Rule
 */

/**
 * An agent's permissions: everything denied, then each of its tools allowed,
 * then each directory outside the project it may read. Open Code takes the
 * last rule that matches, so the order is the point.
 *
 * @param {readonly string[]} tools Claude Code's names
 * @param {readonly string[]} directories absolute
 * @returns {{rules: Rule[], unknown: string[]}} unknown: tools with no action, left denied
 */
export function permissionsFor(tools, directories) {
  const rules = [{ action: '*', resource: '*', effect: /** @type {const} */ ('deny') }];
  const unknown = [];
  const allowed = new Set();
  for (const tool of tools) {
    const action = actionOf(tool);
    if (action === undefined) unknown.push(tool);
    else if (!allowed.has(action)) {
      allowed.add(action);
      rules.push({ action, resource: '*', effect: 'allow' });
    }
  }
  const seen = new Set();
  for (const directory of directories) {
    const rule = directoryRule(directory);
    if (seen.has(rule.resource)) continue;
    seen.add(rule.resource);
    rules.push(rule);
  }
  return { rules, unknown };
}

/**
 * @typedef {object} Source
 * @property {string} id `name:`
 * @property {string} file agents/<file>, for messages
 * @property {string|undefined} description
 * @property {unknown} model `model:` as written
 * @property {string[]} tools
 * @property {string} body
 */

/**
 * @param {unknown} tools `tools:` as YAML read it
 * @returns {string[]|undefined}
 */
function toolList(tools) {
  if (Array.isArray(tools)) return tools.map(String).map((tool) => tool.trim()).filter(Boolean);
  if (typeof tools === 'string') return tools.split(',').map((tool) => tool.trim()).filter(Boolean);
  return undefined;
}

/**
 * Every agents/*.md, in file order. A file that cannot be read is left out and
 * named in `problems`; the rest are read.
 *
 * @param {string} root the plugin's root
 * @returns {Promise<{agents: Source[], problems: string[]}>}
 */
export async function readAgents(root) {
  const dir = join(root, 'agents');
  const files = (await readdir(dir)).filter((name) => name.endsWith('.md')).sort();
  const agents = [];
  const problems = [];
  const ids = new Set();
  for (const name of files) {
    const file = `agents/${name}`;
    try {
      const text = await readFile(join(dir, name), 'utf8');
      const match = FRONTMATTER.exec(text);
      if (!match) {
        problems.push(`${file}: no frontmatter; not registered`);
        continue;
      }
      const data = parse(match[1]) ?? {};
      const id = data.name;
      if (typeof id !== 'string' || id === '') {
        problems.push(`${file}: no name:; not registered`);
        continue;
      }
      if (ids.has(id)) {
        problems.push(`${file}: a second agent called ${id}; not registered`);
        continue;
      }
      // Claude Code gave an agent without tools: every tool there is. Every
      // agent here is denied what it is not given, so it would get none.
      const tools = toolList(data.tools);
      if (tools === undefined) {
        problems.push(`${file}: no tools:; not registered`);
        continue;
      }
      ids.add(id);
      agents.push({
        id,
        file,
        description: typeof data.description === 'string' ? data.description : undefined,
        model: data.model,
        tools,
        body: text.slice(match[0].length).trim(),
      });
    } catch (error) {
      problems.push(`${file}: ${reason(error)}; not registered`);
    }
  }
  return { agents, problems };
}

/**
 * The model of each agent, by the order above, and the keys of the map that
 * were dropped. A key that starts with the commands' prefix is a command's,
 * and the commands' registrar reads it.
 *
 * `unread` lists the agents whose `model:` is not provider/model#variant: they
 * run on the caller's model.
 *
 * @param {readonly Source[]} agents
 * @param {Readonly<Record<string, string>>} map options.models
 * @returns {{models: Map<string, import('./options.js').ModelRef>, dropped: string[], unread: string[]}}
 */
export function agentModels(agents, map) {
  const ids = new Set(agents.map((agent) => agent.id));
  const chosen = new Map();
  const dropped = [];
  for (const [key, text] of Object.entries(map)) {
    if (key.startsWith(PREFIX)) continue;
    if (!ids.has(key)) {
      dropped.push(`options.models.${key}: no agent or command of this plugin is called that; dropped`);
      continue;
    }
    const model = modelRef(text);
    if (model) chosen.set(key, model);
    else dropped.push(`options.models.${key}: ${JSON.stringify(text)} is not provider/model#variant; dropped, the agent keeps its default`);
  }

  const models = new Map();
  const unread = [];
  for (const agent of agents) {
    const model = chosen.get(agent.id) ?? modelRef(agent.model);
    if (model) models.set(agent.id, model);
    else if (agent.model !== undefined) unread.push(`${agent.file}: model ${JSON.stringify(agent.model)} is not provider/model#variant`);
  }
  return { models, dropped, unread };
}

/**
 * What one agent is registered as.
 *
 * @typedef {object} Definition
 * @property {string} id
 * @property {string|undefined} description
 * @property {string} system
 * @property {Rule[]} permissions
 * @property {import('./options.js').ModelRef|undefined} model
 */

/**
 * Set every field the plugin decides on an agent Open Code hands over: a new
 * one, made from Open Code's defaults, on each call of the transform.
 *
 * @param {Record<string, unknown>} info
 * @param {Definition} agent
 */
function apply(info, agent) {
  info.mode = 'subagent';
  if (agent.description !== undefined) info.description = agent.description;
  info.system = agent.system;
  info.permissions = agent.permissions.map((rule) => ({ ...rule }));
  if (agent.model) info.model = { ...agent.model };
  else delete info.model;
}

/**
 * @param {object} ctx the plugin context setup() received
 * @param {{root: string, settings: {models: Readonly<Record<string, string>>}, log: (line: string) => void}} plugin
 * @returns {Promise<{agents: readonly Definition[], dropped: readonly string[], unread: readonly string[]}>}
 */
export async function registerAgents(ctx, plugin) {
  const root = resolve(plugin.root);
  const { agents, problems } = await readAgents(root);

  // $PDKIT_HOME as the hooks resolve it: they run in a child of this
  // process, with its environment.
  const directories = [root];
  try {
    directories.push(resolveHome());
  } catch (error) {
    problems.push(`cannot tell where $PDKIT_HOME is (${reason(error)}); agents cannot read the plans under it`);
  }

  const { models, dropped, unread } = agentModels(agents, plugin.settings?.models ?? {});
  /** @type {Definition[]} */
  const defined = [];
  for (const agent of agents) {
    const { rules, unknown } = permissionsFor(agent.tools, directories);
    for (const tool of unknown) problems.push(`${agent.file}: Open Code has no permission for the tool ${tool}; the agent goes without it`);
    defined.push(
      Object.freeze({
        id: agent.id,
        description: agent.description,
        system: agent.body.replaceAll(ROOT_TOKEN, root),
        permissions: rules,
        model: models.get(agent.id),
      }),
    );
  }
  // TODO(T5.B): every model: is a Claude Code alias until the defaults are
  // written as provider/model#variant, so `unread` names all of them, and is
  // not logged: each agent runs on its caller's model, as intended for now.
  // Once they are written, a test holds `unread` empty.
  for (const line of [...problems, ...dropped]) plugin.log(line);

  await ctx.agent.transform((editor) => {
    for (const agent of defined) {
      try {
        editor.update(agent.id, (info) => apply(info, agent));
      } catch (error) {
        plugin.log(`cannot register the agent ${agent.id}: ${reason(error)}`);
      }
    }
  });

  // TODO(T7.13): the doctor shows the final model of each agent and where it
  // came from, from Open Code's own answers; what this returns is the
  // registrar's side of it.
  return Object.freeze({ agents: Object.freeze(defined), dropped: Object.freeze(dropped), unread: Object.freeze(unread) });
}
