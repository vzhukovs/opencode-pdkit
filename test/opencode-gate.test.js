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

// The push gate in Open Code, end to end short of the host: the entry point's
// execute.before callback, as a stand-in for the context Open Code passes to
// setup() registers it, on events shaped as Open Code sends them. Behind it is
// everything real — the bridge, the runner, a node process running bin/pdkit,
// dispatch.js and the rules — in a clone of podman-desktop, against a
// throwaway $PDKIT_HOME.
//
// A refusal is a throw from the callback, and its message is what the model
// gets as the call's error. So each rule of docs/specification/06-hooks.md for
// pre-bash is asserted as a rejection with the rule's own words, and ordinary
// work as a callback that resolves. Then the other half, which no session
// would show until it went wrong: every way of getting no answer refuses, in
// words that say what to fix.

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import plugin from '../opencode/server.js';
import { refusal } from '../lib/hooks/runner.js';
import * as gate from '../lib/gate.js';
import * as journal from '../lib/journal.js';
import { BRANCH, otherRepository, podmanDesktopClone, readyIssue } from './helpers/gate-fixture.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const POSIX = process.platform !== 'win32';

/** The advice a refusal for want of an answer ends with. */
const ADVICE = refusal('pre-bash', 'x').slice('pdkit: hook "pre-bash" x. '.length);

let home;
let repo;
let other;
let previousHome;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-gate-home-'));
  // The child process takes $PDKIT_HOME from the server's environment, as it
  // would in a session; here the server is this process.
  previousHome = process.env.PDKIT_HOME;
  process.env.PDKIT_HOME = home;
  repo = await podmanDesktopClone('pdkit-gate-repo-');
  other = await otherRepository('pdkit-gate-other-');
  await readyIssue(2001, { home });
  await readyIssue(2002, { home, prOpen: true });
});

beforeEach(async () => {
  await gate.revokeAll({ home });
});

after(async () => {
  if (previousHome === undefined) delete process.env.PDKIT_HOME;
  else process.env.PDKIT_HOME = previousHome;
  for (const dir of [home, repo, other]) await rm(dir, { recursive: true, force: true });
});

/**
 * A stand-in for setup()'s context, in a directory: just enough for the
 * entry point to load in full, keeping the gate's callback.
 */
function host(directory = repo) {
  let callback;
  const registered = { dispose: async () => {} };
  const hooks = { hook: async (name, cb) => ((callback ??= name === 'execute.before' ? cb : undefined), registered) };
  const transforms = { transform: async () => registered };
  const ctx = {
    app: { name: 'cli', version: '2.3.0', channel: 'latest' },
    location: { directory, project: { id: 'global', directory, canonical: directory } },
    tool: hooks,
    session: { hook: async () => registered },
    event: { subscribe: async function* () {} },
    shell: { hook: async () => registered },
    permission: { hook: async () => registered },
    agent: transforms,
    command: transforms,
    skill: transforms,
  };
  return { ctx, gate: (event) => callback(event) };
}

/** execute.before's event for a call. */
const call = (input, tool = 'shell') => ({ tool, sessionID: 'ses_gate', agent: 'build', messageID: 'msg_gate', id: 'call_gate', input });
const shell = (command, fields = {}) => call({ command, ...fields });

/** What setup() and the gate write to the server's stderr. */
function logOf(t) {
  const error = t.mock.method(console, 'error', () => {});
  return () => error.mock.calls.map((entry) => entry.arguments.join(' '));
}

/** The gate of the plugin in this checkout, loaded in `directory`. */
async function loaded(t, directory) {
  const log = logOf(t);
  const { ctx, gate: check } = host(directory);
  await plugin.setup(ctx);
  return { check, log };
}

/** A refusal, by the words it must contain. */
const refuses = (pattern) => (error) => {
  assert.match(error.message, pattern);
  return true;
};

describe('the rules of 06-hooks.md for pre-bash', () => {
  test('git push and gh pr create: refused without a push token for the branch', async (t) => {
    const { check } = await loaded(t);

    await assert.rejects(check(shell('git push')), refuses(/^pdkit: No consent token for this branch\.[\s\S]*no consent token for push DESKTOP-2001\/fix-the-thing\n  command: git push$/));
    await assert.rejects(check(shell('gh pr create --base main --head DESKTOP-2001/other --title x')), refuses(/no consent token for push DESKTOP-2001\/other/));
  });

  test('git push: allowed with the token, which it spends', async (t) => {
    const { check } = await loaded(t);
    await gate.open({ issue: 2001, branch: BRANCH, home });

    await check(shell('git push'));
    await assert.rejects(check(shell('git push')), refuses(/already pushed/));
  });

  test('a write to a pull request: refused without a reply token for it, allowed with one', async (t) => {
    const { check } = await loaded(t);

    await assert.rejects(check(shell('gh pr comment 17577 --body x')), refuses(/no consent token for reply #17577/));
    await gate.open({ issue: 2002, pr: 17577, kind: 'reply', home });
    await check(shell('gh pr comment 17577 --body x'));
    await check(shell('gh pr comment 17577 --body y'));
  });

  test('a write to the tracker: refused whatever token exists', async (t) => {
    const { check } = await loaded(t);
    await gate.open({ issue: 2002, pr: 17577, kind: 'reply', home });

    await assert.rejects(check(shell('gh issue comment 17221 --body x')), refuses(/human action/));
    await assert.rejects(check(shell('gh issue create --title x')), refuses(/someone else’s tracker/));
  });

  test('a force push without a lease: refused even with a token', async (t) => {
    const { check } = await loaded(t);
    await gate.open({ issue: 2001, branch: BRANCH, home });

    await assert.rejects(check(shell(`git push --force origin ${BRANCH}`)), refuses(/--force is never allowed/));
  });

  test('git add -A and git add .: refused, with the paths to list instead', async (t) => {
    const { check } = await loaded(t);

    await assert.rejects(check(shell('git add -A')), refuses(/List the paths explicitly/));
    await assert.rejects(check(shell('git add .')), refuses(/List the paths explicitly/));
  });

  test('git rebase -i: refused, with git reset --soft instead', async (t) => {
    const { check } = await loaded(t);

    await assert.rejects(check(shell('git rebase -i main')), refuses(/git reset --soft <base>/));
  });

  test('git commit --no-verify: refused', async (t) => {
    const { check } = await loaded(t);

    await assert.rejects(check(shell('git commit --no-verify -m x')), refuses(/--no-verify skips the hooks/));
  });

  test('ordinary work runs', async (t) => {
    const { check, log } = await loaded(t);

    for (const command of ['git status', 'pnpm test:unit', 'gh pr view 12', 'git commit -m x']) await check(shell(command));
    assert.deepEqual(log(), []);
  });

  test('a refusal is written to the journal, with the rule and the command', async (t) => {
    const { check } = await loaded(t);
    const before = (await journal.read({ event: 'denied' }, { home })).length;

    await assert.rejects(check(shell('git push origin main')));

    const entries = await journal.read({ event: 'denied' }, { home });
    assert.equal(entries.length, before + 1);
    assert.match(entries.at(-1).detail, /^push: git push origin main/);
  });

  test('outside podman-desktop a gated command runs, and says why where the bridge writes', async (t) => {
    const { check, log } = await loaded(t, other);

    await check(shell('git push origin main'));

    // Claude Code wrote it to its debug log: a PreToolUse message reached
    // neither the model nor the person there either.
    assert.equal(log().length, 1);
    assert.match(
      log()[0],
      /^opencode-pdkit: pre-bash message, which reaches no one here: pdkit: the gate guards podman-desktop, and this is not it — .*someone\/podman-desktop-kit/,
    );
  });
});

describe('where the command runs', () => {
  test("the shell tool's workdir, not the session's directory", async (t) => {
    const { check } = await loaded(t, repo);

    await check(shell('git push origin main', { workdir: other }));
    await assert.rejects(check(shell('git push origin main')), refuses(/no consent token/));
  });

  test("a relative workdir from the session's directory", async (t) => {
    const parent = join(other, '..');
    const { check } = await loaded(t, parent);

    await check(shell('git push origin main', { workdir: relative(parent, other) }));
    await assert.rejects(check(shell('git push origin main', { workdir: relative(parent, repo) })), refuses(/no consent token/));
  });

  test('a workdir that does not exist is refused, and says so', async (t) => {
    const { check } = await loaded(t, other);

    await assert.rejects(
      check(shell('git push origin main', { workdir: join(other, 'missing') })),
      refuses(/^pdkit: hook "pre-bash" cannot run: its working directory does not exist: .*missing\. This hook guards writes/),
    );
  });
});

// Decided with T4.5 (§13 DV5): Claude Code's gate matched its Bash tool; here
// it reads every call that carries a command.
describe('which calls the gate reads', () => {
  test('any tool that carries a command, not only shell', async (t) => {
    const { check } = await loaded(t);

    await assert.rejects(check(call({ command: 'git push' }, 'terminal_run')), refuses(/no consent token/));
    await assert.rejects(check(call({ command: 'git push' }, 'bash')), refuses(/no consent token/));
    await check(call({ command: 'git status' }, 'terminal_run'));
  });

  // Shown on a plugin that refuses every call it reads, whatever the command:
  // what still runs there was never read.
  test('a call without a command string is not the gate’s: it is not read at all', async (t) => {
    const { check } = await broken(t, { 'lib/hooks/runner.js': null });

    await check(call({ path: 'a.txt', content: 'git push' }, 'write'));
    await check(call({ command: ['git', 'push'] }, 'terminal_run'));
    await check(call(undefined, 'todo'));
    await assert.rejects(check(shell('git status')), refuses(/plugin failed to load/));
  });
});

/**
 * A copy of the plugin with some files replaced, loaded in the clone.
 *
 * @param {import('node:test').TestContext} t
 * @param {Record<string, string|((text: string) => string)|null>} files
 */
async function broken(t, files) {
  const dir = await mkdtemp(join(tmpdir(), 'pdkit-gate-plugin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const entry of ['opencode', 'lib', 'bin', 'defaults', 'agents', 'skills', 'package.json']) {
    await cp(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  for (const [path, change] of Object.entries(files)) {
    const file = join(dir, path);
    if (change === null) await rm(file);
    else await writeFile(file, typeof change === 'function' ? change(await readFile(file, 'utf8')) : change);
  }
  const copy = (await import(pathToFileURL(join(dir, 'opencode', 'server.js')).href)).default;
  const log = logOf(t);
  const { ctx, gate: check } = host(repo);
  await copy.setup(ctx);
  return { check, log };
}

/** A refusal for want of an answer: the problem, then runHook's advice. */
const undecided = (problem) => (error) => {
  assert.match(error.message, new RegExp(`^pdkit: hook "pre-bash" ${problem}`));
  assert.ok(error.message.endsWith(ADVICE), `the advice is not runHook's:\n${error.message}`);
  return true;
};

describe('no answer is a refusal', () => {
  test('no node on the PATH of the server', { skip: !POSIX && 'T10.10' }, async (t) => {
    const { check } = await loaded(t);
    const path = process.env.PATH;
    process.env.PATH = home;
    t.after(() => (process.env.PATH = path));

    await assert.rejects(
      check(shell('git status')),
      undecided('cannot run: "node" was not found on the PATH of the process that runs hooks \\(ENOENT\\); pdkit\'s hooks need Node\\.js 22 or later there'),
    );
  });

  test('a CLI that does not load: exit 1', async (t) => {
    const { check } = await broken(t, { 'lib/cli.js': 'this is not valid javascript {{{\n' });

    await assert.rejects(check(shell('git status')), undecided('exited with code 1 \\(SyntaxError: .*; Node\\.js v\\d+'));
  });

  test('a handler that does not load: runHook refuses, as under Claude Code', async (t) => {
    const { check } = await broken(t, { 'lib/hooks/dispatch.js': 'this is not valid javascript {{{\n' });

    await assert.rejects(check(shell('git status')), undecided('handler "dispatch\\.js" is unavailable'));
  });

  test('a handler that throws: runHook refuses, as under Claude Code', async (t) => {
    const { check } = await broken(t, { 'lib/hooks/dispatch.js': "export async function handle() { throw new Error('the gate broke'); }\n" });

    await assert.rejects(check(shell('git status')), undecided('failed \\(the gate broke\\)'));
  });

  test('a handler that hangs: stopped at the deadline', async (t) => {
    const { check } = await broken(t, {
      'lib/hooks/dispatch.js': 'export function handle() { return new Promise(() => setInterval(() => {}, 1000)); }\n',
      'lib/hooks/runner.js': (text) => text.replace('export const DEADLINE_MS = 10_000;', 'export const DEADLINE_MS = 500;'),
    });

    await assert.rejects(check(shell('git status')), undecided('gave no answer within 0\\.5s and was stopped'));
  });

  test('a bridge that fails before the runner is reached', async (t) => {
    const { ctx, gate: check } = host(repo);
    logOf(t);
    Object.defineProperty(ctx, 'location', {
      get() {
        throw new Error('no location today');
      },
    });
    await plugin.setup(ctx);

    await assert.rejects(check(shell('git status')), undecided('failed in the hook bridge \\(no location today\\)'));
  });

  // The entry point's own text, for when the bridge or the runner is what
  // failed to load: the same advice, written there because the module it would
  // come from may be the one missing.
  test('a runner that does not load: the entry point refuses, with the same advice', async (t) => {
    const { check, log } = await broken(t, { 'lib/hooks/runner.js': null });

    await assert.rejects(check(shell('git status')), undecided('cannot run: the opencode-pdkit plugin failed to load'));
    assert.match(log()[0], /failed to load .*every command is refused/);
  });

  test('nothing about a refusal goes to the log: the model and the person have it', async (t) => {
    const { check, log } = await loaded(t);

    await assert.rejects(check(shell('git push')));
    assert.deepEqual(log(), []);
  });
});
