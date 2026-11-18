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

// The part the live checks under scripts/ share: the package packed the way
// it will be published, loaded into a private `opencode serve`, and the
// server's API to ask it what happened.
//
//   1. `npm pack`, so a file left out of "files" fails here and not on a
//      user's machine;
//   2. a throwaway directory with a fresh HOME and XDG tree (no config,
//      credentials or background service of the caller's), a PDKIT_HOME of
//      its own, and a project, a git repository, whose opencode.json names the
//      tarball (`file:<path>`);
//   3. `opencode serve` on a loopback port, in a process group of its own;
//   4. GET /api/plugin until the plugin is listed. Loading is asynchronous and
//      the API does not wait for it. A plugin that never shows up fails as
//      surely as one marked "failed".
//
// What each check asks once the plugin is up is its own: check-plugin-load.js
// reads the registries, no model and no credentials; check-receipt-gate.js
// runs a subagent on a model, with the provider's key from the environment.
// The server's environment is the caller's minus every OPENCODE_* variable,
// so a provider key the caller holds reaches the server, and nothing else
// configures it. Free models are off: a check that asks for a model gets the
// one it names or none, never a stand-in.
//
// Runs on Linux and macOS, with `opencode`, `npm` and `git` on PATH.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/** How long the server may take to answer, and the plugin to be listed. */
const SERVER_SECONDS = 60;
const PLUGIN_SECONDS = 60;

/**
 * The plugin's record in a GET /api/plugin listing. A plugin that failed
 * before its module ran (a syntax error, a throw on import) has no id, so the
 * tarball it was installed from identifies it as well.
 */
export function findPlugin(list, { id, target }) {
  return list.find((entry) => entry.id === id || (entry.source?.type === 'package' && entry.source.target === target));
}

/** Whether a record says the plugin loaded under its own id, and a line saying what it shows. */
export function verdict(entry, id) {
  if (!entry) return { ok: false, detail: 'not listed: the server reports the plugin neither active nor failed' };
  const { status, error, ref } = entry.state ?? {};
  const name = entry.id ?? '(no id)';
  if (status !== 'active') {
    const why = [error, ref && `ref ${ref}, which the server log below repeats`].filter(Boolean).join('; ');
    return { ok: false, detail: `${name} ${status ?? 'without a state'}${why ? `: ${why}` : ''}` };
  }
  if (entry.id !== id) return { ok: false, detail: `active as ${name}, not as ${id}` };
  return { ok: true, detail: `${name} ${entry.source?.type} ${entry.source?.version ?? ''} active`.trim() };
}

/**
 * A command run to its end, and how long it took.
 *
 * @param {string} command
 * @param {readonly string[]} args
 * @param {import('node:child_process').SpawnSyncOptions} [options]
 */
export function run(command, args, options) {
  const started = performance.now();
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  return { ...result, seconds: (performance.now() - started) / 1000 };
}

/**
 * One line per step, and the steps that failed.
 *
 * `report(step, ok, seconds, detail)` prints the line; `result()` prints the
 * verdict and returns the exit code.
 */
export function reporter() {
  const failures = [];
  return {
    failures,
    report(step, ok, seconds, detail) {
      if (!ok) failures.push(step);
      console.log(`${step.padEnd(8)} ${ok ? 'ok  ' : 'FAIL'} ${seconds.toFixed(2).padStart(6)}s  ${detail}`);
    },
    result() {
      console.log(`result: ${failures.length === 0 ? 'PASS' : `FAIL (${failures.join(', ')})`}`);
      return failures.length === 0 ? 0 : 1;
    },
  };
}

function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

const running = (server) => server.pid !== undefined && server.exitCode === null && server.signalCode === null;

/** Stops the server with every process it started: it runs in a group of its own. */
async function stop(server) {
  if (!running(server)) return;
  const exited = once(server, 'exit');
  const signal = (name) => {
    try {
      process.kill(-server.pid, name);
    } catch {
      // The group is already gone.
    }
  };
  signal('SIGTERM');
  const force = setTimeout(() => signal('SIGKILL'), 10_000);
  await exited;
  clearTimeout(force);
}

/**
 * The query string that names a directory to the API.
 *
 * @param {string} directory
 */
export const location = (directory) => new URLSearchParams({ 'location[directory]': directory }).toString();

/**
 * @typedef {object} Server
 * @property {string} url
 * @property {string} work        the throwaway directory
 * @property {string} home        the server's HOME
 * @property {string} project     the directory the server runs in, a git repository
 * @property {string} pdkitHome   the server's PDKIT_HOME
 * @property {NodeJS.ProcessEnv} env  the server's environment, for anything run beside it
 * @property {string} id          the package's name, the plugin's id
 * @property {string} tarball
 * @property {string} target      the tarball's `file:` spec, as the project's opencode.json names it
 * @property {boolean} loaded     whether the plugin is listed as active under its id
 * @property {(method: string, route: string, body?: unknown, timeoutMs?: number) =>
 *   {code: number|null, json: any, data: any, stdout: string, stderr: string, seconds: number}} api
 *   `opencode api` against the server; `data` is the answer's `data`, or the answer
 * @property {<T extends {done: boolean}>(seconds: number, attempt: () => T) => Promise<T & {seconds: number}>} waitFor
 *   tries until `done` or the time is up, while the server runs
 * @property {() => boolean} alive
 */

/**
 * Packs the package, starts a server for a project that loads it, and hands
 * the server to `steps` once it answers. Every step, these first ones
 * included, goes to `out.report`; the server log is printed when one failed,
 * or always with `printLog`. The throwaway directory goes at the end unless
 * `keep`.
 *
 * @param {object} options
 * @param {string} options.root     the package directory
 * @param {string} options.prefix   of the throwaway directory's name
 * @param {ReturnType<typeof reporter>} options.out
 * @param {(target: string) => unknown} [options.entry]  the plugin's entry in the project's
 *   opencode.json, given its `file:` spec; the spec alone by default
 * @param {object} [options.config]  the server's global opencode.json, when there is one to give
 * @param {(server: Pick<Server, 'work'|'project'|'pdkitHome'>) => Promise<void>} [options.prepare]
 *   before the server starts, once the project is a repository
 * @param {boolean} [options.keep]
 * @param {boolean} [options.printLog]
 * @param {(server: Server) => Promise<void>} steps
 */
export async function withPluginServer(options, steps) {
  const { root, prefix, out, keep, printLog } = options;
  const { report } = out;
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const id = pkg.name;

  const version = run('opencode', ['--version']);
  if (version.status !== 0) {
    report('opencode', false, version.seconds, `cannot run opencode: ${version.error?.message ?? version.stderr.trim()}`);
    return;
  }
  report('opencode', true, version.seconds, version.stdout.trim());

  // realpath: on macOS the temporary directory is reached through a symlink,
  // and the project directory is sent to the server as a location.
  const work = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const home = join(work, 'home');
  const project = join(work, 'project');
  const packs = join(work, 'pack');
  const pdkitHome = join(work, 'pdkit-home');
  const logFile = join(work, 'server.log');
  await Promise.all([home, project, packs].map((dir) => mkdir(dir, { recursive: true })));

  let server;
  let log = '';
  // The server runs in a process group of its own, out of reach of a Ctrl-C
  // in the terminal, so an interrupted check takes it down on the way out.
  const interrupted = () => {
    if (server && running(server)) {
      try {
        process.kill(-server.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    process.exit(130);
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);

  const start = async () => {
    const packed = run('npm', ['pack', '--json', '--pack-destination', packs], { cwd: root });
    let info;
    try {
      [info] = JSON.parse(packed.stdout);
    } catch {
      info = undefined;
    }
    if (packed.status !== 0 || !info?.filename) {
      report('pack', false, packed.seconds, `npm pack exited ${packed.status}: ${packed.stderr.trim().slice(-400)}`);
      return;
    }
    const tarball = join(packs, info.filename);
    report('pack', true, packed.seconds, `${info.filename}, ${info.files?.length} files`);

    // An absolute file: spec. "." would be an npm spec too, resolved through
    // a cache shared between projects, and could load some other copy.
    const target = `file:${tarball}`;
    const entry = options.entry ? options.entry(target) : target;
    await writeFile(
      join(project, 'opencode.json'),
      `${JSON.stringify({ $schema: 'https://opencode.ai/config.json', plugins: [entry] }, null, 2)}\n`,
    );
    if (options.config) {
      await mkdir(join(home, '.config', 'opencode'), { recursive: true });
      await writeFile(join(home, '.config', 'opencode', 'opencode.json'), `${JSON.stringify(options.config, null, 2)}\n`);
    }
    // Every run these checks were modeled on loaded the plugin into a git repository.
    run('git', ['init', '-q'], { cwd: project });
    await options.prepare?.({ work, project, pdkitHome });

    // A clean environment: no OPENCODE_* from the caller, a fresh HOME and XDG
    // tree (no config, credentials or background service), a PDKIT_HOME of its
    // own, and no free models to fall back on should anything ask for a model.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('OPENCODE_')));
    Object.assign(env, {
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
      XDG_CACHE_HOME: join(home, '.cache'),
      PDKIT_HOME: pdkitHome,
      OPENCODE_SERVER_PASSWORD: randomBytes(16).toString('hex'),
      OPENCODE_DISABLE_FREE_MODELS: '1',
    });

    // The log goes to a file, not a pipe: a check that waits on a model for
    // minutes in a synchronous call drains no pipe meanwhile, and a server
    // whose pipe is full stops.
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const fd = openSync(logFile, 'a');
    try {
      server = spawn(
        'opencode',
        ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--print-logs', '--log-level', 'warn'],
        { cwd: project, env, detached: true, stdio: ['ignore', fd, fd] },
      );
    } finally {
      closeSync(fd);
    }
    server.on('error', (error) => (log += `cannot start opencode serve: ${error.message}\n`));

    /** @type {Server['api']} */
    const api = (method, route, body, timeoutMs = 120_000) => {
      const call = run('opencode', ['api', '--server', url, method, route, ...(body === undefined ? [] : ['-d', JSON.stringify(body)])], {
        cwd: project,
        env,
        timeout: timeoutMs,
      });
      let json;
      try {
        json = JSON.parse(call.stdout);
      } catch {
        json = undefined;
      }
      const stderr = `${call.stderr ?? ''}`.trim() || (call.error ? call.error.message : '');
      return { code: call.status, json, data: json?.data ?? json, stdout: call.stdout ?? '', stderr, seconds: call.seconds };
    };
    const alive = () => running(server);
    /** @type {Server['waitFor']} */
    const waitFor = async (seconds, attempt) => {
      const started = performance.now();
      let last;
      while (performance.now() - started < seconds * 1000 && alive()) {
        last = attempt();
        if (last.done) break;
        await sleep(250);
      }
      return { ...last, seconds: (performance.now() - started) / 1000 };
    };

    const ready = await waitFor(SERVER_SECONDS, () => {
      const call = api('GET', '/api/info');
      return { done: call.code === 0, call };
    });
    if (!ready.done) {
      const why = alive() ? ready.call?.stderr : `the server exited (${server.exitCode ?? server.signalCode})`;
      report('server', false, ready.seconds, `no answer from ${url}: ${why}`);
      return;
    }
    report('server', true, ready.seconds, `${url}, Open Code ${ready.call.json?.version}`);

    const listed = await waitFor(PLUGIN_SECONDS, () => {
      const entry = findPlugin(api('GET', `/api/plugin?${location(project)}`).json?.data ?? [], { id, target });
      return { done: entry !== undefined, entry };
    });
    const loaded = verdict(listed.entry, id);
    report('plugin', loaded.ok, listed.seconds, loaded.detail);

    await steps({ url, work, home, project, pdkitHome, env, id, tarball, target, loaded: loaded.ok, api, waitFor, alive });
  };

  try {
    await start();
  } finally {
    if (server) await stop(server);
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
    try {
      log = `${readFileSync(logFile, 'utf8')}${log}`;
    } catch {
      // The server never started.
    }
    if (keep) console.log(`kept     ${work}`);
    else await rm(work, { recursive: true, force: true });
  }

  // On a failure the log tells why, by the ref the record carries. It always
  // holds a "failed to check plugin update" warning too, which is not the
  // failure: update checks take registry and git specs, never file:.
  if ((out.failures.length > 0 || printLog) && log.trim()) console.log(`\nserver log:\n${log.trimEnd()}`);
}
