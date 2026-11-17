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

// A skill's `allowed-tools`: the commands it may run without asking, for the
// turn it was invoked in.
//
// Claude Code read the key as a grant, not a fence: the tools it lists run
// without a question during the turn that invoked the skill, and the grant
// ends with the person's next message. Every other tool stays callable, under
// the person's own rules. `/pd:editor` and `/pd:open` list the one command
// each runs, so a person whose rules ask before every shell command is not
// asked about it.
//
// Open Code has no such key on a command. So:
//
//   - the command's execute gives its session a grant just before it sends
//     its text (give);
//   - the prompt hook ends the grant on any later prompt of that session —
//     the person's next message — once the command's own prompt has gone
//     through (take);
//   - permission.hook("evaluate") turns a question about `shell` into an
//     answer, while the grant lasts, when every command Open Code asks about
//     is one the skill lists (raises). Only a question is answered: a `deny`
//     in a person's rules never reaches the hook and stands.
//
// Claude Code's rule covered the command itself, not a command nested in it
// or the file a redirect writes: those went to the person's rules. Here a
// command with shell syntax that runs or redirects something — `$(`, a
// backtick, `<`, `>`, `;`, `&`, `|`, a line break — is left to the person's
// rules the same way, whether or not Open Code split it out.
//
// Only `Bash(...)` entries have a counterpart here; any other tool a skill
// lists is named in the log, and asked about as Open Code's rules say.

import { LABEL_SOURCE } from './bridge/payload.js';

/** The action Open Code checks the shell tool by. */
export const SHELL = 'shell';

/** Claude Code's entry for its shell tool: `Bash`, or `Bash(<pattern>)`. */
const BASH = /^Bash(?:\((.*)\))?$/s;

/** Shell syntax that runs another command or touches a file besides the one the rule names. */
const NOT_PLAIN = /[`<>;&|\n\r]|\$\(/;

/**
 * @param {unknown} error
 * @returns {string}
 */
const reason = (error) => (error instanceof Error ? error.message : String(error));

/**
 * The entries of `allowed-tools` as Claude Code took them: a YAML list, or one
 * string separated by commas or spaces — but not inside the parentheses of an
 * entry, where a pattern has spaces of its own.
 *
 * @param {unknown} value `allowed-tools` as YAML read it
 * @returns {string[]}
 */
export function allowedEntries(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  const entries = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (char === ',' || /\s/.test(char))) {
      if (current.trim()) entries.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) entries.push(current.trim());
  return entries;
}

/**
 * The shell patterns `allowed-tools` grants, and the entries this cannot
 * grant. `Bash` alone is every command: `*`.
 *
 * @param {unknown} value `allowed-tools` as YAML read it
 * @returns {{patterns: string[], unknown: string[]}}
 */
export function allowedPatterns(value) {
  const patterns = [];
  const unknown = [];
  for (const entry of allowedEntries(value)) {
    const bash = BASH.exec(entry);
    if (!bash) unknown.push(entry);
    else if (bash[1] === undefined || bash[1].trim() === '') patterns.push('*');
    else patterns.push(bash[1].trim());
  }
  return { patterns, unknown };
}

/**
 * Whether a command matches a pattern of Claude Code's Bash rules: a `*`
 * stands for any text, spaces included; `:*` at the end is ` *`; a ` *` at the
 * end, when it is the only `*`, matches the bare command too; no `*` is one
 * exact command.
 *
 * @param {string} command
 * @param {string} pattern
 * @returns {boolean}
 */
export function matches(command, pattern) {
  const rule = pattern.endsWith(':*') ? `${pattern.slice(0, -2)} *` : pattern;
  const parts = rule.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (parts.length === 2 && rule.endsWith(' *')) return new RegExp(`^${parts[0].slice(0, -1)}(?: [\\s\\S]*)?$`).test(command);
  return new RegExp(`^${parts.join('[\\s\\S]*')}$`).test(command);
}

/**
 * @typedef {{command: string, patterns: readonly string[], sent: boolean}} Grant
 */

/**
 * Whether the hook answers this question: one about `shell`, asked in a
 * session whose grant lasts, about commands each of which is plain and
 * matches a pattern of the grant.
 *
 * @param {unknown} event what permission.hook("evaluate") receives
 * @param {ReadonlyMap<string, Grant>} grants by session ID
 * @returns {boolean}
 */
export function raises(event, grants) {
  if (typeof event !== 'object' || event === null) return false;
  const { action, effect, resources, sessionID } = /** @type {{action?: unknown, effect?: unknown, resources?: unknown, sessionID?: unknown}} */ (event);
  if (action !== SHELL || effect !== 'ask' || typeof sessionID !== 'string') return false;
  const grant = grants.get(sessionID);
  if (grant === undefined || !Array.isArray(resources) || resources.length === 0) return false;
  return resources.every(
    (command) => typeof command === 'string' && !NOT_PLAIN.test(command) && grant.patterns.some((pattern) => matches(command, pattern)),
  );
}

/**
 * Whether a prompt is the one a command's execute sent with its grant: the
 * first prompt since, labeled with that command.
 *
 * @param {Grant} grant
 * @param {unknown} metadata the prompt hook's
 * @returns {boolean}
 */
function sentBy(grant, metadata) {
  if (grant.sent || metadata === null || typeof metadata !== 'object') return false;
  const label = /** @type {{source?: unknown, command?: unknown}} */ (metadata);
  return label.source === LABEL_SOURCE && label.command === grant.command;
}

/**
 * The grants of one loaded instance of the plugin, by session ID. A reload
 * starts with none: a grant lost that way only means a question.
 */
export function createGrants() {
  /** @type {Map<string, Grant>} */
  const grants = new Map();
  return {
    grants,
    /**
     * A command's execute, just before it sends its text: the session may run
     * these patterns without asking until its next prompt.
     *
     * @param {string} sessionID
     * @param {string} command pd:<skill>
     * @param {readonly string[]} patterns
     */
    give(sessionID, command, patterns) {
      if (typeof sessionID === 'string' && patterns.length > 0) grants.set(sessionID, { command, patterns, sent: false });
    },
    /** @param {string} sessionID */
    end(sessionID) {
      grants.delete(sessionID);
    },
    /**
     * The prompt hook: the command's own prompt keeps the grant, any other
     * prompt of the session ends it.
     *
     * @param {{sessionID?: unknown, metadata?: unknown}} event
     */
    take(event) {
      const sessionID = event?.sessionID;
      if (typeof sessionID !== 'string') return;
      const grant = grants.get(sessionID);
      if (grant === undefined) return;
      if (sentBy(grant, event.metadata)) grant.sent = true;
      else grants.delete(sessionID);
    },
    /**
     * permission.hook("evaluate").
     *
     * @param {{effect?: unknown}} event changed in place
     */
    decide(event) {
      if (raises(event, grants)) event.effect = 'allow';
    },
  };
}

/**
 * Register the two hooks a grant needs: the prompt hook that ends it, then the
 * answer. The answer is not registered without the end: a grant nothing ends
 * would outlast its turn. Neither registration nor callback throws; a
 * callback that fails leaves the question to the person's rules.
 *
 * @param {object} ctx the plugin context setup() received
 * @param {ReturnType<typeof createGrants>} grants
 * @param {readonly string[]} commands the commands that give a grant, for the log
 * @param {(line: string) => void} log
 */
export async function registerGrants(ctx, grants, commands, log) {
  const named = commands.map((command) => `/${command}`).join(', ');
  const failed = (error) =>
    log(`cannot register its allowed tools (${reason(error)}); ${named} run their commands as the person's rules say, asking where they ask`);
  try {
    await ctx.session.hook('prompt', (event) => {
      try {
        grants.take(event);
      } catch (error) {
        log(`cannot end a grant of allowed tools (${reason(error)})`);
      }
    });
  } catch (error) {
    failed(error);
    return;
  }
  try {
    await ctx.permission.hook('evaluate', (event) => {
      try {
        grants.decide(event);
      } catch (error) {
        log(`cannot decide a question about allowed tools: ${reason(error)}`);
      }
    });
  } catch (error) {
    failed(error);
  }
}
