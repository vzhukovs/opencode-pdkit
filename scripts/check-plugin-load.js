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
//   1. packs the package, loads the tarball into `opencode serve` in a
//      throwaway HOME and polls GET /api/plugin until the plugin is listed,
//      expecting "active" (scripts/plugin-server.js, shared with the receipt
//      gate's check);
//   2. requests the command, agent and skill registries, then reads the
//      record again: a plugin whose command.transform throws is disabled only
//      on the first registry request. Every skill under skills/ must be in the
//      command registry as `/pd:<name>`, with the description the registrar
//      builds; every agent under agents/ in the agent registry, under its name
//      and as a subagent; and every skill the model may load in the skill
//      registry as `pd:<name>`, read from the package's own SKILL.md. One that
//      is missing, or replaced, or a primary agent a subagent call refuses,
//      fails here;
//   3. runs `opencode plugin check`, which exits 1 for a package plugin that
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

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { minimumVersion } from '../lib/opencode-version.js';
import { readAgents } from '../opencode/agents.js';
import { PREFIX, readSkills } from '../opencode/commands.js';
import { findPlugin, location, reporter, run, verdict, withPluginServer } from './plugin-server.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

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

async function check({ root, keep, printLog }) {
  const out = reporter();
  const { report } = out;
  await withPluginServer({ root, prefix: 'opencode-pdkit-load-', out, keep, printLog }, async ({ url, project, env, id, target, api }) => {
    const { skills: shipped } = await readSkills(root);
    const commands = api('GET', `/api/command?${location(project)}`);
    if (commands.code === 0) {
      const expected = shipped.map((skill) => ({ name: `${PREFIX}${skill.name}`, description: skill.description }));
      const ours = commandsVerdict(commands.json?.data, expected);
      report('command', ours.ok, commands.seconds, ours.detail);
    } else {
      report('command', false, commands.seconds, commands.stderr);
    }

    const agents = api('GET', `/api/agent?${location(project)}`);
    if (agents.code === 0) {
      const ours = agentsVerdict(agents.json?.data, (await readAgents(root)).agents.map((agent) => agent.id));
      report('agent', ours.ok, agents.seconds, ours.detail);
    } else {
      report('agent', false, agents.seconds, agents.stderr);
    }

    const skills = api('GET', `/api/skill?${location(project)}`);
    if (skills.code === 0) {
      const ours = skillsVerdict(skills.json?.data, shipped.filter((skill) => !skill.personOnly).map((skill) => skill.name));
      report('skill', ours.ok, skills.seconds, ours.detail);
    } else {
      report('skill', false, skills.seconds, skills.stderr);
    }

    const again = api('GET', `/api/plugin?${location(project)}`);
    const after = verdict(findPlugin(again.json?.data ?? [], { id, target }), id);
    report('recheck', after.ok, again.seconds, after.detail);

    const inspected = run('opencode', ['plugin', 'check', '--server', url], { cwd: project, env });
    const output = `${inspected.stdout}${inspected.stderr}`.trim().replace(/\s+/g, ' ');
    report('check', inspected.status === 0, inspected.seconds, `exit ${inspected.status}: ${output}`);
  });
  return out.result();
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
