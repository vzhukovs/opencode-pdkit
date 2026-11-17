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

// The prompts the plugin ships — agents/*.md and skills/*/SKILL.md — as both
// registrars read them: the frontmatter apart from the body, and the plugin's
// root spelled out in the body.

import { parse } from '../lib/yaml.js';

/** How a prompt names the plugin's root. Claude Code expanded it; the registrars do here. */
export const ROOT_TOKEN = '${CLAUDE_PLUGIN_ROOT}';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * A prompt file's frontmatter, as YAML reads it, and its body; null when the
 * file has no frontmatter. Throws when the frontmatter is not YAML.
 *
 * @param {string} text the whole file
 * @returns {{data: Record<string, unknown>, body: string}|null}
 */
export function readPrompt(text) {
  const match = FRONTMATTER.exec(text);
  if (!match) return null;
  return { data: parse(match[1]) ?? {}, body: text.slice(match[0].length).trim() };
}

/**
 * A body with every ROOT_TOKEN replaced by the plugin's root, which the model
 * then reads files by. Open Code has no such variable.
 *
 * @param {string} body
 * @param {string} root absolute
 * @returns {string}
 */
export function spellRoot(body, root) {
  // A function, not a string: a `$` in the root must not read as a pattern.
  return body.replaceAll(ROOT_TOKEN, () => root);
}
