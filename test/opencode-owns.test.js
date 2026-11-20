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

// The ownership check in Open Code, end to end short of the host: the
// execute.before callbacks a stand-in for setup()'s context collects, run in
// the order Open Code runs them, on calls of write, edit and patch shaped as
// Open Code sends them. Behind them is everything real — the bridge, the
// runner, a node process running bin/pdkit, owns.js — in a git repository with
// a task running in it, against a throwaway $PDKIT_HOME.
//
// A refusal is a throw, whose message the model gets as the call's error. So
// each rule of docs/specification/06-hooks.md for pre-write is asserted for
// each of the three tools that write here — which one a model gets depends on
// the model (F39) — and the patch tool once more for what only it can do:
// change several files in one call, delete one, move one. Then the other half:
// pre-write fails open, so every way of getting no answer lets the write
// through and says why in the log, and nothing it does reaches the gate.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import plugin from '../opencode/server.js';
import { start, stop } from '../lib/active.js';
import * as journal from '../lib/journal.js';
import { setOwns, withdrawTask } from '../lib/state.js';
import { logOf } from './helpers/server-log.js';

const execFileAsync = promisify(execFile);

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const ISSUE = 3001;
const OWNED = 'packages/main/src/plugin/container-registry.ts';
const OWNS = [OWNED, 'packages/main/src/**/*.spec.ts'];
const NOT_OWNED = 'packages/renderer/src/App.svelte';

let home;
let repo;
let outside;
let previousHome;

before(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-owns-bridge-home-')));
  // The child process takes $PDKIT_HOME from the server's environment, as it
  // would in a session; here the server is this process.
  previousHome = process.env.PDKIT_HOME;
  process.env.PDKIT_HOME = home;
  // The real path, as git reports it (owns.test.js says why).
  repo = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-owns-bridge-repo-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-owns-bridge-out-')));

  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await mkdir(join(repo, 'packages/main/src/plugin'), { recursive: true });
  await mkdir(join(repo, 'packages/renderer/src'), { recursive: true });

  await setOwns(ISSUE, 'T1', OWNS, { home });
  await setOwns(ISSUE, 'T8', [], { home });
  await setOwns(ISSUE, 'T2', [OWNED], { home });
  await withdrawTask(ISSUE, { task: 'T2', amendment: 'A1', replacedBy: ['T5'], home });
});

after(async () => {
  if (previousHome === undefined) delete process.env.PDKIT_HOME;
  else process.env.PDKIT_HOME = previousHome;
  for (const dir of [home, repo, outside]) await rm(dir, { recursive: true, force: true });
});

/**
 * A stand-in for setup()'s context, in a directory: just enough for the entry
 * point to load in full. `check` runs every execute.before callback in the
 * order they were registered, as Open Code does, and stops at the first that
 * throws.
 */
function host(directory = repo) {
  const before = [];
  const registered = { dispose: async () => {} };
  const hooks = {
    hook: async (name, callback) => {
      if (name === 'execute.before') before.push(callback);
      return registered;
    },
  };
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
  return {
    ctx,
    check: async (event) => {
      for (const callback of before) await callback(event);
    },
  };
}

/** execute.before's event for a call. */
const call = (tool, input) => ({ tool, sessionID: 'ses_owns', agent: 'build', messageID: 'msg_owns', id: 'call_owns', input });
const patchOf = (...lines) => call('patch', { patchText: ['*** Begin Patch', ...lines, '*** End Patch', ''].join('\n') });

/** A call of each write tool on one file, as a model would make it. */
const TOOLS = {
  write: (path) => call('write', { path, content: 'export {};\n' }),
  edit: (path) => call('edit', { path, oldString: 'a', newString: 'b' }),
  patch: (path) => patchOf(`*** Update File: ${path}`, '@@', '-a', '+b'),
};

/** The write checks of the plugin in this checkout, loaded in `directory`. */
async function loaded(t, directory) {
  const log = logOf(t);
  const { ctx, check } = host(directory);
  await plugin.setup(ctx);
  return { check, log };
}

/** A refusal, by the words it must contain. */
const refuses = (pattern) => (error) => {
  assert.match(error.message, pattern);
  return true;
};

/** Run `body` with a task running in the repository. */
function withTask(taskId, issue = ISSUE) {
  before(async () => {
    await start({ issue, taskId, worktree: repo, home });
  });
  after(async () => {
    await stop({ worktree: repo, home });
  });
}

describe('the rules of 06-hooks.md for pre-write, for each tool that writes', () => {
  describe('a path outside the active task’s Owns: refused', () => {
    withTask('T1');

    for (const [tool, of] of Object.entries(TOOLS)) {
      test(`${tool}: a file the task does not own is refused, with what it owns`, async (t) => {
        const { check, log } = await loaded(t);

        await assert.rejects(check(of(NOT_OWNED)), refuses(/^pdkit: packages\/renderer\/src\/App\.svelte is not owned by T1 \(issue 3001\)\.\n  T1 owns:\n    packages\/main\/src\/plugin\/container-registry\.ts\n[\s\S]*planning error/));
        assert.deepEqual(log(), []);
      });

      test(`${tool}: a file it owns, by name or by pattern, is allowed`, async (t) => {
        const { check, log } = await loaded(t);

        await check(of(OWNED));
        await check(of('packages/main/src/plugin/registry.spec.ts'));
        assert.deepEqual(log(), []);
      });

      test(`${tool}: a file outside the working tree is not the task’s business`, async (t) => {
        const { check } = await loaded(t);

        await check(of(join(outside, 'notes.md')));
      });
    }

    test('a refusal is written to the journal, with the task and the file', async (t) => {
      const { check } = await loaded(t);
      const before = (await journal.read({ event: 'denied' }, { home })).length;

      await assert.rejects(check(TOOLS.edit(NOT_OWNED)));

      const entries = await journal.read({ event: 'denied' }, { home });
      assert.equal(entries.length, before + 1);
      assert.equal(entries.at(-1).detail, `owns: T1 may not write ${NOT_OWNED}`);
    });
  });

  describe('Owns recorded and empty: every path in the tree refused', () => {
    withTask('T8');

    for (const [tool, of] of Object.entries(TOOLS)) {
      test(tool, async (t) => {
        const { check } = await loaded(t);

        await assert.rejects(check(of(OWNED)), refuses(/^pdkit: T8 of issue 3001 owns no files — the plan has it as a verification/));
        await check(of(join(outside, 'notes.md')));
      });
    }
  });

  // Claude Code sent the message to its debug log (a PreToolUse hook's stdout
  // on exit 0): neither the model nor the person saw it. Here it goes to the
  // server's stderr, where the bridge writes what reaches no one.
  describe('no Owns recorded for the active task: allowed, and the message goes to the log', () => {
    withTask('T9', 4242);

    for (const [tool, of] of Object.entries(TOOLS)) {
      test(tool, async (t) => {
        const { check, log } = await loaded(t);

        await check(of(NOT_OWNED));
        assert.deepEqual(log(), [
          'opencode-pdkit: pre-write message, which reaches no one here: pdkit: T9 of issue 4242 has no recorded Owns set, so writes are not ' +
            'constrained. Run `pdkit task sync --issue 4242` to read it from the task files.',
        ]);
      });
    }

    test('once for a patch, however many files it changes', async (t) => {
      const { check, log } = await loaded(t);

      await check(patchOf(`*** Add File: ${NOT_OWNED}`, '+x', `*** Delete File: ${OWNED}`));
      assert.equal(log().length, 1);
    });
  });

  describe('no active task in this working tree: allowed', () => {
    for (const [tool, of] of Object.entries(TOOLS)) {
      test(tool, async (t) => {
        const { check, log } = await loaded(t);

        await check(of(NOT_OWNED));
        assert.deepEqual(log(), []);
      });
    }
  });

  // Not in the table: owns.js's own rule (HK-31).
  describe('a task an amendment withdrew: every path in the tree refused', () => {
    withTask('T2');

    for (const [tool, of] of Object.entries(TOOLS)) {
      test(tool, async (t) => {
        const { check } = await loaded(t);

        await assert.rejects(check(of(OWNED)), refuses(/T2 of issue 3001 was withdrawn by A1[\s\S]*--task T5/));
      });
    }
  });
});

// Decided with T4.6: every file a patch changes is checked, a deleted one and
// both ends of a move included; one outside Owns refuses the whole call, since
// the tool applies a patch whole or not at all.
describe('patch: every file it changes', () => {
  withTask('T1');

  test('one file outside Owns among owned ones refuses the whole call, and names only that file', async (t) => {
    const { check } = await loaded(t);

    await assert.rejects(
      check(patchOf(`*** Update File: ${OWNED}`, '@@', '-a', '+b', `*** Add File: ${NOT_OWNED}`, '+x', '*** Add File: packages/main/src/a.spec.ts', '+x')),
      (error) => {
        assert.match(error.message, /^pdkit: packages\/renderer\/src\/App\.svelte is not owned by T1/);
        assert.doesNotMatch(error.message, /container-registry\.ts is not owned|a\.spec\.ts is not owned/);
        return true;
      },
    );
  });

  test('every file outside Owns is named, each once', async (t) => {
    const { check } = await loaded(t);

    await assert.rejects(check(patchOf(`*** Add File: ${NOT_OWNED}`, '+x', '*** Delete File: README.md', `*** Update File: ${NOT_OWNED}`, '@@', '-a', '+b')), (error) => {
      assert.equal(error.message.match(/is not owned by T1/g).length, 2);
      assert.match(error.message, /^pdkit: packages\/renderer\/src\/App\.svelte is not owned[\s\S]*\n\npdkit: README\.md is not owned by T1/);
      return true;
    });
  });

  test('all files owned: allowed', async (t) => {
    const { check } = await loaded(t);

    await check(
      patchOf(
        `*** Update File: ${OWNED}`,
        '@@',
        '-a',
        '+b',
        '*** Add File: packages/main/src/b.spec.ts',
        '+x',
        '*** Delete File: packages/main/src/c.spec.ts',
        '*** Update File: packages/main/src/d.spec.ts',
        '*** Move to: packages/main/src/e.spec.ts',
        '-a',
        '+b',
      ),
    );
  });

  test('a deleted file outside Owns is refused', async (t) => {
    const { check } = await loaded(t);

    await assert.rejects(check(patchOf(`*** Delete File: ${NOT_OWNED}`)), refuses(/App\.svelte is not owned by T1/));
  });

  test('a move is refused when either end is outside Owns', async (t) => {
    const { check } = await loaded(t);

    await assert.rejects(check(patchOf(`*** Update File: ${OWNED}`, `*** Move to: ${NOT_OWNED}`, '-a', '+b')), refuses(/App\.svelte is not owned by T1/));
    await assert.rejects(check(patchOf(`*** Update File: ${NOT_OWNED}`, `*** Move to: ${OWNED}`, '-a', '+b')), refuses(/App\.svelte is not owned by T1/));
  });

  // The tool refuses it before writing anything.
  test('a patch the tool cannot read is let through to the tool, without a word', async (t) => {
    const { check, log } = await loaded(t);

    await check(patchOf(`*** Delete File: ${NOT_OWNED}`, '-body'));
    await check(call('patch', { patchText: `*** Add File: ${NOT_OWNED}\n+x` }));
    assert.deepEqual(log(), []);
  });

  test('a line that only looks like a file is not one', async (t) => {
    const { check } = await loaded(t);

    await check(patchOf(`*** Update File: ${OWNED}`, '@@', ` *** Add File: ${NOT_OWNED}`, '-a', '+b'));
  });
});

// The path is the model's, as it wrote it; the tool takes it from the session's
// directory, and so must the check — not from the server's, which for the
// background service is the home directory, and not from the project root.
describe('which file a path names', () => {
  withTask('T1');

  test("a relative path from the session's directory, not the server's", async (t) => {
    const { check } = await loaded(t, join(repo, 'packages/main'));

    await check(TOOLS.write('src/plugin/container-registry.ts'));
    await assert.rejects(check(TOOLS.write('../renderer/src/App.svelte')), refuses(/packages\/renderer\/src\/App\.svelte is not owned/));
    await assert.rejects(check(patchOf('*** Delete File: ../renderer/src/App.svelte')), refuses(/packages\/renderer\/src\/App\.svelte is not owned/));
  });

  test('a whole path, from any session', async (t) => {
    const { check } = await loaded(t, outside);

    await assert.rejects(check(TOOLS.edit(join(repo, NOT_OWNED))), refuses(/App\.svelte is not owned/));
    await check(TOOLS.edit(join(repo, OWNED)));
  });

  // Open Code takes `~` from its own home directory, which a test may move.
  test('a path from ~, as Open Code expands it', async (t) => {
    const previous = process.env.OPENCODE_TEST_HOME;
    process.env.OPENCODE_TEST_HOME = dirname(repo);
    t.after(() => {
      if (previous === undefined) delete process.env.OPENCODE_TEST_HOME;
      else process.env.OPENCODE_TEST_HOME = previous;
    });
    const { check } = await loaded(t, outside);

    await assert.rejects(check(TOOLS.write(`~/${basename(repo)}/${NOT_OWNED}`)), refuses(/App\.svelte is not owned/));
    await assert.rejects(check(patchOf(`*** Add File: ~/${basename(repo)}/${NOT_OWNED}`, '+x')), refuses(/App\.svelte is not owned/));
  });
});

// The two callbacks share execute.before. Each reads only its own calls, and
// pre-write being there changes nothing about the gate.
describe('beside the gate', () => {
  withTask('T1');

  test('a write is not the gate’s, and a command is not pre-write’s', async (t) => {
    const { check, log } = await loaded(t);

    await check(call('shell', { command: 'git status', path: NOT_OWNED }));
    // Outside any repository nothing proves the directory is not
    // podman-desktop, so the gate refuses there (lib/hooks/scope.js).
    await assert.rejects(check(call('shell', { command: 'git add -A', workdir: tmpdir() })), refuses(/List the paths explicitly/));
    for (const tool of ['read', 'experimental_image_generate', 'worktree_remove']) await check(call(tool, { path: NOT_OWNED }));
    assert.deepEqual(log(), []);
  });
});

/**
 * A copy of the plugin with some files replaced, loaded in the repository.
 *
 * @param {import('node:test').TestContext} t
 * @param {Record<string, string|((text: string) => string)|null>} files
 */
async function broken(t, files) {
  const dir = await mkdtemp(join(tmpdir(), 'pdkit-owns-bridge-plugin-'));
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
  const log = logOf(t, { watch: false });
  const { ctx, check } = host(repo);
  await copy.setup(ctx);
  return { check, log };
}

/** The one line a write let through for want of an answer leaves in the log. */
const allowing = (log, problem) => {
  assert.equal(log().length, 1, log().join('\n'));
  assert.match(log()[0], new RegExp(`^opencode-pdkit: pdkit: hook "pre-write" ${problem}.*; allowing$`, 's'));
};

// pre-write fails open (FAIL_CLOSED names pre-bash alone): a check that could
// not be made does not stop the work. Each case is a write a working check
// refuses, so a pass is the failure's doing.
describe('no answer is a pass that says why', () => {
  withTask('T1');

  test('no node on the PATH of the server', async (t) => {
    const { check, log } = await loaded(t);
    const path = process.env.PATH;
    process.env.PATH = home;
    t.after(() => (process.env.PATH = path));

    await check(patchOf(`*** Add File: ${NOT_OWNED}`, '+x', '*** Delete File: README.md'));
    allowing(log, 'cannot run: "node" was not found on the PATH of the process that runs hooks \\(ENOENT\\)');
  });

  test("a session directory that does not exist", async (t) => {
    const { check, log } = await loaded(t, join(repo, 'missing'));

    await check(TOOLS.write(join(repo, NOT_OWNED)));
    allowing(log, 'cannot run: its working directory does not exist: ');
  });

  test('a CLI that does not load: exit 1', async (t) => {
    const { check, log } = await broken(t, { 'lib/cli.js': 'this is not valid javascript {{{\n' });

    await check(TOOLS.write(NOT_OWNED));
    allowing(log, 'exited with code 1 \\(SyntaxError: ');
  });

  test('a handler that does not load: runHook allows, as under Claude Code', async (t) => {
    const { check, log } = await broken(t, { 'lib/hooks/owns.js': 'this is not valid javascript {{{\n' });

    await check(TOOLS.edit(NOT_OWNED));
    allowing(log, 'handler "owns\\.js" is unavailable');
  });

  test('a handler that throws: runHook allows, as under Claude Code', async (t) => {
    const { check, log } = await broken(t, { 'lib/hooks/owns.js': "export async function handle() { throw new Error('ownership broke'); }\n" });

    await check(TOOLS.edit(NOT_OWNED));
    allowing(log, 'failed \\(ownership broke\\)');
  });

  test('a handler that hangs: stopped at the deadline', async (t) => {
    const { check, log } = await broken(t, {
      'lib/hooks/owns.js': 'export function handle() { return new Promise(() => setInterval(() => {}, 1000)); }\n',
      'lib/hooks/runner.js': (text) => text.replace('export const DEADLINE_MS = 10_000;', 'export const DEADLINE_MS = 500;'),
    });

    await check(TOOLS.write(NOT_OWNED));
    allowing(log, 'gave no answer within 0\\.5s and was stopped');
  });

  test('a bridge that fails before the runner is reached', async (t) => {
    const log = logOf(t);
    const { ctx, check } = host(repo);
    await plugin.setup(ctx);
    Object.defineProperty(ctx, 'location', {
      get() {
        throw new Error('no location today');
      },
    });

    await check(TOOLS.write(NOT_OWNED));
    allowing(log, 'failed in the hook bridge \\(no location today\\)');
  });

  test('nothing about a refusal goes to the log: the model and the person have it', async (t) => {
    const { check, log } = await loaded(t);

    await assert.rejects(check(TOOLS.write(NOT_OWNED)));
    assert.deepEqual(log(), []);
  });
});
