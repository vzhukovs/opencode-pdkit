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

// The rules an agent of the plugin is registered with, built from the
// `tools:` of its file.
//
// Open Code knows no list of tools per agent. It checks every tool call
// against an ordered list of rules, `{ action, resource, effect }`, and the
// last rule whose action and resource fit decides. So an agent's rules are:
// everything denied, then the action of each tool it was given allowed, then
// each directory outside the project it may read in.
//
// Two readers, one reading: the agents' registrar builds the rules it
// registers each agent with (opencode/agents.js), and `pdkit doctor` builds
// them again to tell which of the rules Open Code reports for an agent are
// the plugin's, and what the ones after them change. The server part loads
// this module, so it imports nothing of lib/ (test/invariants.test.js).

import { resolve } from 'node:path';

/**
 * @typedef {{action: string, resource: string, effect: 'allow'|'deny'}} Rule
 */

/**
 * A path in the form Open Code's rules match: forward slashes. A rule's `*`
 * stands for anything, slashes included, so one rule covers every
 * subdirectory.
 *
 * @param {string} path
 * @returns {string}
 */
export const slash = (path) => path.replaceAll('\\', '/');

/**
 * The rule that lets an agent read in a directory outside the project.
 *
 * @param {string} directory absolute
 * @returns {{action: 'external_directory', resource: string, effect: 'allow'}}
 */
export function directoryRule(directory) {
  return { action: 'external_directory', resource: `${slash(resolve(directory))}/*`, effect: 'allow' };
}

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
 * The tools an agent file names: `tools:` as a YAML list, or as one string of
 * names separated by commas.
 *
 * @param {unknown} tools `tools:` as YAML read it
 * @returns {string[]|undefined} undefined: no `tools:` the registrar can read
 */
export function toolList(tools) {
  if (Array.isArray(tools)) return tools.map(String).map((tool) => tool.trim()).filter(Boolean);
  if (typeof tools === 'string') return tools.split(',').map((tool) => tool.trim()).filter(Boolean);
  return undefined;
}

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
