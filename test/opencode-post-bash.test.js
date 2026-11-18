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

// post-bash in Open Code, end to end short of the host: the execute.after
// callbacks a stand-in for setup()'s context collects, run on calls of the
// shell tool shaped as Open Code reports them once they have run (F264).
// Behind them is everything real — the bridge, the runner, a node process
// running bin/pdkit, post-bash.js and cut.js — in a directory that is no
// repository at all: the rule holds in any.
//
// The fixtures are post-bash.test.js's: a namespace a window cut before its
// last members, and the same namespace read to its brace. Each case of that
// suite that hands handle() a payload is here as a command a model runs, and
// so is each command its windows() cases read, with the rule asserted where
// the model reads it: the last text part of the command's result (§13 DV8).
// Its braces() case takes no payload and stands as it is.
//
// Then what only Open Code has: a command that exited otherwise than 0 is a
// call that completed here, and was a tool that failed under Claude Code; a
// command can be moved to the background; the shell tool cuts a long output
// itself; and post-bash fails open without turning a command that ran into
// one that failed (F33).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import plugin from '../opencode/server.js';
import { PLUGIN_ROOT } from '../lib/commands/support.js';
import { cutDecision } from '../lib/hooks/cut.js';
import { logOf } from './helpers/server-log.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const POSIX = process.platform !== 'win32';

/** Where the rule is, as the message names it: under the plugin's root, as runHook passes it. */
const RULE = `${PLUGIN_ROOT}/knowledge/pitfalls.md`;

/** A namespace cut by the window before its last members and its brace (post-bash.test.js). */
const CUT = [
  '4522:  export namespace env {',
  '4526-    export const appName: string;',
  '4570-    export function openExternal(uri: Uri): Promise<boolean>;',
  '4579-    export function createTelemetryLogger(sender?: TelemetrySender): TelemetryLogger;',
].join('\n');

/** The same namespace read to its end. */
const WHOLE = `${CUT}\n4590-    export const urlProtocol: string;\n4591-  }`;

/** The text post-bash has for the windows given, over CUT: the handler's own words (cut.js). */
const SAYS = (...windows) => cutDecision(windows, CUT, PLUGIN_ROOT).message;

let session;

before(async () => {
  // No repository: post-bash is not scoped to one.
  session = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-post-bash-session-')));
  await mkdir(join(session, 'packages', 'main'), { recursive: true });
});

after(async () => {
  await rm(session, { recursive: true, force: true });
});

/**
 * A stand-in for setup()'s context, in a directory: just enough for the entry
 * point to load in full. `ran` runs every execute.after callback in the order
 * they were registered, as Open Code does, on an event, and gives it back.
 */
function host(directory = session) {
  const afterTool = [];
  const registered = { dispose: async () => {} };
  const hooks = {
    hook: async (name, callback) => {
      if (name === 'execute.after') afterTool.push(callback);
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
    ran: async (event) => {
      for (const callback of afterTool) await callback(event);
      return event;
    },
  };
}

/** The post hooks of the plugin in this checkout, loaded in `directory`. */
async function loaded(t, directory) {
  const log = logOf(t);
  const { ctx, ran } = host(directory);
  await plugin.setup(ctx);
  return { ran, log };
}

/** A text part, as a result carries it. */
const text = (value) => ({ type: 'text', text: value });

/**
 * execute.after's event for a command the shell tool ran in the foreground,
 * as Open Code reports it (F264): the command's stdout and stderr as one
 * output, its exit code beside it, and the same output as the result's text,
 * with a part of its own for an exit code other than 0.
 */
const shell = (command, output, { exitCode = 0, workdir } = {}) => ({
  tool: 'shell',
  sessionID: 'ses_bash',
  agent: 'build',
  messageID: 'msg_bash',
  id: 'call_bash',
  input: workdir === undefined ? { command } : { command, workdir },
  status: 'completed',
  result: {
    output: { output, exitCode, wallTimeSeconds: 0.02 },
    content: [text(output), ...(exitCode === 0 ? [] : [text(`Exit code: ${exitCode}`)])],
    metadata: { status: 'completed', truncated: false, exit: exitCode },
  },
});

/** The result a call has after the hooks, given the one it had before. */
async function hooked(hooks, event) {
  const before = structuredClone(event.result);
  await hooks(event);
  return { before, now: event.result };
}

/**
 * The result kept whole, with one text part after it, on a line of its own
 * (answer.js withText says why); the text, without the line break.
 */
function added(before, now) {
  assert.deepEqual(now.content.slice(0, -1), before.content, 'the parts the tool gave stay first, as they were');
  assert.equal(now.content.length, before.content.length + 1, 'one part is added');
  const last = now.content.at(-1);
  assert.equal(last.type, 'text');
  assert.ok(last.text.startsWith('\n'), 'the text starts on a line of its own');
  for (const key of Object.keys(before).filter((key) => key !== 'content')) assert.deepEqual(now[key], before[key], key);
  return last.text.slice(1);
}

describe('the rule of 06-hooks.md for post-bash, on the shell tool', () => {
  // What it protects: a member past the end of a `grep -A` window, read as absent.
  test('HK-14: a windowed read that ends inside a block gets the rule, in the result', async (t) => {
    const { ran: hooks, log } = await loaded(t);

    const { before, now } = await hooked(hooks, shell('grep -n "namespace env" -A60 api.d.ts', CUT));

    const said = added(before, now);
    assert.equal(said, SAYS('grep -A60'));
    assert.match(said, /`grep -A60`/);
    assert.match(said, /1 `\{` opened, 0 closed/);
    assert.match(said, /unread, not absent/);
    assert.deepEqual(log(), []);
  });

  test('stays quiet when the window reached the closing brace', async (t) => {
    const { ran: hooks, log } = await loaded(t);

    const { before, now } = await hooked(hooks, shell('grep -n "namespace env" -A70 api.d.ts', WHOLE));

    assert.deepEqual(now, before);
    assert.deepEqual(log(), []);
  });

  test('stays quiet on an unwindowed read, however open its output', async (t) => {
    const { ran: hooks, log } = await loaded(t);

    const { before, now } = await hooked(hooks, shell('cat api.d.ts', CUT));

    assert.deepEqual(now, before);
    assert.deepEqual(log(), []);
  });

  // Run from the session's directory, which is never the plugin: the path is
  // the plugin's own, absolute, and the rule is there.
  test('names the rule by the absolute path of the plugin it runs from', async (t) => {
    const { ran: hooks } = await loaded(t);

    const { before, now } = await hooked(hooks, shell('sed -n 1555,1600p loader.ts', CUT));

    const said = added(before, now);
    assert.ok(said.endsWith(`See "A window that ends inside a block" in ${RULE}.`), said);
    assert.match(await readFile(RULE, 'utf8'), /^## A window that ends inside a block$/m);
  });
});

// post-bash.test.js's windows() cases, each as the command a model runs: what
// it finds is named in the rule; what it does not find leaves the result alone.
describe('every window post-bash finds, and none it does not, through the bridge', () => {
  const WINDOWED = [
    ['grep -n "export namespace env" -A60 api.d.ts | grep -n export | head -30', ['grep -A60']],
    ['head -40 api.d.ts', ['head -40']],
    ['head -n 40 api.d.ts', ['head -n 40']],
    ['cat api.d.ts | head -100', ['head -100']],
    ['cat -n api.d.ts | head -n 100', ['head -n 100']],
    ['git show HEAD:api.d.ts | tail -80', ['tail -80']],
    ['git grep -nA5 foo', ['git grep -nA5']],
    ['rg -C 3 foo', ['rg -C 3']],
    ['grep --after-context=8 foo f', ['grep --after-context=8']],
    ['sed -n 1555,1600p a.ts', ['sed -n 1555,1600p']],
    ["awk 'NR>=10 && NR<=20' f", ["awk 'NR>=10 && NR<=20'"]],
    ['head f', ['head']],
  ];
  for (const [command, windows] of WINDOWED) {
    test(`${command} → ${windows.join(', ')}`, async (t) => {
      const { ran: hooks, log } = await loaded(t);

      const { before, now } = await hooked(hooks, shell(command, CUT));

      assert.equal(added(before, now), SAYS(...windows));
      assert.deepEqual(log(), []);
    });
  }

  const QUIET = [
    // Trimming a list of matched lines is not reading a block.
    'grep -n "start() {" loader.ts | head -15',
    // A search between them makes it a list of matches again; a `;` is no pipe.
    'cat api.d.ts | grep export | head -5',
    'cat a.ts; grep x f | head',
    'cat api.d.ts',
    'grep -c foo f',
    'sed -i s/a/b/ f',
    // Following a log is watching, not reading a block.
    'tail -f app.log',
  ];
  for (const command of QUIET) {
    test(`${command} → nothing`, async (t) => {
      const { ran: hooks, log } = await loaded(t);

      const { before, now } = await hooked(hooks, shell(command, CUT));

      assert.deepEqual(now, before);
      assert.deepEqual(log(), []);
    });
  }
});

describe('what only Open Code has', () => {
  // Claude Code ran PostToolUse when a tool succeeded; a Bash command that
  // exited otherwise was a tool that failed (PostToolUseFailure, which pdkit
  // never registered). Open Code reports it as a call that completed.
  test('a command that exited otherwise than 0 is left alone, as a failed Bash call was', async (t) => {
    const { ran: hooks, log } = await loaded(t);

    for (const exitCode of [1, 2, 127]) {
      const { before, now } = await hooked(hooks, shell('grep -n "namespace env" -A60 api.d.ts missing.d.ts', CUT, { exitCode }));
      assert.deepEqual(now, before, String(exitCode));
    }
    assert.deepEqual(log(), []);
  });

  test('a command moved to the background is left alone: it has printed nothing yet', async (t) => {
    const { ran: hooks, log } = await loaded(t);
    const event = shell('tail -80 api.d.ts', 'Command moved to the background (shell ID: sh_x).\nPID: 1');
    event.input.background = true;
    event.result.output = { ...event.result.output, exitCode: null, shellID: 'sh_x', pid: 1 };
    event.result.metadata = { status: 'running', truncated: false, shellID: 'sh_x', pid: 1 };

    const { before, now } = await hooked(hooks, event);

    assert.deepEqual(now, before);
    assert.deepEqual(log(), []);
  });

  test('only after a call that succeeded', async (t) => {
    const { ran: hooks, log } = await loaded(t);
    const { result: _, ...ran } = shell('head -40 api.d.ts', CUT);
    const event = { ...ran, status: 'error', error: new Error('Working directory does not exist') };

    await hooks(event);

    assert.equal('result' in event, false);
    assert.deepEqual(log(), []);
  });

  // The shell tool keeps the last lines of a long output and says so, before
  // the hook (F34); the rule comes after its note and is not cut.
  test('a long output the shell tool cut keeps its note, and the rule comes after it', async (t) => {
    const { ran: hooks } = await loaded(t);
    const output = `${CUT}\n\n[showing lines 2001-4000 of 4000; full output saved to /tmp/sh_x.out]`;
    const event = shell('head -4000 api.d.ts', output);
    event.result.metadata.truncated = true;

    const { before, now } = await hooked(hooks, event);

    assert.equal(added(before, now), SAYS('head -4000'));
  });

  // What the command printed, not what the result holds by now: another
  // plugin's text in the result is no part of the read.
  test("the braces counted are the command's output, not text another plugin added", async (t) => {
    const { ran: hooks } = await loaded(t);
    const event = shell('head -40 api.d.ts', CUT);
    event.result.content.push(text('} closed by some other plugin'));

    const { before, now } = await hooked(hooks, event);

    assert.equal(added(before, now), SAYS('head -40'));
  });

  test("the shell tool's workdir, relative to the session, is where the command ran", async (t) => {
    const { ran: hooks, log } = await loaded(t);

    const { before, now } = await hooked(hooks, shell('head -40 api.d.ts', CUT, { workdir: 'packages/main' }));

    assert.equal(added(before, now), SAYS('head -40'));
    assert.deepEqual(log(), []);
  });
});

// post-bash shares execute.after with post-write and post-claim; it reads no
// call but a command.
describe('beside the other tools', () => {
  test('the result of a call of another tool is left alone, whatever it shows', async (t) => {
    const { ran: hooks, log } = await loaded(t);
    const shown = (tool, input) => ({ ...shell('head -40 api.d.ts', CUT), tool, input, result: { output: {}, content: [text(CUT)] } });

    for (const event of [
      shown('read', { path: 'api.d.ts', offset: 4522, limit: 4 }),
      shown('grep', { pattern: 'namespace env', path: '.' }),
      // A tool of another plugin's that runs a command: the gate reads it
      // (§13 DV5); post-bash, whose matcher was Bash, does not.
      { ...shell('head -40 api.d.ts', CUT), tool: 'terminal_run' },
    ]) {
      const { before, now } = await hooked(hooks, event);
      assert.deepEqual(now, before, event.tool);
    }
    assert.deepEqual(log(), []);
  });
});

/**
 * A copy of the plugin with some files replaced, loaded in the session's directory.
 *
 * @param {import('node:test').TestContext} t
 * @param {Record<string, string|((text: string) => string)|null>} files
 */
async function broken(t, files) {
  const dir = await mkdtemp(join(tmpdir(), 'pdkit-post-bash-plugin-'));
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
  const { ctx, ran: hooks } = host(session);
  await copy.setup(ctx);
  return { ran: hooks, log };
}

/**
 * The one line a command left as it was for want of an answer leaves in the
 * log: post-bash's, saying `problem`. post-write and post-claim run on the
 * same call and do not look at a command, so they have nothing to say, even
 * when the failure is the environment's.
 */
const allowing = (log, problem) => {
  assert.equal(log().length, 1, log().join('\n'));
  assert.match(log()[0], new RegExp(`^opencode-pdkit: pdkit: hook "post-bash" ${problem}.*; allowing$`, 's'));
};

// post-bash fails open (FAIL_CLOSED names pre-bash alone), and after a tool
// failing open is more than letting the call through: the command has run,
// and the bridge must not turn it into an error (F33). Each case is a command
// a working check speaks up about, so a result left as the tool gave it is
// the failure's doing.
describe('no answer leaves the result as the tool gave it, and says why', () => {
  /** A command the check has something to say about, and its result after the hooks. */
  async function unchanged(hooks) {
    const { before, now } = await hooked(hooks, shell('grep -n "namespace env" -A60 api.d.ts', CUT));
    assert.deepEqual(now, before);
  }

  test('no node on the PATH of the server', { skip: !POSIX && 'T10.10' }, async (t) => {
    const { ran: hooks, log } = await loaded(t);
    const path = process.env.PATH;
    process.env.PATH = session;
    t.after(() => (process.env.PATH = path));

    await unchanged(hooks);
    allowing(log, 'cannot run: "node" was not found on the PATH of the process that runs hooks \\(ENOENT\\)');
  });

  test('a session directory that does not exist', async (t) => {
    const { ran: hooks, log } = await loaded(t, join(session, 'missing'));

    await unchanged(hooks);
    allowing(log, 'cannot run: its working directory does not exist: ');
  });

  test('a CLI that does not load: exit 1', async (t) => {
    const { ran: hooks, log } = await broken(t, { 'lib/cli.js': 'this is not valid javascript {{{\n' });

    await unchanged(hooks);
    allowing(log, 'exited with code 1 \\(SyntaxError: ');
  });

  test('a handler that does not load: runHook allows, as under Claude Code', async (t) => {
    const { ran: hooks, log } = await broken(t, { 'lib/hooks/post-bash.js': 'this is not valid javascript {{{\n' });

    await unchanged(hooks);
    allowing(log, 'handler "post-bash\\.js" is unavailable');
  });

  test('a handler that throws: runHook allows, as under Claude Code', async (t) => {
    const { ran: hooks, log } = await broken(t, { 'lib/hooks/post-bash.js': "export async function handle() { throw new Error('parse broke'); }\n" });

    await unchanged(hooks);
    allowing(log, 'failed \\(parse broke\\)');
  });

  test('a handler that hangs: stopped at the deadline', async (t) => {
    const { ran: hooks, log } = await broken(t, {
      'lib/hooks/post-bash.js': 'export function handle() { return new Promise(() => setInterval(() => {}, 1000)); }\n',
      'lib/hooks/runner.js': (source) => source.replace('export const DEADLINE_MS = 10_000;', 'export const DEADLINE_MS = 2_000;'),
    });

    await unchanged(hooks);
    allowing(log, 'gave no answer within 2s and was stopped');
  });

  test('a bridge that fails before the runner is reached', async (t) => {
    const log = logOf(t);
    const { ctx, ran: hooks } = host(session);
    await plugin.setup(ctx);
    Object.defineProperty(ctx, 'location', {
      get() {
        throw new Error('no location today');
      },
    });

    await unchanged(hooks);
    allowing(log, 'failed in the hook bridge \\(no location today\\)');
  });

  // The location is read for a run, after a hook has chosen the call: a call
  // no post hook looks at needs none, and costs no line without one.
  test('and a call no post hook looks at says nothing without a location', async (t) => {
    const log = logOf(t);
    const { ctx, ran: hooks } = host(session);
    await plugin.setup(ctx);
    Object.defineProperty(ctx, 'location', {
      get() {
        throw new Error('no location today');
      },
    });

    const read = { ...shell('head -40 api.d.ts', CUT), tool: 'read', input: { path: 'api.d.ts' }, result: { output: {}, content: [text(CUT)] } };
    const { before, now } = await hooked(hooks, read);

    assert.deepEqual(now, before);
    assert.deepEqual(log(), []);
  });
});
