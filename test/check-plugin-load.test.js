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

// scripts/check-plugin-load.js decides what CI reports about whether the
// package loads in Open Code. Starting a server is the CI job's part; what the
// script makes of the server's answer is pinned here, on records shaped like
// the ones GET /api/plugin returns. The reading of the plugin's own record is
// scripts/plugin-server.js's, shared with the receipt gate's check.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { agentsVerdict, commandsVerdict, minimumOpenCode, skillsVerdict } from '../scripts/check-plugin-load.js';
import { findPlugin, verdict } from '../scripts/plugin-server.js';
import { readAgents } from '../opencode/agents.js';
import { PREFIX, readSkills } from '../opencode/commands.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ID = 'opencode-pdkit';
const TARGET = 'file:/tmp/pack/opencode-pdkit-0.16.0.tgz';

const builtin = { id: 'builtin-thing', source: { type: 'builtin' }, state: { status: 'active' } };
const active = { id: ID, source: { type: 'package', target: TARGET, version: '0.16.0' }, state: { status: 'active' } };

describe('the Open Code version CI installs as the minimum', () => {
  test('is the one engines.opencode names', () => {
    assert.equal(minimumOpenCode({ engines: { opencode: '>=2.3.0' } }), '2.3.0');
  });

  test("and the package's own engines.opencode names one", async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));

    assert.match(minimumOpenCode(pkg), /^\d+\.\d+\.\d+$/);
  });

  // CI would otherwise install something other than the minimum and call it
  // the minimum.
  for (const range of ['^2.3.0', '>=2.3', '2.3.0', '>= 2.3.0', '>=2.3.0 <3', '', undefined]) {
    test(`a range it cannot install as one version is refused: ${JSON.stringify(range)}`, () => {
      assert.throws(() => minimumOpenCode({ engines: { opencode: range } }), /engines\.opencode/);
    });
  }
});

describe("the plugin's record", () => {
  test('is found by its id', () => {
    assert.equal(findPlugin([builtin, active], { id: ID, target: TARGET }), active);
  });

  // A syntax error or a throw on import fails the plugin before its module
  // runs, so the record has no id to find it by.
  test('is found by the tarball when it has no id', () => {
    const failed = { source: { type: 'package', target: TARGET }, state: { status: 'failed', error: 'x' } };

    assert.equal(findPlugin([builtin, failed], { id: ID, target: TARGET }), failed);
  });

  test('is not some other plugin installed from elsewhere', () => {
    const other = { source: { type: 'package', target: 'file:/elsewhere.tgz' }, state: { status: 'active' } };

    assert.equal(findPlugin([builtin, other], { id: ID, target: TARGET }), undefined);
  });
});

describe('the verdict', () => {
  test('passes an active plugin under its own id', () => {
    const { ok, detail } = verdict(active, ID);

    assert.equal(ok, true);
    assert.match(detail, /opencode-pdkit package 0\.16\.0 active/);
  });

  test('fails a plugin that failed, and carries the error and the ref the server log repeats', () => {
    const failed = {
      source: { type: 'package', target: TARGET },
      state: { status: 'failed', error: 'Plugin failed to load', ref: 'err_0000' },
    };
    const { ok, detail } = verdict(failed, ID);

    assert.equal(ok, false);
    assert.match(detail, /\(no id\) failed: Plugin failed to load; ref err_0000/);
  });

  test('fails a plugin that is not listed at all', () => {
    const { ok, detail } = verdict(undefined, ID);

    assert.equal(ok, false);
    assert.match(detail, /not listed/);
  });

  // The repository, the package and the plugin share one name. `opencode
  // plugin check` passes a plugin that loads under another id; this does not.
  test('fails a plugin that loads under another id', () => {
    const { ok, detail } = verdict({ ...active, id: 'something-else' }, ID);

    assert.equal(ok, false);
    assert.match(detail, /active as something-else, not as opencode-pdkit/);
  });

  test('fails a record without a state', () => {
    assert.equal(verdict({ id: ID, source: { type: 'package' } }, ID).ok, false);
  });
});

// The agent registry, as GET /api/agent lists it: Open Code's own agents and
// the plugin's, each with its ID and mode.
describe("the plugin's agents", () => {
  const BUILTIN = ['build', 'general', 'explore', 'compaction', 'title', 'summary', 'plan'].map((id) => ({ id, mode: id === 'build' || id === 'plan' ? 'primary' : 'subagent' }));
  const listing = (ids, mode = 'subagent') => [...BUILTIN, ...ids.map((id) => ({ id, mode }))];

  test('are the 14 files under agents/', async () => {
    const { agents, problems } = await readAgents(ROOT);

    assert.equal(agents.length, 14);
    assert.deepEqual(problems, []);
  });

  test('pass when every one is listed as a subagent', async () => {
    const ids = (await readAgents(ROOT)).agents.map((agent) => agent.id);

    assert.deepEqual(agentsVerdict(listing(ids), ids), { ok: true, detail: "21 registered, the plugin's 14 among them as subagents" });
  });

  test('fail when one is missing, and name it', () => {
    const result = agentsVerdict(listing(['pd-scout']), ['pd-scout', 'pd-implementer']);

    assert.equal(result.ok, false);
    assert.match(result.detail, /missing: pd-implementer$/);
  });

  // Registered without a mode, an agent is a primary one, which a subagent
  // call refuses to run.
  test('fail when one is a primary agent, and name it', () => {
    const result = agentsVerdict([...listing(['pd-scout']), { id: 'pd-implementer', mode: 'primary' }], ['pd-scout', 'pd-implementer']);

    assert.equal(result.ok, false);
    assert.match(result.detail, /not subagents: pd-implementer$/);
  });

  // Seven agents is Open Code without the plugin's: the count alone passed that.
  test('fail on the built-in agents alone', () => {
    assert.equal(agentsVerdict(BUILTIN, ['pd-scout']).ok, false);
  });

  test('fail when there is no listing, or nothing to look for', () => {
    assert.equal(agentsVerdict(undefined, ['pd-scout']).ok, false);
    assert.equal(agentsVerdict(BUILTIN, []).ok, false);
  });
});

describe("the plugin's commands", () => {
  /** Open Code's own commands on 2.3.0 (F197): what a listing holds without the plugin's. */
  const BUILTIN = [
    { name: 'init', description: 'create/update AGENTS.md' },
    { name: 'review', description: 'review changes' },
    { name: 'goal', description: 'set a goal' },
  ];
  const ours = [
    { name: 'pd:exec', description: '<issue-number> [task-id] · Implement the plan.' },
    { name: 'pd:sync', description: 'Report fork status.' },
  ];

  test('are the 24 skills under skills/, each with the description the registrar gives it', async () => {
    const { skills } = await readSkills(ROOT);
    assert.equal(skills.length, 24);
    assert.equal(skills.every((skill) => typeof skill.description === 'string' && skill.description !== ''), true);
  });

  test('pass when every one is listed with its description', () => {
    assert.deepEqual(commandsVerdict([...BUILTIN, ...ours], ours), { ok: true, detail: "5 registered, the plugin's 2 among them" });
  });

  test('fail when one is missing, and name it', () => {
    const result = commandsVerdict([...BUILTIN, ours[0]], ours);
    assert.equal(result.ok, false);
    assert.match(result.detail, /missing: pd:sync$/);
  });

  // A markdown command of the same name replaces the plugin's, description
  // and all (F100).
  test('fail when one is described otherwise, and say how', () => {
    const result = commandsVerdict([...BUILTIN, ours[0], { name: 'pd:sync', description: 'my own sync' }], ours);
    assert.equal(result.ok, false);
    assert.match(result.detail, /described otherwise: pd:sync \("my own sync"\)$/);
  });

  test('fail on the built-in commands alone, on no listing, or with nothing to look for', () => {
    assert.equal(commandsVerdict(BUILTIN, ours).ok, false);
    assert.equal(commandsVerdict(undefined, ours).ok, false);
    assert.equal(commandsVerdict(BUILTIN, []).ok, false);
  });
});

describe("the plugin's skills", () => {
  const PACKAGE = '/home/u/.cache/opencode/npm/x/node_modules/opencode-pdkit';
  const skill = (name, path = `${PACKAGE}/skills/${name}/SKILL.md`) => ({ id: `${PREFIX}${name}`, name: `${PREFIX}${name}`, path });
  const BUILTIN = [
    { id: 'opencode', path: 'skill://opencode/SKILL.md' },
    { id: 'report', path: 'skill://report/SKILL.md' },
  ];

  test('are the three under skills/ the model may load', async () => {
    const { skills } = await readSkills(ROOT);
    assert.deepEqual(
      skills.filter((one) => !one.personOnly).map((one) => one.name),
      ['package-map', 'upstream-rules', 'worktree-kit'],
    );
  });

  test('pass when every one is listed, read from the package', () => {
    const names = ['package-map', 'worktree-kit'];
    assert.deepEqual(skillsVerdict([...BUILTIN, ...names.map((name) => skill(name))], names), {
      ok: true,
      detail: "4 registered, the plugin's 2 among them",
    });
  });

  test('pass on Windows paths too', () => {
    assert.equal(skillsVerdict([skill('package-map', 'C:\\Users\\u\\pkg\\skills\\package-map\\SKILL.md')], ['package-map']).ok, true);
  });

  test('fail when one is missing, and name it', () => {
    const result = skillsVerdict([...BUILTIN, skill('package-map')], ['package-map', 'worktree-kit']);
    assert.equal(result.ok, false);
    assert.match(result.detail, /missing: pd:worktree-kit$/);
  });

  // A skill file of the same ID replaces the plugin's whole (F121).
  test('fail when one is read from a file elsewhere, and say where', () => {
    const replaced = skill('package-map', '/fork/.opencode/skills/pd:package-map/SKILL.md');
    const result = skillsVerdict([...BUILTIN, replaced], ['package-map']);
    assert.equal(result.ok, false);
    assert.match(result.detail, /read from elsewhere: pd:package-map \(\/fork\/\.opencode\/skills\/pd:package-map\/SKILL\.md\)$/);
  });

  test('fail on the built-in skills alone, on no listing, or with nothing to look for', () => {
    assert.equal(skillsVerdict(BUILTIN, ['package-map']).ok, false);
    assert.equal(skillsVerdict(undefined, ['package-map']).ok, false);
    assert.equal(skillsVerdict(BUILTIN, []).ok, false);
  });
});
