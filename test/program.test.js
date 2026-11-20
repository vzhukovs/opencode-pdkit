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

// Tests for lib/program.js: finding a program npm installs on PATH, and
// starting it without a shell.
//
// What a .cmd starts is read from its text, so that part is tested on every
// platform, against the text npm, corepack and Node's own npm.cmd have.
// Looking on PATH is Windows' alone, and so are the tests of it.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { UNREADABLE, batchTarget, execProgram, locate } from '../lib/program.js';
import { corepackShim, installScript, placeProgram, programShim, scriptShim } from './helpers/npm-shim.js';

const POSIX = platform() !== 'win32';
const ONLY_WINDOWS = POSIX && 'PATH is looked up by execFile itself here';

// Node's own npm.cmd, as Node 24 ships it: written by hand, and what it starts
// is decided as it runs.
const NODE_NPM_CMD = [
  ":: Created by npm, please don't edit manually.",
  '@ECHO OFF',
  '',
  'SETLOCAL',
  '',
  'SET "NODE_EXE=%~dp0\\node.exe"',
  'IF NOT EXIST "%NODE_EXE%" (',
  '  SET "NODE_EXE=node"',
  ')',
  '',
  'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
  'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"',
  'FOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"\') DO (',
  '  SET "NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js"',
  ')',
  'IF EXIST "%NPM_PREFIX_NPM_CLI_JS%" (',
  '  SET "NPM_CLI_JS=%NPM_PREFIX_NPM_CLI_JS%"',
  ')',
  '',
  '"%NODE_EXE%" "%NPM_CLI_JS%" %*',
  '',
].join('\r\n');

/** execProgram as a promise: what it gave the callback. */
function started(command, args, options) {
  return new Promise((resolve) => execProgram(command, args, options, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
}

describe('what a .cmd starts', () => {
  test('npm’s for a program: the program', () => {
    const file = 'node_modules\\@opencode\\cli\\bin\\opencode.exe';

    assert.deepEqual(batchTarget(programShim(file)), { program: file });
  });

  test('npm’s for a Node script: the script, which node starts', () => {
    const file = 'node_modules\\pnpm\\bin\\pnpm.cjs';

    assert.deepEqual(batchTarget(scriptShim(file)), { script: file });
  });

  test('corepack’s: the script', () => {
    const file = 'node_modules\\corepack\\dist\\pnpm.js';

    assert.deepEqual(batchTarget(corepackShim(file)), { script: file });
  });

  test('a file outside the .cmd’s directory is named as it is written', () => {
    assert.deepEqual(batchTarget(corepackShim('..\\pnpm\\bin\\pnpm.cjs')), { script: '..\\pnpm\\bin\\pnpm.cjs' });
  });

  test('Node’s own npm.cmd is not one of theirs: what it starts is decided as it runs', () => {
    assert.equal(batchTarget(NODE_NPM_CMD), undefined);
  });

  test('a script started with anything but node is not', () => {
    const bash = scriptShim('node_modules\\tool\\bin\\tool.sh').replaceAll('node.exe', 'bash.exe').replace('"_prog=node"', '"_prog=bash"');

    assert.equal(batchTarget(bash), undefined);
  });

  test('nor is a .cmd that names nothing beside it, or two things', () => {
    assert.equal(batchTarget('@echo off\r\nopencode-real.exe %*\r\n'), undefined);
    assert.equal(batchTarget('"%~dp0\\a.exe" %*\r\n"%~dp0\\b.exe" %*\r\n'), undefined);
  });
});

describe('starting a program', () => {
  test('one on PATH runs, and what it printed comes back', async () => {
    const { error, stdout } = await started('node', ['-e', 'process.stdout.write("printed")'], { encoding: 'utf8' });

    assert.equal(error, null);
    assert.equal(stdout, 'printed');
  });

  test('none on PATH is ENOENT, as execFile says it', { skip: ONLY_WINDOWS }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pdkit-program-'));
    try {
      const { error } = await started('pdkit-no-such-program', [], { env: { PATH: dir } });

      assert.equal(error.code, 'ENOENT');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a batch file none of them wrote is not run, and is named', { skip: ONLY_WINDOWS }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pdkit-program-'));
    try {
      await writeFile(join(dir, 'pnpm.cmd'), '@echo off\r\necho ran\r\n');
      const { error, stdout } = await started('pnpm', ['--version'], { env: { PATH: dir } });

      assert.equal(error.code, UNREADABLE);
      assert.equal(error.message, `pnpm is ${join(dir, 'pnpm.cmd')}, a batch file npm, pnpm or corepack did not write, and pdkit runs none through cmd.exe`);
      assert.equal(stdout, '');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a script is started with the node beside the .cmd when there is one, as the .cmd does', { skip: ONLY_WINDOWS }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pdkit-program-'));
    try {
      await installScript(dir, { command: 'pnpm', pkg: 'pnpm', script: 'console.log("11.0.0")' });
      await placeProgram(join(dir, 'node.exe'), process.execPath);

      assert.deepEqual(await locate('pnpm', { PATH: dir }), { file: join(dir, 'node.exe'), args: [join(dir, 'node_modules', 'pnpm', 'bin', 'pnpm.js')] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('and with the node on PATH when there is not', { skip: ONLY_WINDOWS }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pdkit-program-'));
    try {
      await writeFile(join(dir, 'pnpm.cmd'), corepackShim('node_modules\\corepack\\dist\\pnpm.js'));
      const path = `${dir}${delimiter}${dirname(process.execPath)}`;

      assert.deepEqual(await locate('pnpm', { PATH: path }), { file: process.execPath, args: [join(dir, 'node_modules', 'corepack', 'dist', 'pnpm.js')] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // cmd.exe and libuv look in the working directory first, and the working
  // directory is a repository: a program it holds would be the one run.
  test('neither the working directory nor a relative entry of PATH is looked in', { skip: ONLY_WINDOWS }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pdkit-program-'));
    const was = process.cwd();
    try {
      await placeProgram(join(dir, 'opencode.exe'), process.execPath);
      process.chdir(dir);

      assert.equal(await locate('opencode', { PATH: `.${delimiter}` }), undefined);
    } finally {
      process.chdir(was);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
