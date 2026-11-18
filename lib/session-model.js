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

// What a skill's frontmatter says about how its command runs: its model, its
// argument hint, its description.
//
// The frontmatter is the one place a skill says these. Each is read here, so
// that the command registrar (opencode/commands.js) and the prompt hook read
// the same thing. Nothing here sets a model: a command switches the session
// to its own when it runs, and the session keeps it for the phase.
//
// Claude Code's version also wrote a default model into the fork, and read the
// session's model from its transcripts for the prompt hook to compare, because
// a skill's model lasted one turn there. Open Code needs neither (D12): nothing
// here writes into the fork or reads a session.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PLUGIN_ROOT } from './config.js';
import { parse } from './yaml.js';

/**
 * The frontmatter of a skill, or null when there is no file or no block.
 *
 * @param {string} name  skill directory under skills/
 * @param {string} [pluginRoot]
 * @returns {Promise<string|null>}
 */
async function frontmatterOf(name, pluginRoot = PLUGIN_ROOT) {
  let text;
  try {
    text = await readFile(join(pluginRoot, 'skills', name, 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
  return text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? null;
}

/**
 * The `model:` a skill declares in its frontmatter, as Open Code reads a model,
 * or null.
 *
 * Read in the grammar Open Code reads a model by in its config (its
 * `Config.ModelSelection`, which modelRef() in opencode/options.js follows): a
 * provider, a slash, a model that may hold slashes of its own, an optional
 * `#variant`, written as one word. A Claude Code alias such as `sonnet` is not
 * a model in that grammar and gives null, as a missing file or field does:
 * there is nothing to switch the session to. The registrar reads the field as
 * written to say which ones it could not read.
 *
 * @param {string} name  skill directory under skills/
 * @param {string} [pluginRoot]
 * @returns {Promise<string|null>}
 */
export async function skillModel(name, pluginRoot = PLUGIN_ROOT) {
  const frontmatter = await frontmatterOf(name, pluginRoot);
  return frontmatter?.match(/^model:[ \t]*["']?([^\s"'/#]+\/[^\s"'#]+(?:#[^\s"'#]+)?)["']?[ \t]*$/m)?.[1] ?? null;
}

/**
 * The `argument-hint:` a skill declares in its frontmatter, unquoted, or null.
 *
 * Read for the same reason as the model: it is the one place a skill says what
 * its argument is, and the prompt hook has to tell an issue number from a pull
 * request number without a list of its own that could drift from the skills.
 *
 * @param {string} name  skill directory under skills/
 * @param {string} [pluginRoot]
 * @returns {Promise<string|null>}
 */
export async function skillArgument(name, pluginRoot = PLUGIN_ROOT) {
  const frontmatter = await frontmatterOf(name, pluginRoot);
  const hint = frontmatter?.match(/^argument-hint:[ \t]*(.+?)[ \t]*$/m)?.[1];
  return hint ? hint.replace(/^(["'])(.*)\1$/, '$2') : null;
}

/** What stands between a command's argument hint and its description. */
export const HINT_SEPARATOR = ' · ';

/**
 * The description of a `/pd:` command as a person sees it next to the name:
 * the argument hint first, then the description.
 *
 * Open Code gives a command a description and nothing else, and shows only
 * the start of it beside the name, so the hint Claude Code showed there goes
 * in front, where it stays visible.
 *
 * @param {string|null|undefined} hint
 * @param {string} description
 * @returns {string}
 */
export function commandDescription(hint, description) {
  return hint ? `${hint}${HINT_SEPARATOR}${description}` : description;
}

/**
 * The description the command for a skill is registered with, or null when
 * the skill has no file or no `description:`.
 *
 * The one place it is built: the plugin registers each command with it, and
 * `pdkit doctor` compares the description Open Code lists against it to tell
 * a pdkit command from one that took its name. The hint is the one
 * skillArgument reads, the same line the prompt hook reads.
 *
 * @param {string} name  skill directory under skills/
 * @param {string} [pluginRoot]
 * @returns {Promise<string|null>}
 */
export async function skillDescription(name, pluginRoot = PLUGIN_ROOT) {
  const frontmatter = await frontmatterOf(name, pluginRoot);
  if (frontmatter === null) return null;
  let data;
  try {
    data = parse(frontmatter);
  } catch {
    return null;
  }
  const description = data?.description;
  if (typeof description !== 'string' || description === '') return null;
  return commandDescription(await skillArgument(name, pluginRoot), description);
}
