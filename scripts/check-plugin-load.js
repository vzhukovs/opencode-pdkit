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

// Will the package load as an Open Code plugin at all?
//
// The suite answers whether the code works, not this. Open Code has no command
// that validates a plugin before it is installed: `opencode run` never executes
// a plugin command, and when a plugin fails to load, the server keeps running
// without it and every CLI command still exits 0. The server's own record of
// the plugin is what tells. So this script:
//
//   1. packs the package with `npm pack`, the way it will be published, so a
//      file left out of "files" fails here and not on a user's machine;
//   2. starts `opencode serve` on a loopback port in a throwaway HOME, for a
//      project whose opencode.json names the tarball (`file:<path>`);
//   3. polls GET /api/plugin until the plugin is listed and expects "active".
//      Loading is asynchronous and the API does not wait for it. A plugin
//      that never shows up fails as surely as one marked "failed";
//   4. requests the command, agent and skill registries, then reads the
//      record again: a plugin whose command.transform throws is disabled only
//      on the first registry request. Every skill under skills/ must be in the
//      command registry as `/pd:<name>`, with the description the registrar
//      builds; every agent under agents/ in the agent registry, under its name
//      and as a subagent; and every skill the model may load in the skill
//      registry as `pd:<name>`, read from the package's own SKILL.md. One that
//      is missing, or replaced, or a primary agent a subagent call refuses,
//      fails here;
//   5. runs `opencode plugin check`, which exits 1 for a package plugin that
//      failed to load.
//
// No model is called and no credentials are needed. The server gets a fresh
// HOME and its own PDKIT_HOME, so the check reads no user config and writes
// nothing into a live journal.
//
// Usage: node scripts/check-plugin-load.js [--root <package dir>] [--keep] [--log]
//        node scripts/check-plugin-load.js --print-minimum
//
// --print-minimum prints the lowest Open Code version the package supports,
// taken from engines.opencode, for CI to install. --keep leaves the throwaway
// directory in place. --log prints the server log on a pass too: a plugin can
// load and still write a warning there, and only the log shows it. Runs on
// Linux and macOS, with `opencode` and `npm` on PATH.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { minimumVersion } from '../lib/opencode-version.js';
import { readAgents } from '../opencode/agents.js';
import { PREFIX, readSkills } from '../opencode/commands.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** How long the server may take to answer, and the plugin to be listed. */
const SERVER_SECONDS = 60;
const PLUGIN_SECONDS = 60;

/**
 * The lowest Open Code version the package supports. engines.opencode is the
 * one place the minimum is written, and Open Code itself ignores the field.
 * Only `>=X.Y.Z` is accepted: CI installs exactly this version, and a range of
 * any other shape names no single version to install. The reading is
 * lib/opencode-version.js's, the same one the plugin compares the running
 * server against, so CI cannot test on a minimum the plugin does not enforce.
 */
export function minimumOpenCode(pkg) {
  const range = pkg?.engines?.opencode;
  const minimum = minimumVersion(range);
  if (!minimum) throw new Error(`package.json engines.opencode is ${JSON.stringify(range)}, not ">=X.Y.Z"`);
  return minimum;
}

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
 * Whether a GET /api/agent listing holds each of the plugin's agents as a
 * subagent, and a line saying what it shows.
 *
 * @param {unknown} listing the `data` of the answer
 * @param {readonly string[]} ids the plugin's agents
 */
export function agentsVerdict(listing, ids) {
  if (!Array.isArray(listing)) return { ok: false, detail: 'no agent listing' };
  const byId = new Map(listing.map((agent) => [agent?.id, agent]));
  const missing = ids.filter((id) => !byId.has(id));
  const primary = ids.filter((id) => byId.has(id) && byId.get(id).mode !== 'subagent');
  const problems = [
    ...(missing.length > 0 ? [`missing: ${missing.join(', ')}`] : []),
    ...(primary.length > 0 ? [`not subagents: ${primary.join(', ')}`] : []),
  ];
  if (ids.length === 0) problems.push('the package has no agents to look for');
  if (problems.length > 0) return { ok: false, detail: `${listing.length} registered; of the plugin's ${ids.length}, ${problems.join('; ')}` };
  return { ok: true, detail: `${listing.length} registered, the plugin's ${ids.length} among them as subagents` };
}

/**
 * Whether a GET /api/command listing holds each of the plugin's commands with
 * the description the registrar gives it, and a line saying what it shows. A
 * command listed with another description is someone else's under that name.
 *
 * @param {unknown} listing the `data` of the answer
 * @param {ReadonlyArray<{name: string, description: string|undefined}>} expected the plugin's commands
 */
export function commandsVerdict(listing, expected) {
  if (!Array.isArray(listing)) return { ok: false, detail: 'no command listing' };
  const byName = new Map(listing.map((command) => [command?.name, command]));
  const missing = expected.filter(({ name }) => !byName.has(name)).map(({ name }) => name);
  const other = expected
    .filter(({ name, description }) => byName.has(name) && byName.get(name).description !== description)
    .map(({ name }) => `${name} (${JSON.stringify(byName.get(name).description)})`);
  const problems = [
    ...(missing.length > 0 ? [`missing: ${missing.join(', ')}`] : []),
    ...(other.length > 0 ? [`described otherwise: ${other.join(', ')}`] : []),
  ];
  if (expected.length === 0) problems.push('the package has no commands to look for');
  if (problems.length > 0) return { ok: false, detail: `${listing.length} registered; of the plugin's ${expected.length}, ${problems.join('; ')}` };
  return { ok: true, detail: `${listing.length} registered, the plugin's ${expected.length} among them` };
}

/**
 * Whether a GET /api/skill listing holds each of the plugin's skills, read from
 * the package's own SKILL.md, and a line saying what it shows. A skill file of
 * the same ID elsewhere replaces the plugin's whole, path included.
 *
 * @param {unknown} listing the `data` of the answer
 * @param {readonly string[]} names the skills under skills/ the model may load, by directory
 */
export function skillsVerdict(listing, names) {
  if (!Array.isArray(listing)) return { ok: false, detail: 'no skill listing' };
  const byId = new Map(listing.map((skill) => [skill?.id, skill]));
  const ids = names.map((name) => `${PREFIX}${name}`);
  const missing = ids.filter((id) => !byId.has(id));
  const elsewhere = names
    .filter((name) => byId.has(`${PREFIX}${name}`))
    .filter((name) => !String(byId.get(`${PREFIX}${name}`).path ?? '').replaceAll('\\', '/').endsWith(`/skills/${name}/SKILL.md`))
    .map((name) => `${PREFIX}${name} (${byId.get(`${PREFIX}${name}`).path})`);
  const problems = [
    ...(missing.length > 0 ? [`missing: ${missing.join(', ')}`] : []),
    ...(elsewhere.length > 0 ? [`read from elsewhere: ${elsewhere.join(', ')}`] : []),
  ];
  if (names.length === 0) problems.push('the package has no skills to look for');
  if (problems.length > 0) return { ok: false, detail: `${listing.length} registered; of the plugin's ${names.length}, ${problems.join('; ')}` };
  return { ok: true, detail: `${listing.length} registered, the plugin's ${names.length} among them` };
}

function run(command, args, options) {
  const started = performance.now();
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  return { ...result, seconds: (performance.now() - started) / 1000 };
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

async function check({ root, keep, printLog }) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const id = pkg.name;
  const failures = [];
  const report = (step, ok, seconds, detail) => {
    if (!ok) failures.push(step);
    console.log(`${step.padEnd(8)} ${ok ? 'ok  ' : 'FAIL'} ${seconds.toFixed(2).padStart(6)}s  ${detail}`);
  };

  const version = run('opencode', ['--version']);
  if (version.status !== 0) {
    report('opencode', false, version.seconds, `cannot run opencode: ${version.error?.message ?? version.stderr.trim()}`);
    return 1;
  }
  report('opencode', true, version.seconds, version.stdout.trim());

  // realpath: on macOS the temporary directory is reached through a symlink,
  // and the project directory is sent to the server as a location.
  const work = await realpath(await mkdtemp(join(tmpdir(), 'opencode-pdkit-load-')));
  const home = join(work, 'home');
  const project = join(work, 'project');
  const packs = join(work, 'pack');
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

  const steps = async () => {
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
    await writeFile(
      join(project, 'opencode.json'),
      `${JSON.stringify({ $schema: 'https://opencode.ai/config.json', plugins: [target] }, null, 2)}\n`,
    );
    // Every run this check was modeled on loaded the plugin into a git repository.
    run('git', ['init', '-q'], { cwd: project });

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
      PDKIT_HOME: join(work, 'pdkit-home'),
      OPENCODE_SERVER_PASSWORD: randomBytes(16).toString('hex'),
      OPENCODE_DISABLE_FREE_MODELS: '1',
    });

    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    server = spawn(
      'opencode',
      ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--print-logs', '--log-level', 'warn'],
      { cwd: project, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    server.on('error', (error) => (log += `cannot start opencode serve: ${error.message}\n`));
    server.stdout.on('data', (chunk) => (log += chunk));
    server.stderr.on('data', (chunk) => (log += chunk));

    const api = (method, route) => {
      const call = run('opencode', ['api', '--server', url, method, route], { cwd: project, env });
      let json;
      try {
        json = JSON.parse(call.stdout);
      } catch {
        json = undefined;
      }
      return { code: call.status, json, stderr: call.stderr.trim(), seconds: call.seconds };
    };
    const location = new URLSearchParams({ 'location[directory]': project }).toString();
    const waitFor = async (seconds, attempt) => {
      const started = performance.now();
      let last;
      while (performance.now() - started < seconds * 1000 && running(server)) {
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
      const why = running(server) ? ready.call?.stderr : `the server exited (${server.exitCode ?? server.signalCode})`;
      report('server', false, ready.seconds, `no answer from ${url}: ${why}`);
      return;
    }
    report('server', true, ready.seconds, `${url}, Open Code ${ready.call.json?.version}`);

    const plugins = () => api('GET', `/api/plugin?${location}`);
    const listed = await waitFor(PLUGIN_SECONDS, () => {
      const entry = findPlugin(plugins().json?.data ?? [], { id, target });
      return { done: entry !== undefined, entry };
    });
    const loaded = verdict(listed.entry, id);
    report('plugin', loaded.ok, listed.seconds, loaded.detail);

    const { skills: shipped } = await readSkills(root);
    const commands = api('GET', `/api/command?${location}`);
    if (commands.code === 0) {
      const expected = shipped.map((skill) => ({ name: `${PREFIX}${skill.name}`, description: skill.description }));
      const ours = commandsVerdict(commands.json?.data, expected);
      report('command', ours.ok, commands.seconds, ours.detail);
    } else {
      report('command', false, commands.seconds, commands.stderr);
    }

    const agents = api('GET', `/api/agent?${location}`);
    if (agents.code === 0) {
      const ours = agentsVerdict(agents.json?.data, (await readAgents(root)).agents.map((agent) => agent.id));
      report('agent', ours.ok, agents.seconds, ours.detail);
    } else {
      report('agent', false, agents.seconds, agents.stderr);
    }

    const skills = api('GET', `/api/skill?${location}`);
    if (skills.code === 0) {
      const ours = skillsVerdict(skills.json?.data, shipped.filter((skill) => !skill.personOnly).map((skill) => skill.name));
      report('skill', ours.ok, skills.seconds, ours.detail);
    } else {
      report('skill', false, skills.seconds, skills.stderr);
    }

    const again = plugins();
    const after = verdict(findPlugin(again.json?.data ?? [], { id, target }), id);
    report('recheck', after.ok, again.seconds, after.detail);

    const inspected = run('opencode', ['plugin', 'check', '--server', url], { cwd: project, env });
    const output = `${inspected.stdout}${inspected.stderr}`.trim().replace(/\s+/g, ' ');
    report('check', inspected.status === 0, inspected.seconds, `exit ${inspected.status}: ${output}`);
  };

  try {
    await steps();
  } finally {
    if (server) await stop(server);
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
    if (keep) console.log(`kept     ${work}`);
    else await rm(work, { recursive: true, force: true });
  }

  // On a failure the log tells why, by the ref the record carries. It always
  // holds a "failed to check plugin update" warning too, which is not the
  // failure: update checks take registry and git specs, never file:.
  if ((failures.length > 0 || printLog) && log.trim()) console.log(`\nserver log:\n${log.trimEnd()}`);
  console.log(`result: ${failures.length === 0 ? 'PASS' : `FAIL (${failures.join(', ')})`}`);
  return failures.length === 0 ? 0 : 1;
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: 'string' },
      keep: { type: 'boolean' },
      log: { type: 'boolean' },
      'print-minimum': { type: 'boolean' },
    },
  });
  const root = resolve(values.root ?? ROOT);
  if (values['print-minimum']) {
    console.log(minimumOpenCode(JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))));
    return 0;
  }
  return check({ root, keep: values.keep === true, printLog: values.log === true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
