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

// The environment the shell create.before hook gives every shell command:
// the plugin's bin/ first on PATH, and the server's version beside it.
//
// The events are stand-ins shaped like the ones Open Code 2.3.0 sends
// (`{ command, cwd, timeout, shell, env }`, no session). The last block runs a
// real shell with the environment the hook built, a second `pdkit` on its PATH
// included, which is the case first-on-PATH exists for.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { onPath, prepare, registerEnvironment } from '../opencode/environment.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BIN = join(ROOT, 'bin');

const POSIX = { delimiter: ':', windows: false };
const WINDOWS = { delimiter: ';', windows: true };

/** A create.before event as Open Code 2.3.0 sends it. */
const event = (env) => ({ command: 'pdkit --help', cwd: '/work/project', timeout: 120000, shell: '/bin/zsh', env });

describe('bin/ goes first on PATH', () => {
  test('ahead of everything the command inherited', () => {
    const env = prepare({ PATH: '/usr/local/bin:/usr/bin:/bin' }, { bin: '/plugin/bin', version: '2.3.0', ...POSIX });

    assert.equal(env.PATH, '/plugin/bin:/usr/local/bin:/usr/bin:/bin');
  });

  // Where another pdkit comes from: the Claude Code plugin's bin/ on the PATH
  // of the client or of the server that runs the command.
  test('ahead of another directory with a pdkit in it', () => {
    const env = prepare({ PATH: '/usr/bin:/old/podman-desktop-kit/bin' }, { bin: '/plugin/bin', version: '2.3.0', ...POSIX });

    assert.deepEqual(env.PATH.split(':'), ['/plugin/bin', '/usr/bin', '/old/podman-desktop-kit/bin']);
  });

  // An empty entry is the working directory to the shell. `bin:` would put
  // whatever the current directory holds on PATH.
  test('an empty PATH becomes bin/ alone, without an empty entry', () => {
    assert.equal(prepare({ PATH: '' }, { bin: '/plugin/bin', version: '2.3.0', ...POSIX }).PATH, '/plugin/bin');
  });

  test('so does a missing one', () => {
    const env = prepare({ HOME: '/home/someone' }, { bin: '/plugin/bin', version: '2.3.0', ...POSIX });

    assert.equal(env.PATH, '/plugin/bin');
    assert.equal(env.HOME, '/home/someone');
  });

  test('bin/ already on PATH is moved to the front, not added twice', () => {
    const env = prepare({ PATH: '/plugin/bin:/usr/bin:/plugin/bin:/bin' }, { bin: '/plugin/bin', version: '2.3.0', ...POSIX });

    assert.equal(env.PATH, '/plugin/bin:/usr/bin:/bin');
  });

  test("entries the command inherited keep their order, empty ones included: they are someone's choice", () => {
    const env = prepare({ PATH: '/b:/a::/c:' }, { bin: '/plugin/bin', version: '2.3.0', ...POSIX });

    assert.equal(env.PATH, '/plugin/bin:/b:/a::/c:');
  });

  test('changes the event in place, which is how the hook hands it back', () => {
    const env = { PATH: '/usr/bin' };

    assert.equal(prepare(env, { bin: '/plugin/bin', version: '2.3.0', ...POSIX }), env);
    assert.equal(env.PATH, '/plugin/bin:/usr/bin');
  });

  test("with the host's delimiter when none is given", () => {
    const env = prepare({ PATH: ['/one', '/two'].join(delimiter) }, { bin: '/plugin/bin', version: '2.3.0' });

    assert.equal(env.PATH, ['/plugin/bin', '/one', '/two'].join(delimiter));
  });
});

// Open Code names the directory it installs a package in after the specifier,
// so a plugin installed as `file:<tarball>` has a colon in its path (seen on
// 2.3.0: `~/.cache/opencode/npm/file:/…/opencode-pdkit-0.15.0.tgz/…`). PATH
// cannot hold such an entry: it would split into two that name nothing.
describe('a bin/ whose path holds the delimiter', () => {
  const FILE_INSTALL = '/home/someone/.cache/opencode/npm/file:/tmp/pack/opencode-pdkit-0.16.0.tgz/1763300000000/node_modules/opencode-pdkit/bin';

  test('leaves PATH as it was, rather than add two fragments', () => {
    const env = prepare({ PATH: '/usr/bin:/bin' }, { bin: FILE_INSTALL, version: '2.3.0', ...POSIX });

    assert.equal(env.PATH, '/usr/bin:/bin');
    assert.equal(env.PDKIT_OPENCODE_VERSION, '2.3.0', 'the version still goes in');
  });

  test('a colon is the delimiter only off Windows', () => {
    assert.equal(onPath(FILE_INSTALL, ':'), false);
    assert.equal(onPath('C:\\Users\\someone\\plugin\\bin', ';'), true);
    assert.equal(onPath('C:\\odd;name\\bin', ';'), false);
  });

  test('registering says so once in the log, not once per command', async () => {
    const lines = [];
    const registered = [];
    const ctx = { app: { version: '2.3.0' }, shell: { hook: async (name, callback) => registered.push(callback) } };
    const root = `${tmpdir()}${delimiter}odd`;

    await registerEnvironment(ctx, { root, log: (line) => lines.push(line) });
    const created = event({ PATH: '/usr/bin' });
    await registered[0](created);
    await registered[0](event({ PATH: '/usr/bin' }));

    assert.equal(created.env.PATH, '/usr/bin');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^bin\/ cannot go on PATH: its path holds ".", the PATH delimiter \(.+\)\. Shell commands run without pdkit on PATH;/);
  });
});

describe('on Windows', () => {
  test('the delimiter is a semicolon', () => {
    const env = prepare({ PATH: 'C:\\Windows\\system32;C:\\Windows' }, { bin: 'C:\\plugin\\bin', version: '2.3.0', ...WINDOWS });

    assert.equal(env.PATH, 'C:\\plugin\\bin;C:\\Windows\\system32;C:\\Windows');
  });

  // Windows matches variable names without regard to case, and PATH usually
  // arrives as `Path`. A second variable beside it would leave which one the
  // process sees to whatever starts it.
  test('PATH is changed under the name it came with', () => {
    const env = prepare({ Path: 'C:\\Windows' }, { bin: 'C:\\plugin\\bin', version: '2.3.0', ...WINDOWS });

    assert.deepEqual(Object.keys(env), ['Path', 'PDKIT_OPENCODE_VERSION']);
    assert.equal(env.Path, 'C:\\plugin\\bin;C:\\Windows');
  });

  test('an empty or missing PATH becomes bin/ alone there too', () => {
    assert.equal(prepare({ Path: '' }, { bin: 'C:\\plugin\\bin', version: '2.3.0', ...WINDOWS }).Path, 'C:\\plugin\\bin');
    assert.equal(prepare({}, { bin: 'C:\\plugin\\bin', version: '2.3.0', ...WINDOWS }).PATH, 'C:\\plugin\\bin');
  });

  test('elsewhere, `Path` is not PATH', () => {
    const env = prepare({ Path: '/not/the/path', PATH: '/usr/bin' }, { bin: '/plugin/bin', version: '2.3.0', ...POSIX });

    assert.equal(env.Path, '/not/the/path');
    assert.equal(env.PATH, '/plugin/bin:/usr/bin');
  });
});

describe("the server's version", () => {
  // The name is doctor's to read, so it is pinned here rather than taken from
  // the module that defines it.
  test('goes into PDKIT_OPENCODE_VERSION', () => {
    assert.equal(prepare({}, { bin: '/plugin/bin', version: '2.3.0', ...POSIX }).PDKIT_OPENCODE_VERSION, '2.3.0');
  });

  test('as the server reports it, a build that is not a release included: doctor judges it', () => {
    for (const version of ['0.0.0-dev-1297', 'local', '2.4.1']) {
      assert.equal(prepare({}, { bin: '/plugin/bin', version, ...POSIX }).PDKIT_OPENCODE_VERSION, version);
    }
  });

  test('replaces one the command inherited, which would describe another server', () => {
    const env = prepare({ PDKIT_OPENCODE_VERSION: '2.2.7' }, { bin: '/plugin/bin', version: '2.3.0', ...POSIX });

    assert.equal(env.PDKIT_OPENCODE_VERSION, '2.3.0');
  });

  test('removes it when the server reported none', () => {
    for (const version of [undefined, '', 230, null]) {
      const env = prepare({ PDKIT_OPENCODE_VERSION: '2.2.7' }, { bin: '/plugin/bin', version, ...POSIX });
      assert.equal('PDKIT_OPENCODE_VERSION' in env, false, `${JSON.stringify(version)} left the inherited value`);
    }
  });
});

describe('the create.before callback', () => {
  /** A context with only what registerEnvironment touches. */
  function host(app = { name: 'cli', version: '2.3.0', channel: 'latest' }) {
    const registered = [];
    const lines = [];
    const ctx = { app, shell: { hook: async (name, callback) => registered.push({ name, callback }) } };
    return { ctx, registered, plugin: { root: ROOT, log: (line) => lines.push(line) }, lines };
  }

  test('is registered on shell create.before, once', async () => {
    const { ctx, registered, plugin } = host();

    await registerEnvironment(ctx, plugin);

    assert.deepEqual(
      registered.map(({ name }) => name),
      ['create.before'],
    );
  });

  test("puts this plugin's bin/ first and ctx.app.version beside it", async () => {
    const { ctx, registered, plugin } = host();
    await registerEnvironment(ctx, plugin);
    const created = event({ PATH: ['/usr/bin', '/bin'].join(delimiter), TERM: 'xterm-256color' });

    await registered[0].callback(created);

    assert.equal(created.env.PATH, [BIN, '/usr/bin', '/bin'].join(delimiter));
    assert.equal(created.env.PDKIT_OPENCODE_VERSION, '2.3.0');
    assert.equal(created.env.TERM, 'xterm-256color');
    assert.equal(created.command, 'pdkit --help', "the command is not the hook's to change");
  });

  // The session is the shell tool's to set, after this hook; the plugin
  // neither sets one nor removes the one Claude Code may have left.
  test('sets no session variable of its own and leaves the others alone', async () => {
    const { ctx, registered, plugin } = host();
    await registerEnvironment(ctx, plugin);
    const created = event({ PATH: '/usr/bin', CLAUDE_CODE_SESSION_ID: 'e7fee23a-left-over' });

    await registered[0].callback(created);

    assert.deepEqual(Object.keys(created.env).sort(), ['CLAUDE_CODE_SESSION_ID', 'PATH', 'PDKIT_OPENCODE_VERSION']);
  });

  test('without a version from the host, still puts bin/ on PATH', async () => {
    for (const app of [{ name: 'cli' }, null]) {
      const { ctx, registered, plugin } = host(app);
      await registerEnvironment(ctx, plugin);
      const created = event({ PATH: '/usr/bin' });

      await registered[0].callback(created);

      assert.equal(created.env.PATH.split(delimiter)[0], BIN, `ctx.app ${JSON.stringify(app)}`);
      assert.equal('PDKIT_OPENCODE_VERSION' in created.env, false, `ctx.app ${JSON.stringify(app)}`);
    }
  });

  test('never throws: an event without an environment is left as it is', async () => {
    const { ctx, registered, plugin, lines } = host();
    await registerEnvironment(ctx, plugin);

    for (const odd of [undefined, null, {}, { env: null }, { env: 'PATH=/usr/bin' }]) {
      await registered[0].callback(odd);
    }
    assert.deepEqual(lines, []);
  });

  test('nor when the environment refuses the change; it says so in the log', async () => {
    const { ctx, registered, plugin, lines } = host();
    await registerEnvironment(ctx, plugin);

    await registered[0].callback(event(Object.freeze({ PATH: '/usr/bin' })));

    assert.equal(lines.length, 1);
    assert.match(lines[0], /^cannot put bin\/ on the PATH of a shell command \(.+\); it runs without it$/);
  });
});

// A shell started with the environment the hook built, as Open Code starts
// one: `<shell> -c <command>`, no login, no rc files. POSIX only: on Windows
// bin/pdkit is not a command a shell runs by name.
describe('in a real shell', { skip: process.platform === 'win32' ? 'bin/pdkit runs by name only where a shebang does' : false }, () => {
  const run = promisify(execFile);

  test("`pdkit` is this plugin's, even with another pdkit on PATH", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'pdkit-environment-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const other = join(dir, 'other', 'bin');
    await mkdir(other, { recursive: true });
    await writeFile(join(other, 'pdkit'), '#!/bin/sh\necho "the other pdkit"\n');
    await chmod(join(other, 'pdkit'), 0o755);

    const env = prepare({ ...process.env, PATH: `${other}${delimiter}${process.env.PATH}` }, { bin: BIN, version: '2.3.0' });
    const shell = async (command) => (await run('/bin/sh', ['-c', command], { cwd: dir, env })).stdout.trim();

    assert.equal(await shell('command -v pdkit'), join(BIN, 'pdkit'));
    assert.match(await shell('pdkit --help'), /^  pdkit <command> \[options\]$/m);
    assert.equal(await shell('printf %s "$PDKIT_OPENCODE_VERSION"'), '2.3.0');
  });
});
