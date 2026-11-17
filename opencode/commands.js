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
// Every skill becomes a command, `/pd:<name>`, as a person typed it before:
//
//   description:  the argument hint, then the description. Open Code shows a
//                 command's description and nothing else beside its name,
//                 and only the start of it, so the hint Claude Code showed
//                 there goes first (lib/session-model.js, which the doctor
//                 reads too);
//   model:        the user's choice in the plugin's options, `models.<name>`,
//                 then the `model:` of the frontmatter. The command checks it
//                 against the models Open Code can use and only then switches
//                 the session to it; one it cannot use is refused with a line
//                 that says so, and the session stays on its model. Claude
//                 Code's `model:` lasted one turn; here the phase keeps it
//                 until the person changes it. A `model:` that is not
//                 provider/model#variant (a Claude Code alias) is not read,
//                 and the command runs on the session's model;
//   text:         the skill's body, with the plugin's root spelled out and the
//                 arguments put in, as Claude Code did: in place of each
//                 `$ARGUMENTS`, or, in a skill that has none, after the body
//                 as `ARGUMENTS: <what was typed>`;
//   label:        `metadata` on the prompt the command sends, which tells the
//                 prompt hook that a pdkit command ran, and which one
//                 (opencode/bridge/payload.js). Open Code hands the hook the
//                 text alone.
//
// A skill the model may load by itself — one without
// `disable-model-invocation: true` — is registered as a skill too, under the
// ID `pd:<name>`, as Claude Code named it. Its description carries the
// `when_to_use` lines appended, as Claude Code listed it; Open Code does not
// read that key. A skill of the same ID in a person's or a project's skills
// directory replaces this one without a word; the doctor looks for that.
//
// The files are read once, in setup(). Open Code calls a transform again on
// every change to its config, without setup(); each call only applies what was
// read. A transform callback must not throw: Open Code disables a plugin whose
// transform fails, and with it the gate.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { skillDescription, skillModel } from '../lib/session-model.js';
import { LABEL_SOURCE } from './bridge/payload.js';
import { modelRef } from './options.js';
import { readPrompt, spellRoot } from './prompts.js';

/** The prefix every pdkit command carries, so `/pd:triage` reads as it always has. */
export const PREFIX = 'pd:';

/** Where a skill takes what was typed after its name. */
export const ARGUMENTS = '$ARGUMENTS';

/**
 * @param {unknown} error
 * @returns {string}
 */
const reason = (error) => (error instanceof Error ? error.message : String(error));

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
 * @typedef {object} Skill
 * @property {string} name the directory under skills/
 * @property {string} file skills/<name>/SKILL.md, for messages
 * @property {boolean} personOnly `disable-model-invocation: true`: a command and nothing else
 * @property {string|undefined} description the command's, hint first
 * @property {string|undefined} listed what the model reads of a skill it may load: description and when_to_use
 * @property {string|null} model `model:` as written
 * @property {string} body with the root spelled out
 */

/**
 * Every skills/<name>/SKILL.md, by name. A file that cannot be read is left
 * out and named in `problems`; the rest are read.
 *
 * @param {string} root the plugin's root, absolute
 * @returns {Promise<{skills: Skill[], problems: string[]}>}
 */
export async function readSkills(root) {
  const skills = [];
  const problems = [];
  for (const name of await skillNames(root)) {
    const file = `skills/${name}/SKILL.md`;
    try {
      const prompt = readPrompt(await readFile(join(root, 'skills', name, 'SKILL.md'), 'utf8'));
      if (!prompt) {
        problems.push(`${file}: no frontmatter; not registered`);
        continue;
      }
      const { data } = prompt;
      const text = (key) => (typeof data[key] === 'string' && data[key] !== '' ? data[key] : undefined);
      const description = (await skillDescription(name, root)) ?? undefined;
      if (description === undefined) problems.push(`${file}: no description:; /${PREFIX}${name} is listed without one`);
      const personOnly = data['disable-model-invocation'] === true;
      const listed = [text('description'), text('when_to_use')].filter(Boolean).join(' ') || undefined;
      skills.push({
        name,
        file,
        personOnly,
        description,
        listed,
        model: await skillModel(name, root),
        body: spellRoot(prompt.body, root),
      });
    } catch (error) {
      problems.push(`${file}: ${reason(error)}; not registered`);
    }
  }
  return { skills, problems };
}

/**
 * @typedef {{ref: import('./options.js').ModelRef, text: string, source: string}} Chosen
 */

/**
 * The model of each command, by the order above, and the keys of the map that
 * were dropped. A key without the commands' prefix is an agent's, and the
 * agents' registrar reads it.
 *
 * `unread` lists the commands whose `model:` is not provider/model#variant:
 * they run on the session's model.
 *
 * @param {readonly Skill[]} skills
 * @param {Readonly<Record<string, string>>} map options.models
 * @returns {{models: Map<string, Chosen>, dropped: string[], unread: string[]}} models by command name
 */
export function commandModels(skills, map) {
  const names = new Set(skills.map((skill) => `${PREFIX}${skill.name}`));
  const chosen = new Map();
  const dropped = [];
  for (const [key, text] of Object.entries(map)) {
    if (!key.startsWith(PREFIX)) continue;
    if (!names.has(key)) {
      dropped.push(`options.models.${key}: no agent or command of this plugin is called that; dropped`);
      continue;
    }
    const ref = modelRef(text);
    if (ref) chosen.set(key, { ref, text, source: 'options.models' });
    else dropped.push(`options.models.${key}: ${JSON.stringify(text)} is not provider/model#variant; dropped, the command keeps its default`);
  }

  const models = new Map();
  const unread = [];
  for (const skill of skills) {
    const name = `${PREFIX}${skill.name}`;
    const ref = modelRef(skill.model);
    const model = chosen.get(name) ?? (ref && { ref, text: skill.model, source: skill.file });
    if (model) models.set(name, model);
    else if (skill.model !== null) unread.push(`${skill.file}: model ${JSON.stringify(skill.model)} is not provider/model#variant`);
  }
  return { models, dropped, unread };
}

/**
 * Why Open Code cannot run a model, by the catalog ctx.model.list() gives for
 * the session's directory; undefined when it can.
 *
 * @param {readonly unknown[]} catalog
 * @param {import('./options.js').ModelRef} ref
 * @returns {string|undefined}
 */
export function unavailable(catalog, ref) {
  const name = `${ref.providerID}/${ref.id}`;
  const model = catalog.find(
    (entry) => entry?.providerID === ref.providerID && (entry.id === ref.id || entry.modelID === ref.id),
  );
  if (!model) return `it has no model ${name} for this directory`;
  if (model.enabled === false) return `the model ${name} is disabled`;
  if (ref.variant === undefined) return undefined;
  const variants = (Array.isArray(model.variants) ? model.variants : []).map((variant) => variant?.id);
  if (variants.includes(ref.variant)) return undefined;
  return variants.length === 0
    ? `${name} has no variants, so not ${ref.variant}`
    : `${name} has no variant ${ref.variant}, only ${variants.join(', ')}`;
}

/**
 * The text a command sends: its body with the arguments put in, as Claude
 * Code put them in a skill.
 *
 * @param {string} body
 * @param {string} given what was typed after the command's name
 * @returns {string}
 */
export function withArguments(body, given) {
  const typed = given.trim();
  // A function, not a string: a `$` in what was typed must not read as a pattern.
  if (body.includes(ARGUMENTS)) return body.replaceAll(ARGUMENTS, () => typed);
  return typed === '' ? body : `${body}\n\nARGUMENTS: ${typed}`;
}

/**
 * What one command is registered as.
 *
 * @typedef {object} Definition
 * @property {string} name pd:<skill>
 * @property {string|undefined} description
 * @property {Chosen|undefined} model
 * @property {string} body
 */

/**
 * A command's execute: check its model and switch to it, then send its text,
 * labeled. Throws when the model cannot be used — before anything in the
 * session changes. Open Code shows the message to the person.
 *
 * @param {object} ctx
 * @param {Definition} command
 */
export function executor(ctx, command) {
  return async (input) => {
    const sessionID = input?.sessionID;
    const given = typeof input?.prompt?.text === 'string' ? input.prompt.text : '';
    if (command.model) {
      const { ref, text, source } = command.model;
      const setTo = `/${command.name} is set to ${text} (${source})`;
      let catalog;
      try {
        const listed = await ctx.model.list();
        catalog = listed?.data ?? listed;
      } catch (error) {
        throw new Error(`pdkit: ${setTo}, and the models this Open Code can use cannot be listed (${reason(error)}). The session stays on its model.`);
      }
      const why = unavailable(Array.isArray(catalog) ? catalog : [], ref);
      if (why !== undefined) {
        throw new Error(
          `pdkit: ${setTo}, which this Open Code cannot use: ${why}. The session stays on its model; ` +
            `name another for "${command.name}" under options.models of the ${LABEL_SOURCE} entry in opencode.json.`,
        );
      }
      await ctx.session.switchModel({ sessionID, model: { ...ref } });
    }
    await ctx.session.prompt({
      ...input?.prompt,
      sessionID,
      text: withArguments(command.body, given),
      delivery: input?.delivery,
      metadata: { source: LABEL_SOURCE, command: command.name, arguments: given },
    });
  };
}

/**
 * @param {object} ctx the plugin context setup() received
 * @param {{root: string, settings: {models: Readonly<Record<string, string>>}, log: (line: string) => void}} plugin
 * @returns {Promise<{commands: readonly Definition[], skills: readonly object[], dropped: readonly string[], unread: readonly string[]}>}
 */
export async function registerCommands(ctx, plugin) {
  const root = resolve(plugin.root);
  const { skills, problems } = await readSkills(root);
  const { models, dropped, unread } = commandModels(skills, plugin.settings?.models ?? {});
  // A command whose model: is a Claude Code alias is named in `unread`, and
  // that is not logged: it runs on the session's model.
  // TODO(T6.01–T6.24): every command shipped names its default, which a test
  // holds, once each one's model: is provider/model#variant.
  for (const line of [...problems, ...dropped]) plugin.log(line);

  /** @type {Definition[]} */
  const commands = skills.map((skill) =>
    Object.freeze({
      name: `${PREFIX}${skill.name}`,
      description: skill.description,
      model: models.get(`${PREFIX}${skill.name}`),
      body: skill.body,
    }),
  );
  const loadable = skills
    .filter((skill) => !skill.personOnly)
    .map((skill) =>
      Object.freeze({
        id: `${PREFIX}${skill.name}`,
        name: `${PREFIX}${skill.name}`,
        ...(skill.listed === undefined ? {} : { description: skill.listed }),
        path: join(root, 'skills', skill.name, 'SKILL.md'),
        content: skill.body,
      }),
    );

  await ctx.command.transform((editor) => {
    for (const command of commands) {
      try {
        editor.add({
          name: command.name,
          ...(command.description === undefined ? {} : { description: command.description }),
          execute: executor(ctx, command),
        });
      } catch (error) {
        plugin.log(`cannot add the command ${command.name}: ${reason(error)}`);
      }
    }
  });

  // add, not update: update leaves a skill Open Code does not have yet
  // unmade, and add throws on a field missing.
  await ctx.skill.transform((editor) => {
    for (const skill of loadable) {
      try {
        editor.add({ ...skill });
      } catch (error) {
        plugin.log(`cannot add the skill ${skill.id}: ${reason(error)}`);
      }
    }
  });

  // TODO(T7.13, T7.14): the doctor shows each command's model and where it
  // came from, and finds a command or skill another source has replaced.
  return Object.freeze({
    commands: Object.freeze(commands),
    skills: Object.freeze(loadable),
    dropped: Object.freeze(dropped),
    unread: Object.freeze(unread),
  });
}

/**
 * The commands of a plugin that will not run on this Open Code: every
 * `/pd:<name>` is there, and each one refuses with `refusal`. A person who
 * types one learns why nothing works and what to run, rather than finding the
 * command missing. The names are the full registration's: one command per
 * skill.
 *
 * @param {object} ctx the plugin context setup() received
 * @param {{root: string, log: (line: string) => void}} plugin
 * @param {{summary: string, refusal: string}} text the one-line description, and the error each command throws
 */
export async function registerRefusals(ctx, plugin, text) {
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
        plugin.log(`cannot add the command ${PREFIX}${name}: ${reason(error)}`);
      }
    }
  });
}
