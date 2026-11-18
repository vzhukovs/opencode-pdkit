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
// Claude Code's version also wrote a default model into the fork, because a
// skill's model lasted one turn there. Open Code needs none (D12), and nothing
// here writes into the fork. What follows the readers serves the prompt
// hook's model check alone, and goes with it.

import { open, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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

// The prompt hook's model check, and nothing else, reads what follows.
// TODO(T7.4): goes with that check (D12).

/** Relative to the fork's root. Never .claude/settings.json: git tracks that one. */
export const SETTINGS_FILE = join('.claude', 'settings.local.json');

/**
 * The fork's settings.local.json, parsed: the file Claude Code's version of
 * `pdkit init` wrote the default into. Read, never written.
 *
 * Invalid JSON is its own answer rather than an empty object, which would read
 * as a file that names no model.
 *
 * @param {string} repoRoot
 * @returns {Promise<{ok: true, path: string, exists: boolean, text: string, settings: Record<string, unknown>} | {ok: false, path: string, error: string}>}
 */
export async function readSettings(repoRoot) {
  const path = join(repoRoot, SETTINGS_FILE);

  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: true, path, exists: false, text: '', settings: {} };
    return { ok: false, path, error: `cannot read ${path} (${error.code ?? error.message})` };
  }

  let settings;
  try {
    settings = JSON.parse(text);
  } catch (error) {
    return { ok: false, path, error: `${path} is not valid JSON (${error.message})` };
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return { ok: false, path, error: `${path} does not hold a JSON object` };
  }

  return { ok: true, path, exists: true, text, settings };
}

/**
 * The model family a model id or a picker label names, or null.
 *
 * `claude-opus-5-5`, `Opus 5.5` and `opus` all say opus; the version is not
 * what a phase is routed by, the family is.
 *
 * @param {string|null|undefined} text
 * @returns {'opus'|'sonnet'|'haiku'|null}
 */
export function familyOf(text) {
  const found = String(text ?? '').toLowerCase().match(/(opus|sonnet|haiku)/);
  return /** @type {'opus'|'sonnet'|'haiku'|null} */ (found?.[1] ?? null);
}

/** How much of a transcript's end is read before reading all of it. */
const TAIL_BYTES = 2 * 1024 * 1024;

/**
 * The model a transcript says the session is on, or null when it does not say.
 *
 * Two records say it, and the later wins: an assistant message carries the
 * model that wrote it, and `/model` leaves a local command whose output is
 * "Set model to `Sonnet 5.5` for this session only". The second matters
 * because `/model` typed after `/clear` and before the phase's command is in a
 * transcript with no assistant message yet. `<synthetic>` is Claude Code
 * answering for itself and says nothing about the model.
 *
 * Measured on 2.1.301 by driving `claude -p --input-format stream-json` through
 * `/model` and `/clear`, with a hook writing down what it was given.
 *
 * @param {string} path
 * @returns {Promise<'opus'|'sonnet'|'haiku'|null>}
 */
export async function lastModelIn(path) {
  const scan = (text) => {
    const lines = text.split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line.includes('"model"') && !line.includes('Set model to')) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue; // the first line of a tail read is usually cut in half
      }
      if (record.type === 'assistant') {
        const family = familyOf(record.message?.model === '<synthetic>' ? null : record.message?.model);
        if (family) return family;
      }
      if (record.type === 'system' && record.subtype === 'local_command') {
        const set = String(record.content ?? '').match(/Set model to `([^`]+)`/);
        if (set) return familyOf(set[1]);
      }
    }
    return null;
  };

  let handle;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const found = scan(buffer.toString('utf8'));
    if (found || start === 0) return found;
    return scan(await readFile(path, 'utf8'));
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * Where the transcripts a `claude` process has had are remembered: one file
 * per process, outside $PDKIT_HOME, because it is about a running program and
 * not about an issue.
 *
 * @param {string} pid
 * @param {string} [dir]
 * @returns {string}
 */
function processFile(pid, dir = join(tmpdir(), 'pdkit-sessions')) {
  return join(dir, `${pid.replace(/[^\w-]/g, '')}.json`);
}

/**
 * The model this session is on, as well as it can be told from outside.
 *
 * A hook is not given the model. The transcript says it once anything has been
 * answered or `/model` typed, and that is the first source. A phase starts with
 * `/clear`, which opens a new transcript with neither, while the model carries
 * over — so the second source is the transcript the same `claude` process had
 * before. `CLAUDE_PID` is the process, and it is the one identifier that
 * survives `/clear`; `session_id` does not.
 *
 * The transcript asked about is remembered for next time, whatever it says.
 *
 * @param {{transcriptPath?: string|null, pid?: string|null, dir?: string}} input
 * @returns {Promise<{model: 'opus'|'sonnet'|'haiku'|null, source: 'transcript'|'previous'|null}>}
 */
export async function currentModel(input) {
  const path = input.transcriptPath ?? null;
  const here = path ? await lastModelIn(path) : null;

  const file = input.pid ? processFile(input.pid, input.dir) : null;
  let seen = [];
  if (file) {
    try {
      seen = JSON.parse(await readFile(file, 'utf8')).transcripts ?? [];
    } catch {
      seen = [];
    }
  }

  let found = here ? { model: here, source: 'transcript' } : { model: null, source: null };
  if (!here) {
    for (const earlier of [...seen].reverse()) {
      if (earlier === path) continue;
      const model = await lastModelIn(earlier);
      if (model) {
        found = { model, source: 'previous' };
        break;
      }
    }
  }

  if (file && path) {
    const next = [...seen.filter((entry) => entry !== path), path].slice(-5);
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify({ transcripts: next })}\n`);
    } catch {
      // A reminder that cannot remember is still a reminder next time it can.
    }
  }

  return /** @type {any} */ (found);
}

