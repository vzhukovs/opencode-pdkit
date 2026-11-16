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

// The environment of every command the shell tool runs.
//
// Skills and agents call `pdkit` as a bare command. Claude Code made that work
// by itself, putting the plugin's bin/ on the PATH of its Bash tool; Open Code
// does nothing of the kind. What it offers is the shell create.before hook,
// which receives the environment a command is about to start with and lets the
// plugin change it. This module is that callback, and it does two things:
//
//   - bin/ goes on PATH, first. The PATH a command inherits — the client's, or
//     for a subagent the server's — can hold another pdkit, the Claude Code
//     plugin's among them, and the one a skill of this plugin means is this
//     plugin's own;
//   - the version of the Open Code server running the plugin goes beside it,
//     for `pdkit doctor`: that server is the one the minimum is about.
//
// The hook runs for the model's commands, in the foreground and in the
// background, for a subagent's, and for a person's `!` command in the TUI. It
// does not run for a `!`cmd`` in a command template, which this plugin does not
// use. The session a command runs in needs nothing from here: the shell tool
// sets that variable itself, after this hook (lib/harness.js names it).

import { delimiter as hostDelimiter, join } from 'node:path';

import { SERVER_VERSION_VARIABLE } from '../lib/opencode-version.js';

/**
 * @param {unknown} error
 * @returns {string}
 */
const reason = (error) => (error instanceof Error ? error.message : String(error));

/**
 * Put `bin` first on the PATH of `env` and the server's version beside it.
 * Changes `env` in place, which is how the hook hands a change back.
 *
 * An empty or missing PATH becomes `bin` alone, not `bin` and an empty entry:
 * the shell reads an empty entry as the working directory. An entry equal to
 * `bin` further along is dropped, so a command started from a shell this hook
 * already prepared does not carry it twice. Every other entry keeps its place.
 *
 * A `bin` whose path holds the delimiter leaves PATH as it was (see
 * onPath). A version that is not a non-empty string removes the variable
 * rather than leaving one the environment came with: that one would describe
 * some other server.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{bin: string, version: unknown, delimiter?: string, windows?: boolean}} options
 *   `delimiter` and `windows` default to the host's; tests pass another's
 * @returns {Record<string, string | undefined>} env
 */
export function prepare(env, { bin, version, delimiter = hostDelimiter, windows = process.platform === 'win32' }) {
  if (onPath(bin, delimiter)) {
    // Windows matches variable names without regard to case, and its PATH
    // usually arrives as `Path`. A second variable named `PATH` beside it would
    // leave the choice between the two to whatever starts the process.
    const key = (windows && Object.keys(env).find((name) => name.toUpperCase() === 'PATH')) || 'PATH';
    const current = typeof env[key] === 'string' ? env[key] : '';
    const rest = current === '' ? [] : current.split(delimiter).filter((entry) => entry !== bin);
    env[key] = [bin, ...rest].join(delimiter);
  }

  if (typeof version === 'string' && version !== '') env[SERVER_VERSION_VARIABLE] = version;
  else delete env[SERVER_VERSION_VARIABLE];

  return env;
}

/**
 * Whether a directory can be an entry of PATH at all.
 *
 * PATH has no escape for its delimiter, so a directory whose path holds one
 * splits into two entries that name nothing. Open Code installs a package
 * under a directory named after its specifier: `opencode-pdkit@…` from the
 * registry is safe, but `file:<tarball>` puts a colon in every path of the
 * plugin. Better to leave PATH alone there than to fill it with fragments.
 *
 * @param {string} dir
 * @param {string} [delimiter]
 * @returns {boolean}
 */
export function onPath(dir, delimiter = hostDelimiter) {
  return !dir.includes(delimiter);
}

/**
 * Register the create.before callback.
 *
 * The callback does not throw. What Open Code does with a throw there is
 * unverified; a command that runs without this plugin's bin/ on its PATH
 * fails or runs another pdkit, which is no worse than the hook missing.
 *
 * @param {object} ctx the plugin context setup() received
 * @param {{root: string, log: (line: string) => void}} plugin
 */
export async function registerEnvironment(ctx, plugin) {
  const bin = join(plugin.root, 'bin');
  const version = ctx.app?.version;
  if (!onPath(bin)) {
    plugin.log(
      `bin/ cannot go on PATH: its path holds "${hostDelimiter}", the PATH delimiter (${bin}). ` +
        'Shell commands run without pdkit on PATH; install the plugin from the registry or a directory.',
    );
  }

  await ctx.shell.hook('create.before', (event) => {
    try {
      if (event?.env !== null && typeof event?.env === 'object') prepare(event.env, { bin, version });
    } catch (error) {
      plugin.log(`cannot put bin/ on the PATH of a shell command (${reason(error)}); it runs without it`);
    }
  });
}
