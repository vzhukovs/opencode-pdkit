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
// the plugin's bin/ first on PATH, and beside it the labels `pdkit doctor`
// reads — the server's version, the hook events that stood, the `node` the
// hooks start.
//
// The events are stand-ins shaped like the ones Open Code 2.3.0 sends
// (`{ command, cwd, timeout, shell, env }`, no session). The last block runs a
// real shell with the environment the hook built, a second `pdkit` on its PATH
// included, which is the case first-on-PATH exists for.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { cacheHome, onPath, prepare, registerEnvironment, standIn } from '../opencode/environment.js';

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

});

/** A context with only what registerEnvironment touches, and what it logged. */
function host(root, app = { name: 'cli', version: '2.3.0', channel: 'latest' }) {
  const registered = [];
  const lines = [];
  const ctx = { app, shell: { hook: async (name, callback) => registered.push({ name, callback }) } };
  return { ctx, registered, plugin: { root, log: (line) => lines.push(line) }, lines };
}

/**
 * A scratch directory with a cache in it and a plugin root under a directory
 * named the way Open Code 2.3.0 names the one it installs `file:<tarball>` in.
 * Through realpath: on macOS the temporary directory is reached by a link.
 */
async function scratch(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-stand-in-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const installed = (generation) =>
    join(dir, 'npm', `file:${dir}/pack/opencode-pdkit-0.16.0.tgz`, String(generation), 'node_modules', 'opencode-pdkit');
  return { dir, cache: join(dir, 'cache'), root: installed(1763300000000), installed };
}

// What setup does about such a bin/ off Windows: link pdkit from a directory
// of the user's cache that PATH can name, and put that directory first.
describe('a stand-in for a bin/ PATH cannot name', { skip: process.platform === 'win32' ? 'Windows makes none' : false }, () => {
  test('setup links pdkit from a directory of the cache and puts that first, with nothing to log', async (t) => {
    const { cache, root } = await scratch(t);
    const { ctx, registered, plugin, lines } = host(root);

    await registerEnvironment(ctx, plugin, { cache, windows: false });
    const created = event({ PATH: '/usr/bin:/bin' });
    await registered[0].callback(created);

    const [first, ...rest] = created.env.PATH.split(':');
    assert.match(first, new RegExp(`^${cache}/opencode-pdkit/bin-[0-9a-f]{16}$`));
    assert.deepEqual(rest, ['/usr/bin', '/bin']);
    assert.deepEqual(await readdir(first), ['pdkit']);
    assert.equal(await readlink(join(first, 'pdkit')), join(root, 'bin', 'pdkit'));
    assert.equal(created.env.PDKIT_OPENCODE_VERSION, '2.3.0');
    assert.deepEqual(lines, []);
  });

  // Anyone who can write to a directory first on PATH chooses what `pdkit` runs.
  test('only this user can write to the directories it made', async (t) => {
    const { cache, root } = await scratch(t);

    const dir = await standIn(root, { cache });

    for (const made of [join(cache, 'opencode-pdkit'), dir]) {
      const stats = await lstat(made);
      assert.equal(stats.isDirectory(), true, made);
      assert.equal(stats.mode & 0o077, 0, `${made} is open to others: ${(stats.mode & 0o777).toString(8)}`);
      assert.equal(stats.uid, process.getuid(), made);
    }
  });

  // Open Code loads the plugin once for each directory it serves, all in one
  // process, and their setups can overlap.
  test('every instance of one install makes the same one, and instances at once leave one whole link', async (t) => {
    const { cache, root } = await scratch(t);

    const dirs = await Promise.all(Array.from({ length: 8 }, () => standIn(root, { cache })));

    assert.equal(new Set(dirs).size, 1);
    assert.deepEqual(await readdir(dirs[0]), ['pdkit'], 'a link half made, or a second one, was left behind');
    assert.equal(await readlink(join(dirs[0], 'pdkit')), join(root, 'bin', 'pdkit'));
  });

  test('a second time, the link it already made stays as it is', async (t) => {
    const { cache, root } = await scratch(t);
    const dir = await standIn(root, { cache });
    const before = await lstat(join(dir, 'pdkit'), { bigint: true });

    assert.equal(await standIn(root, { cache }), dir);

    assert.equal((await lstat(join(dir, 'pdkit'), { bigint: true })).ino, before.ino);
  });

  test('another install — another generation of the same tarball — gets its own', async (t) => {
    const { cache, root, installed } = await scratch(t);
    const later = installed(1763300099999);

    const [one, two] = [await standIn(root, { cache }), await standIn(later, { cache })];

    assert.notEqual(one, two);
    assert.equal(await readlink(join(one, 'pdkit')), join(root, 'bin', 'pdkit'));
    assert.equal(await readlink(join(two, 'pdkit')), join(later, 'bin', 'pdkit'));
  });

  test('a pdkit there that is not the link to this one is replaced by it', async (t) => {
    const { dir: scratchDir, cache, root } = await scratch(t);
    const dir = await standIn(root, { cache });

    for (const plant of [
      () => symlink(join(scratchDir, 'elsewhere', 'pdkit'), join(dir, 'pdkit')),
      () => writeFile(join(dir, 'pdkit'), '#!/bin/sh\necho planted\n', { mode: 0o755 }),
    ]) {
      await rm(join(dir, 'pdkit'));
      await plant();

      assert.equal(await standIn(root, { cache }), dir);
      assert.equal(await readlink(join(dir, 'pdkit')), join(root, 'bin', 'pdkit'));
      assert.deepEqual(await readdir(dir), ['pdkit']);
    }
  });

  describe('when none can be made safely, PATH stays as it was and the log says why, once', () => {
    /** Register, run two commands, and return the PATH of the first and the log. */
    async function attempt(root, cache) {
      const { ctx, registered, plugin, lines } = host(root);
      await registerEnvironment(ctx, plugin, { cache, windows: false });
      const created = event({ PATH: '/usr/bin:/bin' });
      await registered[0].callback(created);
      await registered[0].callback(event({ PATH: '/usr/bin:/bin' }));
      return { path: created.env.PATH, version: created.env.PDKIT_OPENCODE_VERSION, lines };
    }

    const refused = (cause) =>
      new RegExp(
        '^bin/ cannot go on PATH: its path holds ":", the PATH delimiter \\(.+/bin\\), and no directory to link pdkit ' +
          `from could be made \\(.*${cause}.*\\)\\. Shell commands run without pdkit on PATH; install the plugin from ` +
          'the registry or a directory\\.$',
      );

    test('a directory of its own that others can write to', async (t) => {
      const { cache, root } = await scratch(t);
      await mkdir(join(cache, 'opencode-pdkit'), { recursive: true });
      await chmod(join(cache, 'opencode-pdkit'), 0o777);

      const { path, version, lines } = await attempt(root, cache);

      assert.equal(path, '/usr/bin:/bin');
      assert.equal(version, '2.3.0', 'the version still goes in');
      assert.equal(lines.length, 1);
      assert.match(lines[0], refused('can be written by others'));
      assert.deepEqual(await readdir(join(cache, 'opencode-pdkit')), [], 'something was put in it before the check');
    });

    test('a directory of its own that is a link to another', async (t) => {
      const { dir, cache, root } = await scratch(t);
      await mkdir(join(dir, 'theirs'));
      await mkdir(cache);
      await symlink(join(dir, 'theirs'), join(cache, 'opencode-pdkit'));

      const { path, lines } = await attempt(root, cache);

      assert.equal(path, '/usr/bin:/bin');
      assert.equal(lines.length, 1);
      assert.match(lines[0], refused('is not a directory'));
      assert.deepEqual(await readdir(join(dir, 'theirs')), []);
    });

    test('a cache that is not a directory', async (t) => {
      const { cache, root } = await scratch(t);
      await writeFile(cache, 'not a directory\n');

      const { path, lines } = await attempt(root, cache);

      assert.equal(path, '/usr/bin:/bin');
      assert.equal(lines.length, 1);
      assert.match(lines[0], refused(''));
    });

    // The link is made under a temporary name first; when it cannot take the
    // place of what is there, it does not stay behind as a second command.
    test('a pdkit there it cannot replace, with nothing of its own left behind', async (t) => {
      const { cache, root } = await scratch(t);
      const dir = await standIn(root, { cache });
      await rm(join(dir, 'pdkit'));
      await mkdir(join(dir, 'pdkit', 'inside'), { recursive: true });

      const { path, lines } = await attempt(root, cache);

      assert.equal(path, '/usr/bin:/bin');
      assert.equal(lines.length, 1);
      assert.match(lines[0], refused(''));
      assert.deepEqual(await readdir(dir), ['pdkit']);
    });

    test('a cache whose own path holds the delimiter', async (t) => {
      const { dir, root } = await scratch(t);
      const cache = join(dir, 'odd:cache');

      const { path, lines } = await attempt(root, cache);

      assert.equal(path, '/usr/bin:/bin');
      assert.equal(lines.length, 1);
      assert.match(lines[0], refused('the cache directory holds ":" too'));
      assert.equal(existsSync(cache), false);
    });
  });

  // The stand-in is only for a bin/ PATH cannot name: from the registry or a
  // directory, nothing is written anywhere.
  test('a bin/ PATH can name makes none', async (t) => {
    const { cache } = await scratch(t);
    const { ctx, registered, plugin, lines } = host(ROOT);

    await registerEnvironment(ctx, plugin, { cache, windows: false });
    const created = event({ PATH: '/usr/bin' });
    await registered[0].callback(created);

    assert.equal(created.env.PATH, `${BIN}:/usr/bin`);
    assert.equal(existsSync(cache), false);
    assert.deepEqual(lines, []);
  });

  test("without a cache given, it goes in the user's: XDG_CACHE_HOME", async (t) => {
    const { cache, root } = await scratch(t);
    const saved = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = cache;
    t.after(() => {
      if (saved === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = saved;
    });
    const { ctx, registered, plugin } = host(root);

    await registerEnvironment(ctx, plugin, { windows: false });
    const created = event({ PATH: '/usr/bin' });
    await registered[0].callback(created);

    assert.equal(created.env.PATH.startsWith(`${cache}/opencode-pdkit/bin-`), true, created.env.PATH);
  });

  // Open Code starts the shell as `<shell> -c <command>`. bin/pdkit runs by its
  // shebang through the link; Node resolves the link before import.meta.url,
  // so the copy finds the lib/ beside it, in the directory with the colon.
  test("in a real shell, `pdkit` is the plugin's, through the link, ahead of another pdkit", async (t) => {
    const { dir, cache, root } = await scratch(t);
    for (const part of ['bin', 'lib']) await cp(join(ROOT, part), join(root, part), { recursive: true });
    const other = join(dir, 'other', 'bin');
    await mkdir(other, { recursive: true });
    await writeFile(join(other, 'pdkit'), '#!/bin/sh\necho "the other pdkit"\n', { mode: 0o755 });
    const { ctx, registered, plugin } = host(root);
    await registerEnvironment(ctx, plugin, { cache, windows: false });
    const created = event({ ...process.env, PATH: `${other}:${process.env.PATH}` });
    await registered[0].callback(created);
    const run = promisify(execFile);
    const shell = async (command) => (await run('/bin/sh', ['-c', command], { cwd: dir, env: created.env })).stdout.trim();

    const found = await shell('command -v pdkit');

    assert.equal(found, join(created.env.PATH.split(':')[0], 'pdkit'));
    assert.equal(await realpath(found), join(root, 'bin', 'pdkit'));
    assert.match(await shell('pdkit --help'), /^  pdkit <command> \[options\]$/m);
  });
});

describe('the cache directory', () => {
  const home = () => '/home/someone';

  test('is XDG_CACHE_HOME when that is an absolute path', () => {
    assert.equal(cacheHome({ XDG_CACHE_HOME: '/var/cache/someone' }, home), '/var/cache/someone');
  });

  // The XDG rule: a relative path there is to be ignored.
  test('is ~/.cache otherwise', () => {
    for (const XDG_CACHE_HOME of [undefined, '', 'relative/cache']) {
      assert.equal(cacheHome({ XDG_CACHE_HOME }, home), join('/home/someone', '.cache'), JSON.stringify(XDG_CACHE_HOME));
    }
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

  // Windows keeps what T4.4 does: PATH as it was and one line in the log. The
  // root here holds the delimiter of the host the test runs on, so on Windows
  // itself this is the real case.
  test('a bin/ PATH cannot name gets no stand-in: PATH as it was, the reason in the log once', async (t) => {
    const { cache } = await scratch(t);
    const { ctx, registered, plugin, lines } = host(`${tmpdir()}${delimiter}odd`);

    await registerEnvironment(ctx, plugin, { cache, windows: true });
    const created = event({ PATH: '/usr/bin' });
    await registered[0].callback(created);
    await registered[0].callback(event({ PATH: '/usr/bin' }));

    assert.equal(created.env.PATH, '/usr/bin');
    assert.equal(existsSync(cache), false);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^bin\/ cannot go on PATH: its path holds ".", the PATH delimiter \(.+\)\. Shell commands run without pdkit on PATH;/);
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
  /** A context for this plugin's own root, which PATH can name. */
  const ours = (app) => host(ROOT, app);

  test('is registered on shell create.before, once', async () => {
    const { ctx, registered, plugin } = ours();

    await registerEnvironment(ctx, plugin);

    assert.deepEqual(
      registered.map(({ name }) => name),
      ['create.before'],
    );
  });

  test("puts this plugin's bin/ first and ctx.app.version beside it", async () => {
    const { ctx, registered, plugin } = ours();
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
    const { ctx, registered, plugin } = ours();
    await registerEnvironment(ctx, plugin, { hooks: () => ['pre-bash'] });
    const created = event({ PATH: '/usr/bin', CLAUDE_CODE_SESSION_ID: 'e7fee23a-left-over' });

    await registered[0].callback(created);

    assert.deepEqual(Object.keys(created.env).sort(), [
      'CLAUDE_CODE_SESSION_ID',
      'PATH',
      'PDKIT_HOOKS',
      'PDKIT_HOOK_NODE',
      'PDKIT_OPENCODE_VERSION',
    ]);
  });

  test('without a version from the host, still puts bin/ on PATH', async () => {
    for (const app of [{ name: 'cli' }, null]) {
      const { ctx, registered, plugin } = ours(app);
      await registerEnvironment(ctx, plugin);
      const created = event({ PATH: '/usr/bin' });

      await registered[0].callback(created);

      assert.equal(created.env.PATH.split(delimiter)[0], BIN, `ctx.app ${JSON.stringify(app)}`);
      assert.equal('PDKIT_OPENCODE_VERSION' in created.env, false, `ctx.app ${JSON.stringify(app)}`);
    }
  });

  test('never throws: an event without an environment is left as it is', async () => {
    const { ctx, registered, plugin, lines } = ours();
    await registerEnvironment(ctx, plugin);

    for (const odd of [undefined, null, {}, { env: null }, { env: 'PATH=/usr/bin' }]) {
      await registered[0].callback(odd);
    }
    assert.deepEqual(lines, []);
  });

  test('nor when the environment refuses the change; it says so in the log', async () => {
    const { ctx, registered, plugin, lines } = ours();
    await registerEnvironment(ctx, plugin);

    await registered[0].callback(event(Object.freeze({ PATH: '/usr/bin' })));

    assert.equal(lines.length, 1);
    assert.match(lines[0], /^cannot put bin\/ on the PATH of a shell command \(.+\); it runs without it$/);
  });
});

// What the plugin registered in the server, said where a shell can read it:
// `pdkit doctor` in a session holds it to the table of events (lib/doctor.js).
// The names are the doctor's to read, so they are pinned here rather than
// taken from the modules that define them.
describe('the hook events that stood', () => {
  const ours = () => host(ROOT);

  test('go into PDKIT_HOOKS, joined by commas, as the list gives them', () => {
    const hooks = ['pre-bash', 'pre-write', 'subagent-stop'];
    assert.equal(prepare({}, { bin: '/plugin/bin', version: '2.3.0', hooks, ...POSIX }).PDKIT_HOOKS, 'pre-bash,pre-write,subagent-stop');
  });

  test('replace a list the command inherited, and with none given, remove it', () => {
    const inherited = { PDKIT_HOOKS: 'pre-bash,subagent-stop' };
    assert.equal(prepare({ ...inherited }, { bin: '/plugin/bin', version: '2.3.0', hooks: ['pre-bash'], ...POSIX }).PDKIT_HOOKS, 'pre-bash');
    for (const hooks of [undefined, null, 'pre-bash', 3]) {
      const env = prepare({ ...inherited }, { bin: '/plugin/bin', version: '2.3.0', hooks, ...POSIX });
      assert.equal('PDKIT_HOOKS' in env, false, `${JSON.stringify(hooks)} left the inherited value`);
    }
  });

  test('are read on every command, so a registration that comes later is in the next one', async () => {
    const { ctx, registered, plugin } = ours();
    let stood = ['pre-bash'];
    await registerEnvironment(ctx, plugin, { hooks: () => stood });

    const first = event({ PATH: '/usr/bin' });
    await registered[0].callback(first);
    stood = ['pre-bash', 'subagent-stop'];
    const second = event({ PATH: '/usr/bin' });
    await registered[0].callback(second);

    assert.equal(first.env.PDKIT_HOOKS, 'pre-bash');
    assert.equal(second.env.PDKIT_HOOKS, 'pre-bash,subagent-stop');
  });

  test('are no label when they cannot be read, and the command keeps bin/ on PATH', async () => {
    const { ctx, registered, plugin, lines } = ours();
    await registerEnvironment(ctx, plugin, {
      hooks: () => {
        throw new Error('the bridge is gone');
      },
    });
    const created = event({ PATH: '/usr/bin', PDKIT_HOOKS: 'pre-bash' });

    await registered[0].callback(created);

    assert.equal(created.env.PATH, [BIN, '/usr/bin'].join(delimiter));
    assert.equal('PDKIT_HOOKS' in created.env, false);
    assert.deepEqual(lines, []);
  });
});

// The `node` every hook starts is the one on the server's PATH, which no shell
// of the session can see (lib/hooks/runner.js NODE_VARIABLE).
describe('the node of the hooks', () => {
  const ours = () => host(ROOT);
  const answers = (answer) => {
    const asked = [];
    return { asked, probe: async () => (asked.push(1), answer) };
  };

  test('goes into PDKIT_HOOK_NODE as its version', async () => {
    const { ctx, registered, plugin } = ours();
    const { probe } = answers({ ok: true, version: 'v24.22.1' });
    await registerEnvironment(ctx, plugin, { probe });
    const created = event({ PATH: '/usr/bin' });

    await registered[0].callback(created);

    assert.equal(created.env.PDKIT_HOOK_NODE, 'v24.22.1');
  });

  test('is asked once, when the callback is registered, not on every command', async () => {
    const { ctx, registered, plugin } = ours();
    const { asked, probe } = answers({ ok: true, version: 'v24.22.1' });
    await registerEnvironment(ctx, plugin, { probe });

    for (let n = 0; n < 3; n += 1) await registered[0].callback(event({ PATH: '/usr/bin' }));

    assert.equal(asked.length, 1);
  });

  test('that did not answer is `none:` and why', async () => {
    const { ctx, registered, plugin } = ours();
    const { probe } = answers({ ok: false, detail: '"node" is not on the PATH of the process that runs hooks (ENOENT)' });
    await registerEnvironment(ctx, plugin, { probe });
    const created = event({ PATH: '/usr/bin' });

    await registered[0].callback(created);

    assert.equal(created.env.PDKIT_HOOK_NODE, 'none: "node" is not on the PATH of the process that runs hooks (ENOENT)');
  });

  test('that could not be asked is `none:` too, and the callback is registered all the same', async () => {
    const { ctx, registered, plugin, lines } = ours();
    await registerEnvironment(ctx, plugin, {
      probe: async () => {
        throw new Error('spawn is broken');
      },
    });
    const created = event({ PATH: '/usr/bin' });

    await registered[0].callback(created);

    assert.equal(created.env.PATH, [BIN, '/usr/bin'].join(delimiter));
    assert.equal(created.env.PDKIT_HOOK_NODE, 'none: it could not be asked (spawn is broken)');
    assert.deepEqual(lines, []);
  });

  test('replaces one the command inherited, and with none given, removes it', () => {
    assert.equal(prepare({ PDKIT_HOOK_NODE: 'v20.20.0' }, { bin: '/plugin/bin', version: '2.3.0', node: 'v24.22.1', ...POSIX }).PDKIT_HOOK_NODE, 'v24.22.1');
    for (const node of [undefined, '', 22]) {
      const env = prepare({ PDKIT_HOOK_NODE: 'v20.20.0' }, { bin: '/plugin/bin', version: '2.3.0', node, ...POSIX });
      assert.equal('PDKIT_HOOK_NODE' in env, false, `${JSON.stringify(node)} left the inherited value`);
    }
  });

  // Not a stand-in: the probe the plugin uses, against the PATH this test runs
  // with, where a `node` is (it runs this file).
  test('is, by default, what the node on PATH says', async () => {
    const { ctx, registered, plugin } = ours();
    await registerEnvironment(ctx, plugin);
    const created = event({ PATH: '/usr/bin' });

    await registered[0].callback(created);

    assert.match(created.env.PDKIT_HOOK_NODE, /^v\d+\.\d+\.\d+$/);
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

  test('the labels read back as they were set', async () => {
    const env = prepare({ ...process.env }, { bin: BIN, version: '2.3.0', hooks: ['pre-bash', 'subagent-stop'], node: 'v24.22.1' });
    const shell = async (command) => (await run('/bin/sh', ['-c', command], { env })).stdout.trim();

    assert.equal(await shell('printf %s "$PDKIT_HOOKS"'), 'pre-bash,subagent-stop');
    assert.equal(await shell('printf %s "$PDKIT_HOOK_NODE"'), 'v24.22.1');
  });
});
