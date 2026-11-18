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

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, platform, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanup, commitAll, initRepo } from './helpers/repo-fixture.js';
import {
  GATE_PROBES,
  RETIRED_KEYS,
  checkAgentRuns,
  checkHookNode,
  checkHooks,
  checkMcp,
  checkNode,
  checkPlugin,
  diagnose,
  gateSelftest,
  playwrightCdp,
} from '../lib/doctor.js';
import { HOOK_HANDLERS } from '../lib/hooks/events.js';
import { append as appendJournal } from '../lib/journal.js';
import { WRAPPERS } from '../lib/hooks/command-parse.js';
import { create } from '../lib/worktree.js';
import { preBash, preWrite } from '../opencode/bridge/payload.js';

let plugin;

const find = (checks, id) => checks.find((entry) => entry.id === id);

// Stands in for the Open Code server in every diagnose() here. Without it the
// MCP check runs `opencode api`, and on a machine with Open Code the service
// would load each throwaway repository as a directory of its own — starting
// every MCP server of the person's config once more for each. The MCP check
// has its own tests below, with the server's answers written out.
const offline = async () => ({ ok: false, error: 'no Open Code server in this test' });

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

// What a shell of an Open Code session carries, as the doctor reads it: the
// session the shell tool names, and the plugin's labels (opencode/environment.js).
const SESSION = { OPENCODE_SESSION_ID: 'ses_e1ab4dbd8ffeAGRhkvVT6EWLR0' };
const EVENTS = Object.keys(HOOK_HANDLERS);
const labeled = (hooks = EVENTS, more = {}) => ({ ...SESSION, PDKIT_HOOKS: hooks.join(','), ...more });
const POSIX = platform() !== 'win32';
/** This process's environment with only `path` on PATH, under whatever case the platform spells it in. */
const onPath = (path) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PATH')), PATH: path });
const DENIES = GATE_PROBES.filter((probe) => probe.deny).length;

/**
 * Run `body` with the copy's bin/pdkit — what the hook runner starts — replaced
 * by `source`, and put it back after.
 *
 * @template T
 * @param {string} source
 * @param {() => Promise<T>} body
 * @returns {Promise<T>}
 */
async function withEntryPoint(source, body) {
  const file = join(plugin, 'bin', 'pdkit');
  const original = await readFile(file, 'utf8');
  await writeFile(file, source);
  try {
    return await body();
  } finally {
    await writeFile(file, original);
  }
}

before(async () => {
  plugin = await mkdtemp(join(tmpdir(), 'pdkit-doctor-'));

  for (const entry of ['bin', 'lib', 'defaults', 'templates', 'package.json']) {
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
  // In the words the Claude Code version printed: what runs the probes
  // changed, what a person reads did not.
  test('passes on an intact plugin', async () => {
    const checks = await gateSelftest({ pluginRoot: plugin });

    assert.deepEqual(
      checks.map(({ id, level, status, detail }) => ({ id, level, status, detail })),
      [
        { id: 'owns:selftest', level: 'required', status: 'ok', detail: 'writes outside the active task are refused, writes inside are not' },
        { id: 'gate:selftest', level: 'required', status: 'ok', detail: `${DENIES} forbidden commands all refused, through ${join(plugin, 'bin', 'pdkit')}` },
        { id: 'gate:allows', level: 'required', status: 'ok', detail: `${GATE_PROBES.length - DENIES} ordinary commands all allowed` },
      ],
    );
  });

  // Under Claude Code a hook that exited 1 let the command run, and the old
  // criterion counted every ordinary probe as allowed. Through the bridge it is
  // no answer: refused on pre-bash, unchecked on pre-write — a pass on neither.
  test('a hook that crashes answers nothing, and every half fails saying so', async () => {
    await withEntryPoint("throw new Error('broken on purpose');\n", async () => {
      const checks = await gateSelftest({ pluginRoot: plugin });

      const gate = find(checks, 'gate:selftest');
      assert.equal(gate.status, 'fail');
      assert.match(gate.detail, new RegExp(`^THE GATE DOES NOT SEE ${DENIES} of ${DENIES} forbidden commands:`));
      assert.match(gate.detail, /^ {6}git push {2}\(the bare form\) — no answer$/m);
      assert.match(gate.detail, /\n {6}the hook gave no answer: exited with code 1 \(Error: broken on purpose[^\n]*$/);

      const allows = find(checks, 'gate:allows');
      assert.equal(allows.status, 'fail');
      assert.match(allows.detail, /^ {6}git status {2}\(reading\) — no answer$/m);
      assert.match(allows.detail, /\n {6}the hook gave no answer: exited with code 1 \(Error: broken on purpose[^\n]*$/);

      const owns = find(checks, 'owns:selftest');
      assert.equal(owns.status, 'fail');
      assert.match(owns.detail, /^writes go through unchecked — the hook gave no answer: exited with code 1 \(Error: broken on purpose/);
    });
  });

  // A hook that never started gives one reason for every probe, said once;
  // reasons that differ stay beside their probes, and a command the hook let
  // through is not a command it failed to answer.
  test('says why there was no answer once when it is one reason, beside each probe when not', async () => {
    const standIn = [
      "import { readFileSync } from 'node:fs';",
      "const command = JSON.parse(readFileSync(0, 'utf8')).tool_input?.command ?? '';",
      "process.exit(command.startsWith('gh ') ? 0 : command.startsWith('nohup ') ? 1 : 3);",
      '',
    ].join('\n');

    await withEntryPoint(standIn, async () => {
      const checks = await gateSelftest({ pluginRoot: plugin });
      const gate = find(checks, 'gate:selftest').detail.split('\n').map((line) => line.trim());
      const allows = find(checks, 'gate:allows').detail.split('\n').map((line) => line.trim());

      assert.ok(gate.includes('gh pr create --base main --head x --title t  (opening a pull request) — allowed'));
      assert.ok(gate.includes('nohup git push  (behind a wrapper program) — no answer: exited with code 1 and wrote nothing to stderr'));
      assert.ok(gate.includes('git push  (the bare form) — no answer: exited with code 3 and wrote nothing to stderr'));
      assert.deepEqual(gate.filter((line) => line.startsWith('the hook gave no answer')), []);

      assert.ok(allows.includes('git status  (reading) — no answer'));
      assert.ok(!allows.some((line) => line.startsWith('gh pr view 1')));
      assert.equal(allows.at(-1), 'the hook gave no answer: exited with code 3 and wrote nothing to stderr');
    });
  });

  // The PATH that counts is the one the hook is started with: in a session,
  // the Open Code server's. Without node there the plugin refuses every
  // command, and the self-test says it is not checking any.
  test('no node on the PATH the hook starts with: no answer, and every half fails', { skip: !POSIX && 'T10.10' }, async () => {
    const empty = await mkdtemp(join(tmpdir(), 'pdkit-no-node-'));

    try {
      const checks = await gateSelftest({ pluginRoot: plugin, env: onPath(empty) });
      const unfound = 'cannot run: "node" was not found on the PATH of the process that runs hooks (ENOENT)';

      assert.equal(find(checks, 'gate:selftest').status, 'fail');
      assert.ok(find(checks, 'gate:selftest').detail.includes('\n      git push  (the bare form) — no answer\n'));
      assert.ok(find(checks, 'gate:selftest').detail.includes(`\n      the hook gave no answer: ${unfound}`));
      assert.equal(find(checks, 'gate:allows').status, 'fail');
      assert.ok(find(checks, 'gate:allows').detail.includes('\n      git status  (reading) — no answer\n'));
      assert.ok(find(checks, 'gate:allows').detail.includes(`\n      the hook gave no answer: ${unfound}`));
      assert.equal(find(checks, 'owns:selftest').status, 'fail');
      assert.ok(find(checks, 'owns:selftest').detail.startsWith(`writes go through unchecked — the hook gave no answer: ${unfound}`));
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  // A token of the person's would let a probe through and be spent on it, and
  // the journal only grows: each half runs against a home of its own, and the
  // one the doctor was given — the live one, from a session — stays as it was.
  test('leaves the home it is given as it was', async () => {
    const home = await mkdtemp(join(tmpdir(), 'pdkit-doctor-home-'));

    try {
      const checks = await gateSelftest({ pluginRoot: plugin, env: { ...process.env, PDKIT_HOME: home } });

      assert.equal(find(checks, 'gate:selftest').status, 'ok');
      assert.deepEqual(await readdir(home), []);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  // From a session the doctor's environment is the one Open Code gives the
  // shell — the server's PATH (F93) — and that is what the hook starts with,
  // not the PATH of whatever ran the doctor's process.
  test('diagnose starts the hook with the environment it is given', { skip: !POSIX && 'T10.10' }, async () => {
    const repo = await initRepo('pdkit-doctor-selftest-env-');
    const empty = await mkdtemp(join(tmpdir(), 'pdkit-no-node-'));

    try {
      const report = await diagnose({ cwd: repo, pluginRoot: plugin, gateSelftest: true, askServer: offline, env: onPath(empty) });

      assert.equal(find(report.checks, 'gate:selftest').status, 'fail');
      assert.match(find(report.checks, 'gate:selftest').detail, /the hook gave no answer: cannot run: "node" was not found on the PATH/);
      assert.equal(report.status, 'fail');
    } finally {
      await cleanup(repo);
      await rm(empty, { recursive: true, force: true });
    }
  });

  // lib/ does not import the bridge, so the self-test spells out the payloads
  // the bridge builds. This holds the two to one shape: what reaches the hook
  // from a probe is what reaches it from a command of the session the doctor
  // runs in.
  test('gives the hook what the bridge gives it, run where the payload says', async () => {
    const record = join(plugin, 'record.jsonl');
    const standIn = [
      "import { appendFileSync, readFileSync, realpathSync } from 'node:fs';",
      "const payload = JSON.parse(readFileSync(0, 'utf8'));",
      'const here = process.cwd() === realpathSync(payload.cwd);',
      "appendFileSync(process.env.PDKIT_TEST_RECORD, JSON.stringify({ event: process.argv.slice(2), here, payload }) + '\\n');",
      '',
    ].join('\n');
    const json = (value) => JSON.parse(JSON.stringify(value));

    try {
      await withEntryPoint(standIn, () => gateSelftest({ pluginRoot: plugin, env: { ...process.env, ...SESSION, PDKIT_TEST_RECORD: record } }));
      const runs = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

      const shell = runs.filter((run) => run.event.join(' ') === 'hook pre-bash');
      assert.deepEqual(
        shell.map(({ payload }) => payload.tool_input.command),
        GATE_PROBES.map((probe) => probe.command),
      );
      shell.forEach(({ here, payload }, index) => {
        const event = { tool: 'shell', sessionID: SESSION.OPENCODE_SESSION_ID, input: { command: GATE_PROBES[index].command } };
        assert.deepEqual(payload, json(preBash(event, payload.cwd)));
        assert.equal(basename(payload.cwd), GATE_PROBES[index].outside ? 'elsewhere' : 'podman-desktop');
        assert.equal(here, true, `${GATE_PROBES[index].command} ran outside ${payload.cwd}`);
      });

      const writes = runs.filter((run) => run.event.join(' ') === 'hook pre-write');
      assert.deepEqual(
        writes.map(({ payload }) => payload.tool_input.file_path.slice(payload.cwd.length)),
        [join('/', 'other', 'x.ts'), join('/', 'owned', 'x.ts')],
      );
      for (const { here, payload } of writes) {
        const event = { tool: 'write', sessionID: SESSION.OPENCODE_SESSION_ID, input: { path: payload.tool_input.file_path } };
        assert.deepEqual([payload], json(preWrite(event, { directory: payload.cwd, home: homedir() })));
        assert.equal(here, true);
      }
      assert.equal(runs.length, shell.length + writes.length);
    } finally {
      await rm(record, { force: true });
    }
  });

  // From a terminal there is no session, and the bridge would name none.
  test('names no session outside one', async () => {
    const record = join(plugin, 'record.jsonl');
    const standIn = "import { appendFileSync, readFileSync } from 'node:fs';\nappendFileSync(process.env.PDKIT_TEST_RECORD, readFileSync(0, 'utf8') + '\\n');\n";
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !(name in SESSION)));

    try {
      await withEntryPoint(standIn, () => gateSelftest({ pluginRoot: plugin, env: { ...env, PDKIT_TEST_RECORD: record } }));
      const payloads = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

      assert.equal(payloads.length, GATE_PROBES.length + 2);
      assert.deepEqual(payloads.filter((payload) => 'session_id' in payload), []);
    } finally {
      await rm(record, { force: true });
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
      assert.match(result.detail, /nohup git push {2}\(behind a wrapper program\) — allowed$/m);
      assert.match(result.detail, /\(git push\)/);
    } finally {
      await writeFile(file, original);
    }
  });

  test('the ownership hook is exercised the same way', async () => {
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

  // pre-write fails open: runHook lets the write through when owns.js does not
  // load, and says so on stderr. That line is the why worth showing.
  test('an ownership handler that does not load is named with runHook’s words', async () => {
    const file = join(plugin, 'lib', 'hooks', 'owns.js');
    const original = await readFile(file, 'utf8');
    await writeFile(file, 'this is not valid javascript {{{\n');

    try {
      const result = find(await gateSelftest({ pluginRoot: plugin }), 'owns:selftest');

      assert.equal(result.status, 'fail');
      assert.match(result.detail, /^a write outside the active task's files was allowed — the ownership map is not enforced \(pdkit: hook "pre-write" handler "owns\.js" is unavailable \(.+\); allowing\)$/);
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
  test('passes on an intact plugin, counting the events of the table, and says where registrations show', async () => {
    const [entry] = await checkHooks(plugin, {});

    assert.equal(entry.id, 'hooks');
    assert.equal(entry.level, 'required');
    assert.equal(entry.status, 'ok');
    assert.equal(
      entry.detail,
      `${EVENTS.length} events, every one has a handler; which ones the plugin registered shows only in a session (/pd:doctor)`,
    );
  });

  test('names each event whose module is missing, and fails', async () => {
    const moved = [];
    for (const handler of ['post-read.js', 'session-start.js']) {
      await rename(join(plugin, 'lib', 'hooks', handler), join(plugin, `${handler}.away`));
      moved.push(handler);
    }

    try {
      const [entry] = await checkHooks(plugin, {});

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

  // Claude Code's manifest is gone from the plugin, and nothing here missed it:
  // which hooks run in Open Code is the plugin's own doing.
  test('reads no hooks/hooks.json', async () => {
    await assert.rejects(access(join(plugin, 'hooks')), { code: 'ENOENT' });
    assert.equal((await checkHooks(plugin, {}))[0].status, 'ok');
  });
});

// From a session the plugin says which events stood (PDKIT_HOOKS), and the
// table is held to that. The event that matters most is subagent-stop: when
// its point refuses it, the receipt gate is off while everything else looks
// fine (D11). A point a later Open Code renames is not refused (F304); that
// shows in the agent-done check below.
describe('the hooks the plugin registered in the session', () => {
  test('every event of the table: ok, and it says so', async () => {
    const [entry] = await checkHooks(plugin, labeled());

    assert.equal(entry.status, 'ok');
    assert.equal(entry.detail, `${EVENTS.length} events, every one has a handler and is registered in this session`);
  });

  test('the order the plugin lists them in does not matter', async () => {
    assert.equal((await checkHooks(plugin, labeled([...EVENTS].reverse())))[0].status, 'ok');
  });

  test('no subagent-stop is a failure that says the receipt gate is off', async () => {
    const [entry] = await checkHooks(plugin, labeled(EVENTS.filter((event) => event !== 'subagent-stop')));

    assert.equal(entry.status, 'fail');
    assert.equal(entry.level, 'required');
    assert.equal(
      entry.detail,
      'not registered in this session: subagent-stop (no receipt gate, and no agent-done is written) — the Open Code ' +
        'server’s stderr says why ("opencode-pdkit: cannot register its hooks (…)")',
    );
  });

  test('each missing event is named, in the order of the table, what guards something with what is off', async () => {
    const [entry] = await checkHooks(plugin, labeled(['pre-bash', 'post-write', 'post-bash', 'post-claim', 'subagent-stop', 'pre-compact', 'prompt-submit']));

    assert.equal(entry.status, 'fail');
    assert.match(
      entry.detail,
      /^not registered in this session: pre-write \(no check of writes against the task’s Owns\), post-read, session-start — /,
    );
  });

  test('an empty list registers nothing', async () => {
    const [entry] = await checkHooks(plugin, { ...SESSION, PDKIT_HOOKS: '' });

    assert.equal(entry.status, 'fail');
    assert.ok(entry.detail.includes('pre-bash (no gate on writes upstream)'), entry.detail);
  });

  test('a missing module and a missing registration are both reported', async () => {
    await rename(join(plugin, 'lib', 'hooks', 'post-read.js'), join(plugin, 'post-read.js.away'));
    try {
      const [entry] = await checkHooks(plugin, labeled(EVENTS.filter((event) => event !== 'subagent-stop')));

      assert.equal(entry.status, 'fail');
      assert.match(entry.detail, /^post-read -> lib\/hooks\/post-read\.js is missing; not registered in this session: subagent-stop /);
    } finally {
      await rename(join(plugin, 'post-read.js.away'), join(plugin, 'lib', 'hooks', 'post-read.js'));
    }
  });

  // §13 DV1: a session without the plugin has no gate, and nothing in Open
  // Code says so. The doctor run from it is the one place that can.
  test('a session whose commands carry no label fails: the plugin is not running there', async () => {
    const [entry] = await checkHooks(plugin, SESSION);

    assert.equal(entry.status, 'fail');
    assert.equal(
      entry.detail,
      'this session’s commands carry no PDKIT_HOOKS: opencode-pdkit is not running here, and neither is the gate on ' +
        'writes upstream — or it runs below its minimum Open Code, with the gate alone (see plugin)',
    );
  });

  // A `!` command in the TUI names no session, but the plugin labels it.
  test('a label is read without a session too', async () => {
    const [entry] = await checkHooks(plugin, { PDKIT_HOOKS: EVENTS.join(',') });

    assert.equal(entry.detail, `${EVENTS.length} events, every one has a handler and is registered in this session`);
  });
});

// Slice verification builds in a worktree, so a root that cannot be written or
// a tree git has lost track of becomes a verification failure that looks like a
// failing slice.
// A hook that never connected looks exactly like one with nothing to catch.
// The receipt gate sat on an event subagents never raise for four months and
// every other check here was green, so this one reads what only a live hook
// writes — and only what this harness's hook writes: the journal is shared
// with the Claude Code version (D10), whose entries would otherwise keep the
// check green for a month while the hook here never ran.
describe('the agent-done liveness check', () => {
  const DAY = 24 * 60 * 60 * 1000;
  let home;

  // Open Code's form (the bridge passes the subagent's session as the run,
  // F91) and Claude Code's, as each writes them (task-completed.js).
  const OPEN_CODE = 'agent task ses_e1ab4cdafffd9uGCEIYqzzA0zh; pd-implementer; while T1 was active';
  const CLAUDE_CODE = 'agent task ac7658da6ee90e084; pd:pd-plan-critic';

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'pdkit-doctor-agents-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test('no history is a warning that says what it may mean, not a failure', async () => {
    const [entry] = await checkAgentRuns(home);

    assert.equal(entry.status, 'warn');
    assert.notEqual(entry.level, 'required');
    assert.equal(
      entry.detail,
      'no agent-done of Open Code’s in the journal for 30d. If subagents ran in Open Code in that time, the ' +
        'subagent-stop hook is not connected and the receipt gate is off; run any subagent, then ' +
        '`pdkit journal --event agent-done`',
    );
  });

  test("Claude Code's entries, however recent, still warn — and are counted aside", async () => {
    for (let n = 0; n < 3; n += 1) await appendJournal({ issue: 1, event: 'agent-done', detail: CLAUDE_CODE }, { home });
    await appendJournal({ issue: 1, event: 'agent-done', detail: 'agent task unnamed; pd-scout' }, { home });

    const [entry] = await checkAgentRuns(home, Date.now());

    assert.equal(entry.status, 'warn');
    assert.match(entry.detail, /^no agent-done of Open Code’s in the journal for 30d \(4 more not counted: Claude Code’s, or with no run ID\)\. /);
  });

  test("Open Code's, recent, are green, with the count and the latest", async () => {
    await appendJournal({ issue: 1, event: 'agent-done', detail: OPEN_CODE }, { home });
    await appendJournal({ issue: 1, event: 'agent-done', detail: 'agent task ses_e1ab4d3c7ffeYCqjow47esP8tm; pd-scout' }, { home });

    const [entry] = await checkAgentRuns(home, Date.now());

    assert.equal(entry.status, 'ok');
    assert.match(entry.detail, /^2 in the last 30d, latest \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test('beside the other harness, only its own are counted, and the rest is said', async () => {
    await appendJournal({ issue: 1, event: 'agent-done', detail: CLAUDE_CODE }, { home });
    await appendJournal({ issue: 1, event: 'agent-done', detail: OPEN_CODE }, { home });
    await appendJournal({ issue: 1, event: 'agent-done', detail: CLAUDE_CODE }, { home });

    const [entry] = await checkAgentRuns(home, Date.now());

    assert.equal(entry.status, 'ok');
    assert.match(entry.detail, /^1 in the last 30d, latest \S+; 2 more not counted: Claude Code’s, or with no run ID$/);
  });

  test('an entry of its own older than the window still warns', async () => {
    await appendJournal({ issue: 1, event: 'agent-done', detail: OPEN_CODE }, { home });

    const [entry] = await checkAgentRuns(home, Date.now() + 31 * DAY);
    assert.equal(entry.status, 'warn');
  });

  // The run's ID is the only mark, so an ID of another shape is not this
  // harness's. Open Code changing its IDs reads as a hook that does not run:
  // a warning to look, never a green check about work nobody did.
  test('a run whose ID has another shape is not counted', async () => {
    await appendJournal({ issue: 1, event: 'agent-done', detail: 'agent task session-01HZY; pd-scout' }, { home });

    assert.equal((await checkAgentRuns(home, Date.now()))[0].status, 'warn');
  });

  // T4.11 writes a receipt with the run in it: not an agent-done.
  test('a receipt that names its run is not a run', async () => {
    await appendJournal({ issue: 1, event: 'task-receipt', detail: 'T1 accepted; agent task ses_e1ab4cdafffd9uGCEIYqzzA0zh' }, { home });

    assert.equal((await checkAgentRuns(home, Date.now()))[0].status, 'warn');
  });
});

// Every hook is `node bin/pdkit hook <event>`, started inside the Open Code
// server from the server's PATH, which no shell of the session sees. The
// plugin asks that node its version and labels every command with it
// (PDKIT_HOOK_NODE); the minimum is the one `node` is held to.
describe('the node the hooks run with', () => {
  const RANGE = '>=22.13.0';

  test('outside a session there is nothing to read: skip, and where it shows', () => {
    const entry = checkHookNode(RANGE, {});

    assert.equal(entry.id, 'hooks:node');
    assert.equal(entry.level, 'required');
    assert.equal(entry.status, 'skip');
    assert.equal(entry.detail, 'shows only in a session (/pd:doctor): the hooks run on the node of the Open Code server’s PATH, which no terminal sees');
  });

  test('in a session the plugin said nothing in: skip, and why', () => {
    const entry = checkHookNode(RANGE, SESSION);

    assert.equal(entry.status, 'skip');
    assert.equal(entry.detail, 'opencode-pdkit set nothing on this session’s commands (see hooks)');
  });

  test('a node at the minimum or newer is ok, with its version', () => {
    for (const version of ['v22.13.0', 'v24.22.1', 'v25.0.0']) {
      const entry = checkHookNode(RANGE, labeled(EVENTS, { PDKIT_HOOK_NODE: version }));
      assert.equal(entry.status, 'ok', version);
      assert.equal(entry.detail, `${version} on the Open Code server’s PATH, which every hook runs with`);
    }
  });

  // F256: node 20 runs the hooks right, but below the minimum is below it —
  // the same answer `node` gives the CLI's.
  test('an older one fails, with the minimum', () => {
    for (const version of ['v20.20.0', 'v22.12.0']) {
      const entry = checkHookNode(RANGE, labeled(EVENTS, { PDKIT_HOOK_NODE: version }));
      assert.equal(entry.status, 'fail', version);
      assert.equal(entry.detail, `${version} on the Open Code server’s PATH, which every hook runs with; need >= 22.13.0`);
    }
  });

  test('none on the PATH fails: every command is refused, and what to do', () => {
    const entry = checkHookNode(RANGE, { PDKIT_HOOK_NODE: 'none: "node" is not on the PATH of the process that runs hooks (ENOENT)' });

    assert.equal(entry.status, 'fail');
    assert.equal(
      entry.detail,
      'no node the hooks can start on the Open Code server’s PATH ("node" is not on the PATH of the process that runs ' +
        'hooks (ENOENT)): every command the model runs is refused. Restart the server from a shell whose PATH has node >= 22.13.0',
    );
  });

  test('a minimum it cannot read fails, as `node` does', () => {
    const entry = checkHookNode('^22', labeled(EVENTS, { PDKIT_HOOK_NODE: 'v24.22.1' }));

    assert.equal(entry.status, 'fail');
    assert.match(entry.detail, /package\.json engines\.node is "\^22", not ">=X\.Y\.Z"$/);
  });

  // The label the plugin writes, read back by the check that reads it.
  test('reads what the plugin writes', async () => {
    const { nodeLabel } = await import('../lib/hooks/runner.js');

    assert.equal(checkHookNode(RANGE, { PDKIT_HOOK_NODE: nodeLabel({ ok: true, version: 'v24.22.1' }) }).status, 'ok');
    const none = checkHookNode(RANGE, { PDKIT_HOOK_NODE: nodeLabel({ ok: false, detail: 'it could not be asked (x)' }) });
    assert.equal(none.status, 'fail');
    assert.match(none.detail, /\(it could not be asked \(x\)\)/);
  });
});

// §13 DV1: without the plugin there is no gate, and Open Code says nothing —
// a plugin the config turns off is not failed but absent (F212, F213). The
// answers below have the shapes Open Code 2.3.0 gave (research/T7.6-raw).
describe('whether Open Code runs the plugin', () => {
  const ID = 'opencode-pdkit';
  const FORK = '/work/fork';
  const answer = (data) => ({ ok: true, data });
  const builtin = (id) => ({ id, source: { type: 'builtin' }, features: { server: true }, state: { status: 'active' } });
  /** GET /api/plugin: Open Code's own, the config's in their place, Open Code's own after. */
  const listed = (...added) => ({
    location: { directory: FORK },
    data: [builtin('opencode.tool.input.repair'), builtin('opencode.tool.shell'), ...added, builtin('opencode.config.policy')],
  });
  const LOCAL = { id: ID, source: { type: 'local', path: '/src/opencode-pdkit' }, features: { server: true }, state: { status: 'active' } };
  const PACKAGE = { id: ID, source: { type: 'package', target: 'opencode-pdkit', version: '0.16.0' }, features: { server: true, tui: true }, state: { status: 'active' } };
  /** GET /api/config: documents, by path, with what they say. */
  const documents = (...files) => [
    ...files.map(([path, info]) => ({ type: 'document', path, info })),
    { type: 'directory', path: '/home/.config/opencode', info: {} },
  ];
  const GLOBAL = '/home/.config/opencode/opencode.json';

  const run = (answers, env = {}, wait = 5000) => {
    const server = serverWith(answers);
    return checkPlugin({ id: ID, directory: FORK, env, ask: server.ask, wait, ...clock() }).then((entry) => ({ entry, asked: server.asked }));
  };

  test("from a session it runs in, the plugin's own word; the server is asked once, for a newer version only", async () => {
    const { entry, asked } = await run({ '/api/plugin': [answer(listed(LOCAL))] }, labeled());

    assert.deepEqual(entry, { id: 'plugin', level: 'required', status: 'ok', detail: 'opencode-pdkit runs in this session: it labels every command here' });
    assert.deepEqual(asked, ['/api/plugin']);
  });

  // The label is the word of the plugin that runs this very command; the
  // service `opencode api` reaches may be another server, or none.
  test('from a session, what the server says otherwise does not count against it', async () => {
    for (const reply of [{ ok: false, error: 'opencode: not found' }, answer(listed()), answer({ data: [] })]) {
      const { entry, asked } = await run({ '/api/plugin': [reply] }, labeled());
      assert.equal(entry.status, 'ok', JSON.stringify(reply));
      assert.deepEqual(asked, ['/api/plugin'], 'asked once, not waited on');
    }
  });

  // Open Code looks for a newer version when it loads the plugin and once a
  // day, marks it, and installs nothing (F220, D4).
  test('a newer version published is a warning with the command that installs it, from anywhere', async () => {
    const outdated = { ...PACKAGE, source: { ...PACKAGE.source, version: '0.16.0', outdated: true } };

    const terminal = await run({ '/api/plugin': [answer(listed(outdated))] });
    assert.equal(terminal.entry.status, 'warn');
    assert.equal(
      terminal.entry.detail,
      'opencode-pdkit is active in Open Code for /work/fork (opencode-pdkit 0.16.0); a newer version is published — update it with: opencode plugin update',
    );

    const session = await run({ '/api/plugin': [answer(listed(outdated))] }, labeled());
    assert.equal(session.entry.status, 'warn');
    assert.equal(
      session.entry.detail,
      'opencode-pdkit runs in this session: it labels every command here; a newer version is published — update it with: opencode plugin update',
    );
  });

  test('active for the directory is ok, with where it comes from', async () => {
    const local = await run({ '/api/plugin': [answer(listed(LOCAL))] });
    assert.equal(local.entry.status, 'ok');
    assert.equal(local.entry.detail, 'opencode-pdkit is active in Open Code for /work/fork (/src/opencode-pdkit)');

    const pkg = await run({ '/api/plugin': [answer(listed(PACKAGE))] });
    assert.equal(pkg.entry.detail, 'opencode-pdkit is active in Open Code for /work/fork (opencode-pdkit 0.16.0)');
    assert.deepEqual(pkg.asked, ['/api/plugin']);
  });

  // F210: the order of the list is the order of the hooks. A plugin of the
  // config after this one sees a command after the gate let it through (DV2).
  test('a plugin of the config after it is named; one before it, or Open Code’s own, is not', async () => {
    const before = { id: 'earlier', source: { type: 'package', target: 'earlier' }, state: { status: 'active' } };
    const after = { id: 'later', source: { type: 'package', target: 'later' }, state: { status: 'active' } };
    const broken = { source: { type: 'local', path: '/src/broken' }, state: { status: 'failed', error: 'Plugin failed to load', ref: 'err_1' } };
    const { entry } = await run({ '/api/plugin': [answer(listed(before, LOCAL, after, broken))] });

    assert.equal(entry.status, 'ok');
    assert.equal(
      entry.detail,
      'opencode-pdkit is active in Open Code for /work/fork (/src/opencode-pdkit); after it, later, /src/broken — whose ' +
        'hooks see a command after its gate, and can change it',
    );
  });

  test('an empty list is a directory still loading: asked again until it is not', async () => {
    const { entry, asked } = await run({ '/api/plugin': [answer({ location: { directory: FORK }, data: [] }), answer(listed(LOCAL))] });

    assert.equal(entry.status, 'ok');
    assert.deepEqual(asked, ['/api/plugin', '/api/plugin']);
  });

  test('still empty when the time is up: cannot tell, and what to do', async () => {
    const { entry } = await run({ '/api/plugin': [answer({ location: { directory: FORK }, data: [] })] });

    assert.deepEqual(entry, {
      id: 'plugin',
      level: 'required',
      status: 'skip',
      detail: 'cannot tell: Open Code listed no plugin for /work/fork within 5 s — run pdkit doctor again',
    });
  });

  test('a server that cannot be asked is "cannot tell", in its own words', async () => {
    const { entry } = await run({ '/api/plugin': [{ ok: false, error: 'opencode api GET /api/plugin: Error: Could not reach server at http://127.0.0.1:1' }] });

    assert.equal(entry.status, 'skip');
    assert.equal(entry.detail, 'cannot tell: opencode api GET /api/plugin: Error: Could not reach server at http://127.0.0.1:1');
  });

  // A plugin that failed to load has no ID in the list: it is known by where
  // it comes from.
  test('failed to load: fail, with the error and where the log has it', async () => {
    const failed = { source: { type: 'package', target: 'opencode-pdkit' }, features: { server: true }, state: { status: 'failed', error: 'Plugin failed to load', ref: 'err_a81b3f27' } };
    const other = { source: { type: 'local', path: '/src/broken' }, state: { status: 'failed', error: 'Plugin failed to load', ref: 'err_2' } };
    const { entry, asked } = await run({ '/api/plugin': [answer(listed(other, failed))] });

    assert.equal(entry.status, 'fail');
    assert.equal(
      entry.detail,
      'Open Code failed to load opencode-pdkit for /work/fork — no plugin, no gate on writes upstream: opencode-pdkit: ' +
        'Plugin failed to load (err_a81b3f27 in the server’s log)',
    );
    assert.deepEqual(asked, ['/api/plugin']);
  });

  test('another plugin that failed is not this one', async () => {
    const other = { source: { type: 'local', path: '/src/broken' }, state: { status: 'failed', error: 'Plugin failed to load', ref: 'err_2' } };
    const { entry } = await run({
      '/api/plugin': [answer(listed(other))],
      '/api/config': [answer(documents([GLOBAL, { plugins: ['/src/broken'] }]))],
    });

    assert.equal(entry.status, 'fail');
    assert.match(entry.detail, /^Open Code does not load opencode-pdkit for \/work\/fork — no plugin, no gate on writes upstream: no config document it reads names opencode-pdkit\. Add it with: opencode plugin add opencode-pdkit$/);
  });

  test('removed by a directive: fail, naming the document', async () => {
    const { entry, asked } = await run({
      '/api/plugin': [answer(listed())],
      '/api/config': [answer(documents([GLOBAL, { plugins: ['/src/opencode-pdkit'] }], ['/work/fork/opencode.json', { plugins: ['-opencode-pdkit'] }]))],
    });

    assert.equal(entry.status, 'fail');
    assert.equal(
      entry.detail,
      'Open Code does not load opencode-pdkit for /work/fork — no plugin, no gate on writes upstream: "-opencode-pdkit" in ' +
        'the plugins of /work/fork/opencode.json',
    );
    assert.deepEqual(asked, ['/api/plugin', '/api/config']);
  });

  test('kept from loading by a policy on its path: fail, naming the policy and its document', async () => {
    const { entry } = await run({
      '/api/plugin': [answer(listed())],
      '/api/config': [answer(documents([GLOBAL, { plugins: ['/src/opencode-pdkit'], policies: [{ action: 'plugin.use', resource: '/src/*', effect: 'deny' }] }]))],
    });

    assert.equal(entry.status, 'fail');
    assert.match(entry.detail, /: a plugin\.use policy in \/home\/\.config\/opencode\/opencode\.json denies \/src\/opencode-pdkit \(\/src\/\*\)$/);
  });

  // Open Code checks a package without its version, and a relative path from
  // the document it is in (F212, src/plugin/module.ts).
  test('a policy is matched as Open Code matches it', async () => {
    const pkg = await run({
      '/api/plugin': [answer(listed())],
      '/api/config': [answer(documents([GLOBAL, { plugins: ['opencode-pdkit@0.16.0'], policies: [{ action: 'plugin.use', resource: 'opencode-pdkit', effect: 'deny' }] }]))],
    });
    assert.match(pkg.entry.detail, /denies opencode-pdkit@0\.16\.0 \(opencode-pdkit\)$/);

    const relative = await run({
      '/api/plugin': [answer(listed())],
      '/api/config': [answer(documents(['/work/fork/opencode.json', { plugins: ['../opencode-pdkit'], policies: [{ action: 'plugin.use', resource: '/work/opencode-pdkit', effect: 'deny' }] }]))],
    });
    assert.match(relative.entry.detail, /denies \.\.\/opencode-pdkit \(\/work\/opencode-pdkit\)$/);
  });

  // Measured: a policy on the package's name does not stop the same plugin
  // added by its path (research/T7.6-raw, policy-name).
  test('a policy on the name does not stop a path, nor an allow after a deny in the same document', async () => {
    const byName = await run({
      '/api/plugin': [answer(listed())],
      '/api/config': [answer(documents([GLOBAL, { plugins: ['/src/opencode-pdkit'], policies: [{ action: 'plugin.use', resource: 'opencode-pdkit', effect: 'deny' }] }]))],
    });
    assert.match(byName.entry.detail, /: \/src\/opencode-pdkit in the plugins of \/home\/\.config\/opencode\/opencode\.json, and nothing there turns it off — /);

    const allowed = await run({
      '/api/plugin': [answer(listed())],
      '/api/config': [
        answer(
          documents([
            GLOBAL,
            {
              plugins: ['/src/opencode-pdkit'],
              policies: [
                { action: 'plugin.use', resource: '*', effect: 'deny' },
                { action: 'plugin.use', resource: '/src/opencode-pdkit', effect: 'allow' },
              ],
            },
          ]),
        ),
      ],
    });
    assert.doesNotMatch(allowed.entry.detail, /policy/);
  });

  // Open Code reads every document's policies, the earliest document's last.
  test("across documents, the earliest document's policy is the one that holds", async () => {
    const { entry } = await run({
      '/api/plugin': [answer(listed())],
      '/api/config': [
        answer(
          documents(
            [GLOBAL, { plugins: ['/src/opencode-pdkit'], policies: [{ action: 'plugin.use', resource: '/src/opencode-pdkit', effect: 'deny' }] }],
            ['/work/fork/opencode.json', { policies: [{ action: 'plugin.use', resource: '*', effect: 'allow' }] }],
          ),
        ),
      ],
    });

    assert.match(entry.detail, /a plugin\.use policy in \/home\/\.config\/opencode\/opencode\.json denies/);
  });

  test('named nowhere: fail, with the command that adds it', async () => {
    const { entry } = await run({
      '/api/plugin': [answer(listed())],
      '/api/config': [answer(documents([GLOBAL, { plugins: [] }]))],
    });

    assert.equal(
      entry.detail,
      'Open Code does not load opencode-pdkit for /work/fork — no plugin, no gate on writes upstream: no config document ' +
        'it reads names opencode-pdkit. Add it with: opencode plugin add opencode-pdkit',
    );
  });

  test('when the config cannot be read either, the absence is still a failure', async () => {
    const { entry } = await run({ '/api/plugin': [answer(listed())], '/api/config': [{ ok: false, error: 'HTTP 500' }] });

    assert.equal(entry.status, 'fail');
    assert.equal(
      entry.detail,
      'Open Code does not load opencode-pdkit for /work/fork — no plugin, no gate on writes upstream; its config could not be read (HTTP 500)',
    );
  });

  // In a session where the plugin is not running, its word is missing: the
  // server is asked, as from a terminal.
  test('a session without its label asks the server', async () => {
    const { entry, asked } = await run({ '/api/plugin': [answer(listed())], '/api/config': [answer(documents([GLOBAL, { plugins: ['/src/opencode-pdkit', '-opencode-pdkit'] }]))] }, SESSION);

    assert.equal(entry.status, 'fail');
    assert.deepEqual(asked, ['/api/plugin', '/api/config']);
  });

  test('a status it does not know is "cannot tell"', async () => {
    const { entry } = await run({ '/api/plugin': [answer(listed({ ...LOCAL, state: { status: 'loading' } }))] });

    assert.deepEqual(entry, { id: 'plugin', level: 'required', status: 'skip', detail: 'cannot tell: Open Code reports opencode-pdkit loading' });
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
// one now — a /pd: command that has a model switches the session to it — so
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
