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

// What `npm install --global` leaves on PATH on Windows: a .cmd per command of
// a package, next to its node_modules, which runs the package's own file.
//
// The text is what npm 11 writes (its cmd-shim), CRLF and all, in its two
// forms: for a command that is a Node script, the .cmd runs node with it; for
// one that is a program, as Open Code's `bin/opencode.exe` is, the .cmd runs
// the program. And corepack's, which Node's own directory has for pnpm. None
// is something execFile runs: it starts only an .exe or a .com, and Node
// refuses a .cmd without a shell (CVE-2024-27980).
//
// Outside `test/*.test.js`, so the runner does not collect it as a suite.

import { copyFile, link, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * The .cmd npm writes for a command whose file is a Node script.
 *
 * @param {string} file the script, from the prefix, with backslashes
 * @returns {string}
 */
export function scriptShim(file) {
  return [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${file}" %*`,
    '',
  ].join('\r\n');
}

/**
 * The .cmd npm writes for a command whose file is a program of its own.
 *
 * @param {string} file the program, from the prefix, with backslashes
 * @returns {string}
 */
export function programShim(file) {
  return ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', `"%dp0%\\${file}"   %*`, ''].join(
    '\r\n',
  );
}

/**
 * Lay out in `prefix` what npm leaves there for a package whose `command` is
 * a Node script: node_modules/<package>/bin/<command>.js, and <command>.cmd.
 *
 * @param {string} prefix
 * @param {{command: string, pkg: string, script: string}} what `script`: the body, under a node shebang
 */
export async function installScript(prefix, { command, pkg, script }) {
  const file = join('node_modules', pkg, 'bin', `${command}.js`);
  await mkdir(dirname(join(prefix, file)), { recursive: true });
  await writeFile(join(prefix, file), `#!/usr/bin/env node\n${script}\n`);
  await writeFile(join(prefix, `${command}.cmd`), scriptShim(file));
}

/**
 * The .cmd corepack writes beside node.exe for a command it provides, pnpm's
 * among them (`corepack enable`), in the form older cmd-shims wrote too.
 *
 * @param {string} file the script, from the directory of the .cmd, with backslashes
 * @returns {string}
 */
export function corepackShim(file) {
  return [
    '@SETLOCAL',
    '@IF EXIST "%~dp0\\node.exe" (',
    `  "%~dp0\\node.exe"  "%~dp0\\${file}" %*`,
    ') ELSE (',
    '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
    `  node  "%~dp0\\${file}" %*`,
    ')',
    '',
  ].join('\r\n');
}

/**
 * Run `body` with this process's PATH set to `path`, and put it back after:
 * for what runs a program on this process's own PATH.
 *
 * @template T
 * @param {string} path
 * @param {() => Promise<T>} body
 * @returns {Promise<T>}
 */
export async function withPath(path, body) {
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const was = process.env[key];
  process.env[key] = path;
  try {
    return await body();
  } finally {
    process.env[key] = was;
  }
}

/**
 * Put `program` at `path`: linked, or copied where it cannot be.
 *
 * @param {string} path
 * @param {string} program
 */
export async function placeProgram(path, program) {
  await mkdir(dirname(path), { recursive: true });
  await link(program, path).catch(() => copyFile(program, path));
}

/**
 * Lay out in `prefix` what npm leaves there for a package whose `command` is
 * a program: node_modules/<package>/bin/<command>.exe, and <command>.cmd.
 * The program is `program` itself.
 *
 * @param {string} prefix
 * @param {{command: string, pkg: string, program: string}} what
 */
export async function installProgram(prefix, { command, pkg, program }) {
  const file = join('node_modules', pkg, 'bin', `${command}.exe`);
  await placeProgram(join(prefix, file), program);
  await writeFile(join(prefix, `${command}.cmd`), programShim(file));
}
