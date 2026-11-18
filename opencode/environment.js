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
//   - what `pdkit doctor` needs to know about the server and cannot see from
//     a shell goes beside it, as labels: the version of the Open Code server
//     running the plugin (the minimum is about that server), the hook events
//     the plugin registered there, and the `node` on the server's PATH, which
//     every hook runs with. A label missing from a session's command tells the
//     doctor as much as one present: no plugin set it.
//
// The hook runs for the model's commands, in the foreground and in the
// background, for a subagent's, and for a person's `!` command in the TUI. It
// does not run for a `!`cmd`` in a command template, which this plugin does not
// use. The session a command runs in needs nothing from here: the shell tool
// sets that variable itself, after this hook (lib/harness.js names it).
//
// One install puts bin/ where PATH cannot name it. Open Code installs a package
// under a directory named after its specifier, and `file:<tarball>` — how the
// plugin is tried before it is published — brings a colon, PATH's delimiter,
// into every path of the plugin. There setup links `pdkit` from a directory of
// the user's own cache whose path has no delimiter (standIn), and that
// directory goes first on PATH instead. Node runs a linked script from the
// file the link resolves to, so bin/pdkit still finds lib/ beside it.

import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readlink, rename, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter as hostDelimiter, isAbsolute, join, resolve } from 'node:path';

import { REGISTERED_VARIABLE } from '../lib/hooks/events.js';
import { NODE_VARIABLE, nodeLabel, nodeVersion } from '../lib/hooks/runner.js';
import { SERVER_VERSION_VARIABLE } from '../lib/opencode-version.js';

/**
 * @param {unknown} error
 * @returns {string}
 */
const reason = (error) => (error instanceof Error ? error.message : String(error));

/**
 * Put `bin` first on the PATH of `env` and the labels beside it. Changes `env`
 * in place, which is how the hook hands a change back.
 *
 * An empty or missing PATH becomes `bin` alone, not `bin` and an empty entry:
 * the shell reads an empty entry as the working directory. An entry equal to
 * `bin` further along is dropped, so a command started from a shell this hook
 * already prepared does not carry it twice. Every other entry keeps its place.
 *
 * A `bin` whose path holds the delimiter leaves PATH as it was (see
 * onPath). A label without a value — a version that is not a non-empty
 * string, `hooks` that are not a list, a `node` that is not a non-empty
 * string — removes the variable rather than leaving one the environment came
 * with: that one would describe some other server, or another instance of
 * the plugin.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{bin: string, version: unknown, hooks?: unknown, node?: unknown, delimiter?: string, windows?: boolean}} options
 *   `version` is the server's; `hooks`, the events the plugin registered;
 *   `node`, what NODE_VARIABLE says (lib/hooks/runner.js). `delimiter` and
 *   `windows` default to the host's; tests pass another's
 * @returns {Record<string, string | undefined>} env
 */
export function prepare(env, { bin, version, hooks, node, delimiter = hostDelimiter, windows = process.platform === 'win32' }) {
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

  if (Array.isArray(hooks)) env[REGISTERED_VARIABLE] = hooks.join(',');
  else delete env[REGISTERED_VARIABLE];

  if (typeof node === 'string' && node !== '') env[NODE_VARIABLE] = node;
  else delete env[NODE_VARIABLE];

  return env;
}

/**
 * Whether a directory can be an entry of PATH at all.
 *
 * PATH has no escape for its delimiter, so a directory whose path holds one
 * splits into two entries that name nothing. Open Code installs a package
 * under a directory named after its specifier: `opencode-pdkit@…` from the
 * registry is safe, but `file:<tarball>` puts a colon in every path of the
 * plugin. Better to leave PATH alone there than to fill it with fragments;
 * registerEnvironment puts a stand-in there instead when it can (standIn).
 *
 * @param {string} dir
 * @param {string} [delimiter]
 * @returns {boolean}
 */
export function onPath(dir, delimiter = hostDelimiter) {
  return !dir.includes(delimiter);
}

/**
 * The user's cache directory, by the XDG Base Directory rule: XDG_CACHE_HOME
 * when it is an absolute path, ~/.cache otherwise. Open Code keeps its own
 * cache, this package's install included, under the same variable.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {() => string} [home]
 * @returns {string}
 */
export function cacheHome(env = process.env, home = homedir) {
  const xdg = env.XDG_CACHE_HOME;
  return typeof xdg === 'string' && isAbsolute(xdg) ? xdg : join(home(), '.cache');
}

/**
 * A directory PATH can name, holding one entry: `pdkit`, a symbolic link to
 * the plugin's bin/pdkit. Returns the directory; throws when it cannot make
 * one that is safe to put first on PATH.
 *
 * `<cache>/opencode-pdkit/bin-<hash of the root>/`: one directory per plugin
 * root, so two installs never share a link, and every instance of one install
 * (Open Code loads the plugin once for each directory it serves) makes the
 * same one. It goes in the user's own cache and not in a shared place such as
 * /tmp, where anyone could put their own pdkit first on this user's PATH; for
 * the same reason a directory along the way that is a link, belongs to someone
 * else, or that others can write to is refused rather than used.
 *
 * The link is made beside its final name and renamed onto it, which replaces
 * whatever was there in one step: instances that make it at the same moment
 * each leave a whole link, and a command never finds half of one.
 *
 * Nothing removes the directory. An install that Open Code has removed leaves
 * a dangling link behind, which no PATH this module builds names any more.
 *
 * @param {string} root
 * @param {{cache: string, delimiter?: string}} options
 * @returns {Promise<string>} the directory
 */
export async function standIn(root, { cache, delimiter = hostDelimiter }) {
  const own = join(cache, 'opencode-pdkit');
  const dir = join(own, `bin-${createHash('sha256').update(resolve(root)).digest('hex').slice(0, 16)}`);
  if (!onPath(dir, delimiter)) throw new Error(`the cache directory holds "${delimiter}" too (${dir})`);

  // Each level is checked before anything goes into it.
  await mkdir(own, { recursive: true, mode: 0o700 });
  await assertPrivate(own);
  await mkdir(dir, { mode: 0o700 }).catch((error) => {
    if (error?.code !== 'EEXIST') throw error;
  });
  await assertPrivate(dir);

  const link = join(dir, 'pdkit');
  const target = join(root, 'bin', 'pdkit');
  if ((await readlink(link).catch(() => undefined)) === target) return dir;

  const made = join(dir, `.pdkit-${process.pid}-${randomBytes(6).toString('hex')}`);
  await symlink(target, made);
  try {
    await rename(made, link);
  } catch (error) {
    await rm(made, { force: true });
    throw error;
  }
  return dir;
}

/**
 * Throw unless `dir` is a directory of this user's that no one else can write
 * to. Not a link: lstat, so a link to someone else's directory is refused too.
 *
 * @param {string} dir
 */
async function assertPrivate(dir) {
  const stats = await lstat(dir);
  if (!stats.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error(`${dir} belongs to another user`);
  }
  if ((stats.mode & 0o022) !== 0) throw new Error(`${dir} can be written by others`);
}

/**
 * The directory to put first on PATH: bin/ itself where PATH can name it, a
 * stand-in where it cannot. When neither works, bin/ comes back anyway, and
 * prepare leaves PATH alone for it; the reason goes to the log once, here,
 * rather than once per command.
 *
 * Not on Windows, which keeps the behavior above: its delimiter is a
 * semicolon, not the colon of `file:`, and a symbolic link there needs a
 * privilege most accounts lack.
 *
 * @param {{root: string, log: (line: string) => void}} plugin
 * @param {{cache?: string, windows: boolean}} options
 * @returns {Promise<string>}
 */
async function pathEntry(plugin, { cache, windows }) {
  const bin = join(plugin.root, 'bin');
  if (onPath(bin)) return bin;

  const cannot = `bin/ cannot go on PATH: its path holds "${hostDelimiter}", the PATH delimiter (${bin})`;
  const without = 'Shell commands run without pdkit on PATH; install the plugin from the registry or a directory.';
  if (windows) {
    plugin.log(`${cannot}. ${without}`);
    return bin;
  }
  try {
    return await standIn(plugin.root, { cache: cache ?? cacheHome() });
  } catch (error) {
    plugin.log(`${cannot}, and no directory to link pdkit from could be made (${reason(error)}). ${without}`);
    return bin;
  }
}

/**
 * What NODE_VARIABLE says for this server: the `node` the hooks start, asked
 * once, here. The server's PATH does not change while it runs, and asking on
 * every command would start a process for each. Never throws.
 *
 * @param {() => Promise<{ok: true, version: string} | {ok: false, detail: string}>} probe
 * @returns {Promise<string>}
 */
async function nodeOfHooks(probe) {
  try {
    return nodeLabel(await probe());
  } catch (error) {
    return nodeLabel({ ok: false, detail: `it could not be asked (${reason(error)})` });
  }
}

/**
 * Register the create.before callback.
 *
 * The callback does not throw, and a stand-in that cannot be made does not
 * make this throw either. What Open Code does with a throw in the callback is
 * unverified; a command that runs without this plugin's bin/ on its PATH
 * fails or runs another pdkit, which is no worse than the hook missing.
 *
 * @param {object} ctx the plugin context setup() received
 * @param {{root: string, log: (line: string) => void}} plugin
 * @param {{
 *   cache?: string,
 *   windows?: boolean,
 *   hooks?: () => readonly string[] | undefined,
 *   probe?: () => Promise<{ok: true, version: string} | {ok: false, detail: string}>,
 * }} [options]
 *   where a stand-in goes (cacheHome when not given) and whether this is
 *   Windows (the host's answer when not given); `hooks`, the events the
 *   plugin registered, read on every command (the bridge's registered(); none
 *   given, no label); `probe`, how the `node` of the hooks is asked
 *   (nodeVersion with the server's environment when not given). Tests pass
 *   their own
 */
export async function registerEnvironment(ctx, plugin, { cache, windows = process.platform === 'win32', hooks = () => undefined, probe = nodeVersion } = {}) {
  const bin = await pathEntry(plugin, { cache, windows });
  const version = ctx.app?.version;
  const node = await nodeOfHooks(probe);

  // A list that cannot be read is no label, not a command without bin/.
  const registered = () => {
    try {
      return hooks();
    } catch {
      return undefined;
    }
  };

  await ctx.shell.hook('create.before', (event) => {
    try {
      if (event?.env !== null && typeof event?.env === 'object') prepare(event.env, { bin, version, hooks: registered(), node });
    } catch (error) {
      plugin.log(`cannot put bin/ on the PATH of a shell command (${reason(error)}); it runs without it`);
    }
  });
}
