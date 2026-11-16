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

// The plugin's settings: the `options` object of its entry in opencode.json,
//
//   { "package": "opencode-pdkit", "options": { "models": { "<agent or command>": "provider/model#variant" } } }
//
// which Open Code hands to setup() as ctx.options and, when the file changes,
// hands again by reloading the plugin. `models` is the one setting there is:
// the user's choice of model per agent and per command, over the defaults in
// their frontmatter.
//
// Reading never throws. setup() runs this after the gate is registered, and a
// setup() that throws unloads the plugin, gate included, so a typo in a
// config file would switch the gate off. What cannot be read is dropped
// instead, and the list of what was dropped is kept for the doctor to show:
// a setting that silently does nothing is the next worst thing.

/**
 * @param {unknown} value
 * @returns {string}
 */
const kind = (value) => (value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value);

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @param {unknown} raw ctx.options as Open Code passes it
 * @returns {{models: Readonly<Record<string, string>>, dropped: readonly string[]}}
 */
export function readOptions(raw) {
  const models = {};
  const dropped = [];
  const settings = () => Object.freeze({ models: Object.freeze(models), dropped: Object.freeze(dropped) });

  // An entry written as a bare package name has no options at all.
  if (raw === undefined || raw === null) return settings();
  if (!isObject(raw)) {
    dropped.push(`options: expected an object, got ${kind(raw)}`);
    return settings();
  }

  for (const [key, value] of Object.entries(raw)) {
    if (key !== 'models') {
      dropped.push(`options.${key}: not a setting of this plugin`);
      continue;
    }
    if (!isObject(value)) {
      dropped.push(`options.models: expected an object, got ${kind(value)}`);
      continue;
    }
    // Which keys name an agent or a command is the registrars' to judge: they
    // know the IDs. Each one reads its own keys with modelRef() below, and
    // drops what does not read as a model.
    for (const [id, model] of Object.entries(value)) {
      if (typeof model === 'string') models[id] = model;
      else dropped.push(`options.models.${id}: expected "provider/model#variant", got ${kind(model)}`);
    }
  }

  return settings();
}

/**
 * The grammar Open Code itself reads a model by in its config (its
 * `Config.ModelSelection`): a provider, a slash, a model that may hold slashes
 * of its own, and an optional `#variant`. The same grammar here, so that a
 * value pdkit accepts is one Open Code would accept in `agents.<id>.model`, and
 * the other way round.
 */
const SELECTION = /^([^/#]+)\/([^#]+)(?:#([^#]+))?$/;

/**
 * A model as Open Code takes it on an agent: an object, never the string. An
 * agent registered with the string breaks the agent list of the whole
 * location, not only its own entry.
 *
 * @typedef {{providerID: string, id: string, variant?: string}} ModelRef
 */

/**
 * Read `provider/model#variant`.
 *
 * @param {unknown} text
 * @returns {ModelRef|undefined} undefined for anything that is not one
 */
export function modelRef(text) {
  const match = typeof text === 'string' ? SELECTION.exec(text) : null;
  if (!match) return undefined;
  const [, providerID, id, variant] = match;
  return variant === undefined ? { providerID, id } : { providerID, id, variant };
}
