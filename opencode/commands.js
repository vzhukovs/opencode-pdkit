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

// The commands and skills: skills/*/SKILL.md registered with Open Code.
//
// Claude Code read skills/ from the plugin directory and offered each one as
// `/pd:<name>`. Open Code reads neither commands nor skills from a plugin
// directory, so the plugin adds them through ctx.command.transform and
// ctx.skill.transform.
//
// A transform callback must not throw: Open Code disables a plugin whose
// transform fails, and with it the gate.

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** The prefix every pdkit command carries, so `/pd:triage` reads as it always has. */
export const PREFIX = 'pd:';

/**
 * The name of every skill the plugin ships: each directory under skills/ that
 * holds a SKILL.md.
 *
 * @param {string} root the plugin's root directory
 * @returns {Promise<string[]>} sorted
 */
export async function skillNames(root) {
  const dir = join(root, 'skills');
  const names = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = await stat(join(dir, entry.name, 'SKILL.md')).catch(() => null);
    if (manifest?.isFile()) names.push(entry.name);
  }
  return names.sort();
}

/**
 * @param {object} ctx the plugin context setup() received
 * @param {{root: string, settings: {models: Readonly<Record<string, string>>}, log: (line: string) => void}} plugin
 */
export async function registerCommands(ctx, plugin) {
  void plugin;
  // TODO(T6.B): register the commands and skills from skills/.
  await ctx.command.transform(() => {});
  await ctx.skill.transform(() => {});
}

/**
 * The commands of a plugin that will not run on this Open Code: every
 * `/pd:<name>` is there, and each one refuses with `refusal`. A person who
 * types one learns why nothing works and what to run, rather than finding the
 * command missing.
 *
 * @param {object} ctx the plugin context setup() received
 * @param {{root: string, log: (line: string) => void}} plugin
 * @param {{summary: string, refusal: string}} text the one-line description, and the error each command throws
 */
export async function registerRefusals(ctx, plugin, text) {
  // TODO(T6.B): the same names the full registration adds.
  const names = await skillNames(plugin.root);
  await ctx.command.transform((editor) => {
    for (const name of names) {
      try {
        editor.add({
          name: `${PREFIX}${name}`,
          description: text.summary,
          execute: async () => {
            throw new Error(text.refusal);
          },
        });
      } catch (error) {
        plugin.log(`cannot add the command ${PREFIX}${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });
}
