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

// Tests for the gate self-test in lib/doctor.js.
//
// This is the check that answers "is the gate actually on", so the thing worth
// asserting is that it can say no. A self-test that only ever passes is
// indistinguishable from one that does nothing, and this particular one would
// be reassuring while the plugin gated nothing at all.
//
// It runs against a copy of the plugin, so breaking the gate to prove the
// check notices does not mean editing the plugin under the test runner.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanup, commitAll, initRepo } from './helpers/repo-fixture.js';
import { GATE_PROBES, RETIRED_KEYS, checkAgentRuns, checkHooks, checkMcp, checkNode, diagnose, gateSelftest, playwrightCdp } from '../lib/doctor.js';
import { HOOK_HANDLERS } from '../lib/hooks/events.js';
import { append as appendJournal } from '../lib/journal.js';
import { WRAPPERS } from '../lib/hooks/command-parse.js';
import { create } from '../lib/worktree.js';

let plugin;

const find = (checks, id) => checks.find((entry) => entry.id === id);

// Stands in for the Open Code server in every diagnose() here. Without it the
// MCP check runs `opencode api`, and on a machine with Open Code the service
// would load each throwaway repository as a directory of its own — starting
// every MCP server of the person's config once more for each. The MCP check
// has its own tests below, with the server's answers written out.
const offline = async () => ({ ok: false, error: 'no Open Code server in this test' });

before(async () => {
  plugin = await mkdtemp(join(tmpdir(), 'pdkit-doctor-'));

  for (const entry of ['bin', 'lib', 'hooks', 'defaults', 'templates', 'package.json']) {
    await cp(join(process.cwd(), entry), join(plugin, entry), { recursive: true });
  }
});

after(async () => {
  await rm(plugin, { recursive: true, force: true });
});

describe('the probe set', () => {
  // Both halves. A gate that refuses everything fails in the direction where
  // somebody switches it off, which is worse than one that is merely noisy.
  test('covers both refusals and ordinary work', () => {
    const denies = GATE_PROBES.filter((probe) => probe.deny);
    const allows = GATE_PROBES.filter((probe) => !probe.deny);

    assert.ok(denies.length >= 8, 'too few forbidden shapes to be worth running');
    assert.ok(allows.length >= 4, 'without these, a gate that blocks everything looks healthy');
    for (const probe of GATE_PROBES) assert.ok(probe.why, `${probe.command} has no explanation`);
  });

  // A wrapper program must not become a way past the gate, and the ways past a
  // naive matcher are the ones worth probing.
  test('includes the shapes that defeat substring matching', () => {
    const commands = GATE_PROBES.filter((probe) => probe.deny).map((probe) => probe.command);

    // Asked of the wrapper list rather than of one name: the probe set has to
    // stay honest about what the parser strips, not about what it stripped the
    // day the probe was written.
    assert.ok(commands.some((c) => WRAPPERS.includes(c.split(' ')[0])), 'no wrapped form');
    assert.ok(commands.some((c) => c.includes('&&')), 'no chained form');
    assert.ok(commands.some((c) => c.startsWith('(')), 'no subshell form');
    assert.ok(commands.some((c) => c.includes('$(')), 'no substitution form');
    assert.ok(commands.some((c) => c.startsWith('/')), 'no path form');
  });
});

describe('the self-test', () => {
  test('passes on an intact plugin', async () => {
    const checks = await gateSelftest({ pluginRoot: plugin });

    assert.equal(find(checks, 'gate:selftest').status, 'ok');
    assert.equal(find(checks, 'gate:allows').status, 'ok');
  });

  test('fails when the manifest does not register the hook on Bash', async () => {
    const file = join(plugin, 'hooks', 'hooks.json');
    const original = await readFile(file, 'utf8');
    const manifest = JSON.parse(original);
    manifest.hooks.PreToolUse[0].matcher = 'Read';
    await writeFile(file, JSON.stringify(manifest));

    try {
      const checks = await gateSelftest({ pluginRoot: plugin });
      const result = find(checks, 'gate:selftest');

      assert.equal(result.status, 'fail');
      assert.match(result.detail, /no PreToolUse hook on Bash/);
    } finally {
      await writeFile(file, original);
    }
  });

  // The failure this whole check exists for: the plugin is installed, the
  // hooks load, and a push goes through anyway.
  test('names each forbidden command the gate stopped seeing', async () => {
    const file = join(plugin, 'lib', 'hooks', 'rules.js');
    const original = await readFile(file, 'utf8');
    await writeFile(file, original.replace(/ {2}\{\n {4}id: 'push',[\s\S]*?\n {2}\},\n/, ''));

    try {
      const result = find(await gateSelftest({ pluginRoot: plugin }), 'gate:selftest');

      assert.equal(result.status, 'fail');
      assert.match(result.detail, /THE GATE DOES NOT SEE/);
      assert.match(result.detail, /nohup git push/);
      assert.match(result.detail, /\(git push\)/);
    } finally {
      await writeFile(file, original);
    }
  });

  test('the ownership hook is exercised through the manifest too', async () => {
    assert.equal(find(await gateSelftest({ pluginRoot: plugin }), 'owns:selftest').status, 'ok');
  });

  // Same failure as the gate's, one hook across: the map looks enforced and
  // every write goes through.
  test('names it when a write outside the active task is allowed', async () => {
    const file = join(plugin, 'lib', 'hooks', 'owns.js');
    const original = await readFile(file, 'utf8');
    await writeFile(file, original.replace('export async function handle(payload, _context) {', 'export async function handle(payload, _context) {\n  return { block: false };'));

    try {
      const result = find(await gateSelftest({ pluginRoot: plugin }), 'owns:selftest');

      assert.equal(result.status, 'fail');
      assert.match(result.detail, /ownership map is not enforced/);
    } finally {
      await writeFile(file, original);
    }
  });

  test('fails the other way when the gate refuses ordinary work', async () => {
    const file = join(plugin, 'lib', 'hooks', 'dispatch.js');
    const original = await readFile(file, 'utf8');
    await writeFile(file, 'this is not valid javascript {{{\n');

    try {
      const checks = await gateSelftest({ pluginRoot: plugin });

      // pre-bash fails closed, so a broken handler blocks everything. That is
      // the intended behavior, and it is still a broken gate.
      assert.equal(find(checks, 'gate:allows').status, 'fail');
      assert.match(find(checks, 'gate:allows').detail, /git status/);
    } finally {
      await writeFile(file, original);
    }
  });
});

// Every event pdkit has a hook for runs a module, and a partial install can
// lack one. Which events the plugin registers is no longer a file of the
// install's, beside the table, but the plugin's own doing, by the table
// (test/opencode-wiring.test.js holds it to that).
describe('the hook table', () => {
  test('passes on an intact plugin, counting the events of the table', async () => {
    const [entry] = await checkHooks(plugin);

    assert.equal(entry.id, 'hooks');
    assert.equal(entry.status, 'ok');
    assert.equal(entry.detail, `${Object.keys(HOOK_HANDLERS).length} events, every one has a handler`);
  });

  test('names each event whose module is missing, and fails', async () => {
    const moved = [];
    for (const handler of ['post-read.js', 'session-start.js']) {
      await rename(join(plugin, 'lib', 'hooks', handler), join(plugin, `${handler}.away`));
      moved.push(handler);
    }

    try {
      const [entry] = await checkHooks(plugin);

      assert.equal(entry.status, 'fail');
      assert.equal(entry.level, 'required');
      assert.equal(
        entry.detail,
        'post-read -> lib/hooks/post-read.js is missing; session-start -> lib/hooks/session-start.js is missing; ' +
          'pre-compact -> lib/hooks/session-start.js is missing',
      );
    } finally {
      for (const handler of moved) await rename(join(plugin, `${handler}.away`), join(plugin, 'lib', 'hooks', handler));
    }
  });

  // Claude Code's manifest, which the self-tests still read, says nothing of
  // what the plugin registers in Open Code.
  test('reads no hooks/hooks.json', async () => {
    await rename(join(plugin, 'hooks'), join(plugin, 'hooks.away'));

    try {
      assert.equal((await checkHooks(plugin))[0].status, 'ok');
    } finally {
      await rename(join(plugin, 'hooks.away'), join(plugin, 'hooks'));
    }
  });
});

// Slice verification builds in a worktree, so a root that cannot be written or
// a tree git has lost track of becomes a verification failure that looks like a
// failing slice.
// A hook that never connected looks exactly like one with nothing to catch.
// The receipt gate sat on an event subagents never raise for four months and
// every other check here was green, so this one reads what only a live hook
// writes.
describe('the agent-done liveness check', () => {
  let home;

  before(async () => {
    home = await mkdtemp(join(tmpdir(), 'pdkit-doctor-agents-'));
  });

  after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test('no history is a warning that says what it may mean, not a failure', async () => {
    const [entry] = await checkAgentRuns(home);

    assert.equal(entry.status, 'warn');
    assert.notEqual(entry.level, 'required');
    assert.match(entry.detail, /SubagentStop hook is not connected/);
  });

  test('an entry older than the window still warns', async () => {
    await appendJournal({ issue: 1, event: 'agent-done', detail: 'agent task old' }, { home });

    const [entry] = await checkAgentRuns(home, Date.now() + 31 * 24 * 60 * 60 * 1000);
    assert.equal(entry.status, 'warn');
  });

  test('a recent one is green, with the count', async () => {
    const [entry] = await checkAgentRuns(home, Date.now());

    assert.equal(entry.status, 'ok');
    assert.match(entry.detail, /^1 in the last 30d/);
  });
});

// The minimum is a patch release, 22.13.0, where node:sqlite stops needing a
// flag. Read as a major, as it once was, ">=22.13.0" became 2213 and every
// Node failed; and a 22.12 passed a check that only looked at the 22.
describe('the Node check', () => {
  test('compares the running Node to the patch the package names', async () => {
    const pkg = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'));
    assert.equal(pkg.engines.node, '>=22.13.0');
    assert.equal(checkNode(pkg.engines.node).status, 'ok', 'the suite itself runs on a Node the package admits');

    const [major, minor, patch] = process.versions.node.split('.').map(Number);
    assert.equal(checkNode(`>=${major}.${minor}.${patch}`).status, 'ok');
    const above = checkNode(`>=${major}.${minor}.${patch + 1}`);
    assert.equal(above.status, 'fail');
    assert.match(above.detail, new RegExp(`need >= ${major}\\.${minor}\\.${patch + 1}$`));
  });

  test('a range it cannot read is a failure that says so, not a pass', () => {
    const result = checkNode('>=22');
    assert.equal(result.status, 'fail');
    assert.match(result.detail, /engines\.node is ">=22", not ">=X\.Y\.Z"/);
  });
});

describe('the worktree checks', () => {
  let repo;
  let home;
  let scratch;
  let trees;

  // The root sits outside the repository, inside a directory of this run's
  // own: a fixed `$TMPDIR/doctor-trees` was shared by every run on the
  // machine, and two at once removed it from under each other.
  before(async () => {
    repo = await initRepo('pdkit-doctor-worktree-');
    home = await mkdtemp(join(tmpdir(), 'pdkit-doctor-worktree-home-'));
    scratch = await mkdtemp(join(tmpdir(), 'pdkit-doctor-worktree-root-'));
    trees = join(scratch, 'doctor-trees');

    await writeFile(join(repo, 'file.txt'), 'x\n');
    await writeFile(join(repo, '.pdkit.yaml'), `worktrees:\n  root: ${trees}\n`);
    await commitAll(repo, 'chore: seed');
  });

  after(async () => {
    await cleanup(repo, home, scratch);
  });

  test('a root that does not exist yet is fine, and is not created by asking', async () => {
    const report = await diagnose({ cwd: repo, home, pluginRoot: process.cwd(), askServer: offline });
    const root = find(report.checks, 'worktrees:root');

    assert.equal(root.status, 'ok');
    assert.match(root.detail, /not there yet/);
    await assert.rejects(access(trees), 'diagnosing must not create what it is diagnosing');
  });

  test('a tree git lists but disk does not have is a warning with the fix in it', async () => {
    await create({ repoRoot: repo, name: 'ghost', config: { worktrees: { root: trees }, repo: { base_branch: 'main' } }, home });
    await rm(join(trees, 'ghost'), { recursive: true, force: true });

    const report = await diagnose({ cwd: repo, home, pluginRoot: process.cwd(), askServer: offline });
    const registered = find(report.checks, 'worktrees:registered');

    assert.equal(registered.status, 'warn');
    assert.match(registered.detail, /git worktree prune/);
  });
});

// Two checks that exist because of what a real run found. The first is the
// drift `pdkit knowledge check` uncovered on this machine: an array copied by
// `pdkit init` at stage 0 was still pinning the stage-0 value, so a decision
// taken two stages later had never taken effect here — and nothing could have
// noticed, because the merged value was a perfectly valid list.
describe('the validation and config-drift checks', () => {
  let repo;
  let home;

  before(async () => {
    repo = await initRepo('pdkit-doctor-validate-');
    home = await mkdtemp(join(tmpdir(), 'pdkit-doctor-validate-home-'));

    await writeFile(join(repo, 'file.txt'), 'x\n');
    await commitAll(repo, 'chore: seed');
  });

  after(async () => {
    await cleanup(repo, home);
  });

  test('a list that has fallen behind the shipped default is named, with the missing entries', async () => {
    await writeFile(join(home, 'config.yaml'), 'slicing:\n  layer_order: [extension-api, main, tests]\n');

    const report = await diagnose({ cwd: repo, home, pluginRoot: process.cwd(), askServer: offline });
    const arrays = find(report.checks, 'config:arrays');

    assert.equal(arrays.status, 'warn');
    assert.match(arrays.detail, /slicing\.layer_order is missing/);
    assert.match(arrays.detail, /Arrays replace rather than merge/);
  });

  test('a config that pins nothing is not warned about', async () => {
    await writeFile(join(home, 'config.yaml'), 'repo:\n  base_branch: main\n');

    const report = await diagnose({ cwd: repo, home, pluginRoot: process.cwd(), askServer: offline });

    assert.equal(find(report.checks, 'config:arrays').status, 'ok');
  });

  test('nothing to drive is reported as its own problem, not as a missing Playwright', async () => {
    const report = await diagnose({ cwd: repo, home, pluginRoot: process.cwd(), askServer: offline });
    const app = find(report.checks, 'validate:app');

    assert.equal(app.status, 'warn');
    assert.match(app.detail, /nothing to drive|no packaged binary/);
    assert.equal(app.level, 'optional', 'an unbuilt tree does not stop the rest of the plugin working');
  });

  // The execute bit is POSIX. On Windows `access` succeeds for any file that
  // exists whatever mode is asked for, so there is no such thing there as a
  // file that is present and not executable — and asserting one would be
  // asserting against the platform rather than against the check.
  test(
    'a configured binary that is not executable is a warning that names the source',
    { skip: platform() === 'win32' ? 'no execute bit on Windows' : false },
    async () => {
      await writeFile(join(home, 'config.yaml'), `validation:\n  app:\n    binary: ${join(repo, 'not-executable')}\n`);
      await writeFile(join(repo, 'not-executable'), 'x\n');

      const report = await diagnose({ cwd: repo, home, pluginRoot: process.cwd(), askServer: offline });
      const app = find(report.checks, 'validate:app');

      assert.equal(app.status, 'warn');
      assert.match(app.detail, /validation\.app\.binary points at/);
    },
  );

  // The half of the same check that every platform can answer, and the one a
  // misconfigured path actually hits.
  test('a configured binary that is not there is a warning that names the source', async () => {
    // An .exe on Windows, or the refusal is about the extension rather than the absence.
    const absent = join(repo, process.platform === 'win32' ? 'absent-binary.exe' : 'absent-binary');
    await writeFile(join(home, 'config.yaml'), `validation:\n  app:\n    binary: ${absent}\n`);

    const report = await diagnose({ cwd: repo, home, pluginRoot: process.cwd(), askServer: offline });
    const app = find(report.checks, 'validate:app');

    assert.equal(app.status, 'warn');
    assert.match(app.detail, /validation\.app\.binary points at/);
  });
});

// `pdkit init` copies the shipped config whole, so a key retired afterwards
// survives in personal configs looking like a setting somebody chose.
describe('retired config keys', () => {
  test('every entry names the version and says what to do', () => {
    assert.ok(RETIRED_KEYS.length >= 1);
    for (const entry of RETIRED_KEYS) {
      assert.match(entry.key, /^[\w.]+$/);
      assert.match(entry.why, /no longer read \(deleted in \d+\.\d+\)/, `${entry.key} does not say when`);
    }
  });

  test('a config carrying one is warned about, by name', async () => {
    const home = await mkdtemp(join(tmpdir(), 'pdkit-doctor-retired-'));

    try {
      await writeFile(join(home, 'config.yaml'), 'gates:\n  require_states:\n    - preflight-green\n');
      const report = await diagnose({ home, pluginRoot: process.cwd(), askServer: offline });
      const gates = find(report.checks, 'config:gates');

      assert.equal(gates.status, 'warn');
      assert.match(gates.detail, /gates\.require_states is no longer read/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  // The shipped defaults must not themselves carry a key the plugin retired,
  // which is the mistake that would make this check warn for everybody at once.
  test('the shipped defaults carry none of them', async () => {
    const clean = await mkdtemp(join(tmpdir(), 'pdkit-doctor-clean-'));

    try {
      const report = await diagnose({ home: clean, pluginRoot: process.cwd(), askServer: offline });
      assert.equal(find(report.checks, 'config:gates').status, 'ok');
    } finally {
      await rm(clean, { recursive: true, force: true });
    }
  });
});

// Section 8.2 claimed this check verified the endpoint. Until 0.21 it verified
// the name: a Playwright server started without `--cdp-endpoint` launches a
// browser of its own, never sees the application pdkit started, and reported
// `connected` exactly like one wired correctly. The command line comes from
// the config documents Open Code read (lib/opencode-api.js mcpServers,
// test/opencode-api.test.js); this is what doctor makes of it.
describe('the Playwright wiring', () => {
  test('a server aimed at the configured port is the only green case', () => {
    assert.equal(playwrightCdp('npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:9222', 9222).ok, true);
    assert.match(playwrightCdp('npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:9222', 9222).detail, /attaches to/);
  });

  // The failure that started this: connected, healthy, and looking at a browser
  // of its own.
  test('no --cdp-endpoint is a warning that names the command to run', () => {
    const result = playwrightCdp('npx @playwright/mcp@latest', 9222);

    assert.equal(result.ok, false);
    assert.match(result.detail, /browser of its own/);
    assert.ok(
      result.detail.includes('Re-add it as: opencode mcp add playwright --global -- npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:9222'),
      result.detail,
    );
  });

  test('the right flag on the wrong port is caught too, with both numbers', () => {
    const result = playwrightCdp('npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:9333', 9222);

    assert.equal(result.ok, false);
    assert.match(result.detail, /9333/);
    assert.match(result.detail, /9222/);
  });

  test('the flag is read in both spellings', () => {
    assert.equal(playwrightCdp('mcp --cdp-endpoint=http://127.0.0.1:9222', 9222).ok, true);
  });
});

// What doctor says about the MCP servers, from three answers of the Open Code
// server about the fork's directory: the config documents (on, off, and the
// command line), the servers' status, and the rules each agent ends up with.
// The answers are written out here in the shapes Open Code 2.3.0 gives them.
describe('the MCP servers Open Code reports', () => {
  const PORT = 9222;
  const CONFIG = { mcp: { playwright: 'auto', context7: 'off', basic_memory: 'off', github: 'off' }, validation: { app: { debug_port: PORT } } };
  const WIRED = ['npx', '@playwright/mcp@latest', '--cdp-endpoint', `http://127.0.0.1:${PORT}`];
  const FIX = `opencode mcp add playwright --global -- npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:${PORT}`;

  const answer = (data) => ({ ok: true, data });
  /** GET /api/config: a bare list, documents and directories, in the order the server read them. */
  const documents = (...servers) => [
    ...servers.map((entry, index) => ({ type: 'document', path: `/config/${index}/opencode.json`, info: entry === null ? {} : { mcp: { servers: entry } } })),
    { type: 'directory', path: '/config/0', info: {} },
  ];
  /** GET /api/mcp. */
  const statuses = (entries) => ({ location: { directory: '/fork' }, data: Object.entries(entries).map(([name, status]) => ({ name, status })) });
  /** GET /api/agent. */
  const agents = (validator) => ({
    location: { directory: '/fork' },
    data: [
      { id: 'build', permissions: [{ action: '*', resource: '*', effect: 'allow' }] },
      ...(validator === undefined ? [] : [{ id: 'pd-validator', permissions: validator }]),
    ],
  });

  /** What the plugin gives pd-validator, from its agent file, as the registrar builds it. */
  let validatorRules;
  /** Rules Open Code adds after the plugin's to every agent of this version. */
  const BUILT_IN_TAIL = [
    { action: 'browser', resource: '*', effect: 'deny' },
    { action: 'skill', resource: 'browser', effect: 'deny' },
  ];

  before(async () => {
    const { permissionsFor, readAgents } = await import('../opencode/agents.js');
    const validator = (await readAgents(process.cwd())).agents.find((agent) => agent.id === 'pd-validator');
    validatorRules = [...permissionsFor(validator.tools, ['/plugin', '/pdkit-home']).rules, ...BUILT_IN_TAIL];
  });

  /**
   * A server that gives, for each path, the answers listed, one per question
   * and the last one again after that, and keeps what it was asked.
   */
  function serverWith(answers) {
    const asked = [];
    const ask = async (path) => {
      asked.push(path);
      const list = answers[path];
      if (list === undefined) throw new Error(`doctor asked ${path}, which this test does not answer`);
      return list[Math.min(asked.filter((entry) => entry === path).length, list.length) - 1];
    };
    return { ask, asked };
  }

  /** No real waiting: the clock moves by each pause. */
  function clock() {
    let time = 0;
    return { now: () => time, pause: async (ms) => void (time += ms) };
  }

  const run = (answers, config = CONFIG, wait = 5000) => {
    const server = serverWith(answers);
    return checkMcp(config, { directory: '/fork', ask: server.ask, wait, ...clock() }).then((checks) => ({ checks, asked: server.asked }));
  };

  test('nothing expected, nothing asked', async () => {
    const { checks, asked } = await run({}, { mcp: { playwright: 'off', context7: 'off' } });

    assert.deepEqual(checks, [{ id: 'mcp', level: 'optional', status: 'skip', detail: 'no servers expected by config' }]);
    assert.deepEqual(asked, []);
  });

  test('a server that cannot be asked is "cannot tell", in its own words', async () => {
    const { checks } = await run({ '/api/config': [{ ok: false, error: 'opencode: not found' }] });

    assert.deepEqual(checks, [{ id: 'mcp', level: 'optional', status: 'skip', detail: 'cannot tell: opencode: not found' }]);
  });

  test('not configured names what degrades and the command, --global and why', async () => {
    const { checks, asked } = await run({ '/api/config': [answer(documents(null))] });
    const line = find(checks, 'mcp:playwright');

    assert.equal(line.status, 'skip');
    assert.match(line.detail, /^not configured — \/pd:validate produces a checklist instead of a run and never sets PASS\. /);
    assert.ok(line.detail.includes(`Add it with: ${FIX} (--global,`), line.detail);
    assert.match(line.detail, /no worktree would see it/);
    // Nothing configured, so no status to wait for.
    assert.deepEqual(asked, ['/api/config']);
  });

  test('`on` makes the same absence a warning', async () => {
    const { checks } = await run({ '/api/config': [answer(documents(null))] }, { ...CONFIG, mcp: { playwright: 'on' } });

    assert.equal(find(checks, 'mcp:playwright').status, 'warn');
  });

  test('disabled in the last document that names it is not configured; enabled there is', async () => {
    const off = await run({
      '/api/config': [answer(documents({ playwright: { type: 'local', command: WIRED } }, { playwright: { type: 'local', command: WIRED, disabled: true } }))],
    });
    assert.match(find(off.checks, 'mcp:playwright').detail, /^not configured/);
    assert.deepEqual(off.asked, ['/api/config']);

    const on = await run({
      '/api/config': [answer(documents({ playwright: { type: 'local', command: ['true'], disabled: true } }, { playwright: { type: 'local', command: WIRED } }))],
      '/api/mcp': [answer(statuses({ playwright: { status: 'connected' } }))],
      '/api/agent': [answer(agents(validatorRules))],
    });
    assert.equal(find(on.checks, 'mcp:playwright').status, 'ok');
  });

  test('connected, aimed at the port, and pd-validator offered its tools: ok', async () => {
    const { checks } = await run({
      '/api/config': [answer(documents({ playwright: { type: 'local', command: WIRED } }))],
      '/api/mcp': [answer(statuses({ playwright: { status: 'connected' } }))],
      '/api/agent': [answer(agents(validatorRules))],
    });

    assert.deepEqual(find(checks, 'mcp:playwright'), {
      id: 'mcp:playwright',
      level: 'optional',
      status: 'ok',
      detail: `attaches to http://127.0.0.1:${PORT}; pd-validator is offered all 6 of its tools`,
    });
  });

  // F157, F197: the server answers about a directory it is still loading with
  // what it has so far — no servers, the built-in agents only.
  test('an empty list and a missing agent are asked again, not reported', async () => {
    const { checks, asked } = await run({
      '/api/config': [answer(documents({ playwright: { type: 'local', command: WIRED } }))],
      '/api/mcp': [answer(statuses({})), answer(statuses({ playwright: { status: 'pending' } })), answer(statuses({ playwright: { status: 'connected' } }))],
      '/api/agent': [answer(agents(undefined)), answer(agents(validatorRules))],
    });

    assert.equal(find(checks, 'mcp:playwright').status, 'ok');
    assert.deepEqual(asked, ['/api/config', '/api/mcp', '/api/mcp', '/api/mcp', '/api/agent', '/api/agent']);
  });

  test('still pending when the time is up is "cannot tell", not down', async () => {
    const { checks } = await run({
      '/api/config': [answer(documents({ playwright: { type: 'local', command: WIRED } }))],
      '/api/mcp': [answer(statuses({ playwright: { status: 'pending' } }))],
    });
    const line = find(checks, 'mcp:playwright');

    assert.equal(line.status, 'skip');
    assert.match(line.detail, /^cannot tell: configured, and still starting after 5 s — run pdkit doctor again$/);
  });

  test('configured but never listed is "cannot tell" too', async () => {
    const { checks } = await run({
      '/api/config': [answer(documents({ playwright: { type: 'local', command: WIRED } }))],
      '/api/mcp': [answer(statuses({}))],
    });

    assert.match(find(checks, 'mcp:playwright').detail, /^cannot tell: configured, but Open Code did not list it within 5 s/);
  });

  // DV18: Claude Code's version dropped the status `claude mcp list` printed,
  // and reported a server that failed to start as attached.
  test('failed is a warning that carries the server’s error and what degrades', async () => {
    const { checks, asked } = await run({
      '/api/config': [answer(documents({ playwright: { type: 'local', command: WIRED } }))],
      '/api/mcp': [answer(statuses({ playwright: { status: 'failed', error: 'NotFound: ChildProcess.spawn (npx)' } }))],
    });

    assert.deepEqual(find(checks, 'mcp:playwright'), {
      id: 'mcp:playwright',
      level: 'optional',
      status: 'warn',
      detail: 'configured, but Open Code reports it failed: NotFound: ChildProcess.spawn (npx) — /pd:validate produces a checklist instead of a run and never sets PASS',
    });
    assert.equal(asked.includes('/api/agent'), false, 'a server that is down has no tools to check');
  });

  test('needs_auth is a warning as well', async () => {
    const { checks } = await run(
      {
        '/api/config': [answer(documents({ context7: { type: 'remote', url: 'https://mcp.example.invalid/mcp' } }))],
        '/api/mcp': [answer(statuses({ context7: { status: 'needs_auth', error: 'authorization required' } }))],
      },
      { mcp: { playwright: 'off', context7: 'on' } },
    );

    assert.equal(find(checks, 'mcp:context7').status, 'warn');
    assert.match(find(checks, 'mcp:context7').detail, /^configured, but Open Code reports it needs_auth: authorization required — library documentation/);
  });

  test('connected without --cdp-endpoint, or to another port, is the wiring warning', async () => {
    for (const [command, pattern] of [
      [['npx', '@playwright/mcp@latest'], /browser of its own/],
      [['npx', '@playwright/mcp@latest', '--cdp-endpoint', 'http://127.0.0.1:9333'], /9333.*9222/],
    ]) {
      const { checks } = await run({
        '/api/config': [answer(documents({ playwright: { type: 'local', command } }))],
        '/api/mcp': [answer(statuses({ playwright: { status: 'connected' } }))],
      });
      assert.equal(find(checks, 'mcp:playwright').status, 'warn');
      assert.match(find(checks, 'mcp:playwright').detail, pattern);
    }
  });

  // F153: a top-level `permissions` in the person's config is appended to
  // every agent's rules, the plugin's included, after the plugin's own.
  test('a later rule that takes pd-validator’s tools away is a warning that names them and the rule', async () => {
    const deny = { action: 'playwright_*', resource: '*', effect: 'deny' };
    const rules = [...validatorRules.slice(0, -BUILT_IN_TAIL.length), deny, ...BUILT_IN_TAIL];
    const { checks } = await run({
      '/api/config': [answer(documents({ playwright: { type: 'local', command: WIRED } }))],
      '/api/mcp': [answer(statuses({ playwright: { status: 'connected' } }))],
      '/api/agent': [answer(agents(rules))],
    });
    const line = find(checks, 'mcp:playwright');

    assert.equal(line.status, 'warn');
    assert.match(line.detail, /^attaches to http:\/\/127\.0\.0\.1:9222, but pd-validator is not offered 6 of its 6 tools \(playwright_browser_navigate, /);
    assert.ok(line.detail.includes('`playwright_* * deny`'), line.detail);
    assert.match(line.detail, /never sets PASS/);
    assert.match(line.detail, /agents\.pd-validator\.permissions/);
  });

  test('allowed again under agents.pd-validator.permissions, after the rule, they are offered', async () => {
    const deny = { action: 'playwright_*', resource: '*', effect: 'deny' };
    const again = validatorRules.filter((rule) => rule.action.startsWith('playwright_'));
    const { checks } = await run({
      '/api/config': [answer(documents({ playwright: { type: 'local', command: WIRED } }))],
      '/api/mcp': [answer(statuses({ playwright: { status: 'connected' } }))],
      '/api/agent': [answer(agents([...validatorRules, deny, ...again]))],
    });

    assert.equal(find(checks, 'mcp:playwright').status, 'ok');
  });

  test('pd-validator not registered here: ok on the wiring, and the line says the rest was not checked', async () => {
    const { checks } = await run(
      {
        '/api/config': [answer(documents({ playwright: { type: 'local', command: WIRED } }))],
        '/api/mcp': [answer(statuses({ playwright: { status: 'connected' } }))],
        '/api/agent': [answer(agents(undefined))],
      },
      CONFIG,
      0,
    );

    assert.deepEqual(find(checks, 'mcp:playwright'), {
      id: 'mcp:playwright',
      level: 'optional',
      status: 'ok',
      detail: `attaches to http://127.0.0.1:${PORT}; whether pd-validator can use it was not checked: pd-validator is not registered in this directory`,
    });
  });

  // Open Code names a server's tools after the server, case and all: the
  // validator's rules name `playwright_…`, which a server called `Playwright`
  // does not offer.
  test('a server under another case is found, and pd-validator shown to have none of its tools', async () => {
    const { checks } = await run({
      '/api/config': [answer(documents({ Playwright: { type: 'local', command: WIRED } }))],
      '/api/mcp': [answer(statuses({ Playwright: { status: 'connected' } }))],
      '/api/agent': [answer(agents(validatorRules))],
    });

    assert.equal(find(checks, 'mcp:playwright').status, 'warn');
    assert.match(find(checks, 'mcp:playwright').detail, /pd-validator's rules allow none of its tools \(Playwright_\*\)/);
  });

  test('another server is ok once connected, under either spelling of its name', async () => {
    const { checks } = await run(
      {
        '/api/config': [answer(documents({ 'basic-memory': { type: 'local', command: ['basic-memory', 'mcp'] } }))],
        '/api/mcp': [answer(statuses({ 'basic-memory': { status: 'connected' } }))],
      },
      { mcp: { playwright: 'off', basic_memory: 'on' } },
    );

    assert.deepEqual(find(checks, 'mcp:basic_memory'), { id: 'mcp:basic_memory', level: 'optional', status: 'ok', detail: 'connected' });
  });

  test('a server’s environment is never printed', async () => {
    const { checks } = await run({
      '/api/config': [answer(documents({ playwright: { type: 'local', command: ['npx', '@playwright/mcp@latest'], environment: { TOKEN: 'do-not-print-me' } } }))],
      '/api/mcp': [answer(statuses({ playwright: { status: 'connected' } }))],
    });

    assert.doesNotMatch(JSON.stringify(checks), /do-not-print-me|TOKEN/);
  });
});

// Claude Code's version checked the model `pdkit init` wrote into the fork's
// .claude/settings.local.json against the skills' frontmatter. Nothing writes
// one now — each /pd: command switches the session to its own model — so
// there is no copy to fall behind, and the file Claude Code's version left
// there is that version's business.
describe('the session model in the fork', () => {
  let fork;

  before(async () => {
    fork = await initRepo('pdkit-doctor-settings-');
    await mkdir(join(fork, '.claude'), { recursive: true });
    await writeFile(join(fork, '.claude', 'settings.local.json'), JSON.stringify({ model: 'opus' }, null, 2));
  });

  after(async () => {
    await cleanup(fork);
  });

  test('is not checked, and a model left there by Claude Code says nothing', async () => {
    const report = await diagnose({ cwd: fork, pluginRoot: process.cwd(), askServer: offline });

    assert.equal(find(report.checks, 'settings:model'), undefined);
    assert.deepEqual(report.checks.filter((entry) => /settings\.local\.json/.test(entry.detail ?? '')), []);
  });
});

// Without git, the self-test fails at its first `git init` and says so in
// execFile's own words, as it did before git calls went through lib/git.js.
// `git.text` once swapped `spawn git ENOENT` for an install hint here — wrong
// besides when it was `cwd` that was missing — and the line a person saw
// changed with it.
describe('doctor --gate-selftest without git', () => {
  let bin;

  before(async () => {
    bin = await mkdtemp(join(tmpdir(), 'pdkit-node-only-'));
    if (platform() !== 'win32') await symlink(process.execPath, join(bin, 'node'));
  });

  after(async () => {
    await rm(bin, { recursive: true, force: true });
  });

  test(
    'reports execFile’s own spawn error, exit 1',
    { skip: platform() === 'win32' ? 'a PATH of only node needs a symlink, which Windows does not give an unprivileged user' : false },
    () => {
      const pdkit = fileURLToPath(new URL('../bin/pdkit', import.meta.url));
      const run = spawnSync(process.execPath, [pdkit, 'doctor', '--gate-selftest'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: bin },
      });

      assert.equal(run.status, 1);
      assert.equal(run.stderr, 'pdkit doctor: spawn git ENOENT\n');
      assert.doesNotMatch(run.stderr, /git is not installed/);
    },
  );
});
