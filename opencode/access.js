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

// Reading outside the project: the plugin's own files, and $PDKIT_HOME.
//
// Prompts and hook messages name the plugin's files by absolute path — the
// knowledge base, the templates, a skill one agent calibrates against — and
// the plugin lives outside every project. Open Code asks before a tool
// touches a directory outside the project (the `external_directory` action,
// whose resource is `<directory>/*`), and an agent that is denied everything
// it was not given is refused without a question. Claude Code read a plugin's
// files without asking, and kept them readable even where a person had blocked
// reads outside the working directories.
//
// So there are two pieces here:
//
//   - directoryRule(), the rule that lets an agent into one directory. The
//     agents get one for the plugin's root and one for $PDKIT_HOME, where the
//     plan a critic reviews lives (opencode/agents.js);
//   - registerAccess(), which keeps the plugin's own files readable when a
//     person's config asks before every directory outside the project: a rule
//     there comes after the agent's and wins, so the plugin settles that one
//     question itself, for any agent, the main session's included — skills
//     name these files too. Only `ask` is raised, and only when every
//     directory asked about is under the root. A `deny` in a person's config
//     never reaches this hook and stands, and $PDKIT_HOME is left to the
//     person's rules, as Claude Code left it.
//
// The hook does not know whether the tool reads or writes: under the root, a
// write is still asked about or refused by the `edit` rules, as it would be in
// the project.

import { resolve } from 'node:path';

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
 * Whether a resource Open Code asks about lies under `root`. Windows paths
 * compare without case, as the host matches them there.
 *
 * @param {unknown} resource
 * @param {string} root
 * @returns {boolean}
 */
function under(resource, root) {
  if (typeof resource !== 'string') return false;
  const path = slash(resource);
  // The host asks about resolved directories; a `..` in one is not a path to trust.
  if (path.split('/').includes('..')) return false;
  const prefix = `${slash(resolve(root))}/`;
  return process.platform === 'win32' ? path.toLowerCase().startsWith(prefix.toLowerCase()) : path.startsWith(prefix);
}

/**
 * Whether the hook raises this question to an `allow`: a question about
 * directories outside the project, every one of them under the plugin's root.
 *
 * @param {unknown} event what permission.hook("evaluate") receives
 * @param {string} root the plugin's root
 * @returns {boolean}
 */
export function raises(event, root) {
  if (typeof event !== 'object' || event === null) return false;
  const { action, effect, resources } = /** @type {{action?: unknown, effect?: unknown, resources?: unknown}} */ (event);
  return (
    action === 'external_directory' &&
    effect === 'ask' &&
    Array.isArray(resources) &&
    resources.length > 0 &&
    resources.every((resource) => under(resource, root))
  );
}

/**
 * @param {object} ctx the plugin context setup() received
 * @param {{root: string, log: (line: string) => void}} plugin
 */
export async function registerAccess(ctx, plugin) {
  await ctx.permission.hook('evaluate', (event) => {
    // A throw here would fail the call that is being decided, whatever it was.
    try {
      if (raises(event, plugin.root)) event.effect = 'allow';
    } catch (error) {
      plugin.log(`cannot decide a question about its own files: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
