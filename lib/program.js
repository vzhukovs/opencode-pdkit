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

// Where a program that npm installs is on PATH, and how to start it without a
// shell.
//
// On POSIX that is execFile's own business: it finds the name on PATH, and the
// kernel reads a script's shebang. On Windows execFile starts only an .exe or
// a .com, and Node refuses a .cmd without a shell (CVE-2024-27980) — while
// `npm install -g` puts a program on PATH as a .cmd: Open Code's opencode.cmd,
// which starts its opencode.exe, and corepack's pnpm.CMD, which starts node
// with pnpm's script. Through cmd.exe the arguments would be read a second
// time — %VAR% expanded, & a separator — in ways no escaping survives, and a
// deadline would stop cmd.exe and leave the program it started running.
//
// So on Windows the program is looked for as the shell looks for it — the
// directories of PATH in order, and in each the extensions of PATHEXT in
// theirs — and a .cmd is read for what it starts: the .cmd that npm, pnpm and
// corepack write names it beside its own directory (`%dp0%`, `%~dp0`), the
// program itself or a script node runs. That is started directly, with the
// arguments as they were given. A batch file written any other way is not
// run, and is named. Neither the working directory nor a relative entry of
// PATH is searched, as cmd.exe and libuv would: the working directory is a
// repository.

import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { platform } from 'node:os';
import { win32 } from 'node:path';
import { promisify } from 'node:util';

/** The error code of a batch file whose program cannot be read from it. */
export const UNREADABLE = 'ERR_PDKIT_BATCH_FILE';

/** How a file is started, by the extension PATHEXT gives it; the others are not. */
const KINDS = new Map([
  ['.com', 'program'],
  ['.exe', 'program'],
  ['.bat', 'batch'],
  ['.cmd', 'batch'],
]);

/** PATHEXT when the environment has none: those of KINDS, in Windows' order. */
const PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** A file a .cmd names beside its own directory: `"%dp0%\…"` (npm) or `"%~dp0\…"` (pnpm, corepack). */
const BESIDE = /"%(?:dp0%|~dp0)\\?([^"%]+)"/gi;

/** The node.exe that npm's and corepack's .cmd start a script with when there is one beside it. */
const NODE_BESIDE = /%(?:dp0%|~dp0)\\?node\.exe\b/i;

/**
 * What a .cmd that npm, pnpm or corepack wrote starts, from its text.
 *
 * One file is named beside the .cmd's own directory, node.exe aside: the
 * program, an .exe or a .com, which the .cmd starts with the arguments it is
 * given; or a script, which it starts with node — the one beside it, or the
 * one on PATH. A .cmd that names none, or more than one, or a script it starts
 * with anything but node, is not one of theirs.
 *
 * @param {string} text
 * @returns {{program: string} | {script: string} | undefined} the path, from the .cmd's directory
 */
export function batchTarget(text) {
  const named = new Set();
  for (const [, path] of String(text).matchAll(BESIDE)) {
    if (win32.basename(path).toLowerCase() !== 'node.exe') named.add(win32.normalize(path));
  }
  if (named.size !== 1) return undefined;

  const [path] = named;
  if (/\.(?:exe|com)$/i.test(path)) return { program: path };
  return NODE_BESIDE.test(text) ? { script: path } : undefined;
}

/**
 * An environment variable, under whatever case Windows spells its name in.
 *
 * @param {Record<string, string|undefined>} env
 * @param {string} name upper case
 * @returns {string|undefined}
 */
function variable(env, name) {
  const key = Object.keys(env).find((entry) => entry.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/** @param {string} path */
async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * The first file the shell would start for `command`, of the kinds asked for.
 *
 * @param {string} command
 * @param {Record<string, string|undefined>} env
 * @param {string[]} kinds of KINDS
 * @returns {Promise<{path: string, kind: string} | undefined>}
 */
async function search(command, env, kinds) {
  const extensions = (variable(env, 'PATHEXT') || PATHEXT)
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => kinds.includes(KINDS.get(extension) ?? ''));
  for (const entry of String(variable(env, 'PATH') ?? '').split(';')) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!/^(?:[A-Za-z]:[\\/]|\\\\)/.test(dir)) continue;
    for (const extension of extensions) {
      const path = win32.join(dir, `${command}${extension}`);
      if (await isFile(path)) return { path, kind: /** @type {string} */ (KINDS.get(extension)) };
    }
  }
  return undefined;
}

/**
 * Where `command` is on the PATH of `env` on Windows, and what starts it
 * there without a shell.
 *
 * @param {string} command a bare name
 * @param {Record<string, string|undefined>} env
 * @returns {Promise<{file: string, args: string[]} | {batch: string} | undefined>}
 *   `file` with `args` before the caller's; `batch`: a batch file whose program
 *   cannot be read from it; undefined: none
 */
export async function locate(command, env) {
  const found = await search(command, env, ['program', 'batch']);
  if (found === undefined) return undefined;
  if (found.kind === 'program') return { file: found.path, args: [] };

  const dir = win32.dirname(found.path);
  const target = batchTarget(await readFile(found.path, 'utf8').catch(() => ''));
  if (target === undefined) return { batch: found.path };
  if ('program' in target) return { file: win32.resolve(dir, target.program), args: [] };

  const script = win32.resolve(dir, target.script);
  const beside = win32.join(dir, 'node.exe');
  if (await isFile(beside)) return { file: beside, args: [script] };
  const node = await search('node', env, ['program']);
  return node === undefined ? undefined : { file: node.path, args: [script] };
}

/**
 * execFile, with `command` found as the shell finds it: on Windows, the
 * program a .cmd of npm, pnpm or corepack starts. The PATH searched is
 * `options.env`'s, or this process's. A message that names the command line
 * names it as it was asked for, not as it was started.
 *
 * @param {string} command a bare name
 * @param {string[]} args
 * @param {import('node:child_process').ExecFileOptions} options
 * @param {(error: any, stdout: string, stderr: string) => void} callback
 */
export function execProgram(command, args, options, callback) {
  if (platform() !== 'win32') {
    execFile(command, args, options, callback);
    return;
  }

  locate(command, options?.env ?? process.env).then(
    (found) => {
      if (found === undefined) {
        callback(Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT', syscall: `spawn ${command}`, path: command }), '', '');
        return;
      }
      if ('batch' in found) {
        const message = `${command} is ${found.batch}, a batch file npm, pnpm or corepack did not write, and pdkit runs none through cmd.exe`;
        callback(Object.assign(new Error(message), { code: UNREADABLE }), '', '');
        return;
      }
      const started = `Command failed: ${[found.file, ...found.args, ...args].join(' ')}`;
      execFile(found.file, [...found.args, ...args], options, (error, stdout, stderr) => {
        if (error && error.message.startsWith(started)) {
          error.message = `Command failed: ${[command, ...args].join(' ')}${error.message.slice(started.length)}`;
        }
        callback(error, stdout, stderr);
      });
    },
    (error) => callback(error, '', ''),
  );
}

// As execFile's: resolves to { stdout, stderr }, and an error carries both.
Object.defineProperty(execProgram, promisify.custom, {
  value: (command, args, options) =>
    new Promise((resolve, reject) => {
      execProgram(command, args, options, (error, stdout, stderr) =>
        error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }),
      );
    }),
});
