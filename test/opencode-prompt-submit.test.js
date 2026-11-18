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

// prompt-submit in Open Code, end to end short of the host: the prompt hook a
// stand-in for setup()'s context collects, called as Open Code calls it — with
// the event a prompt gives (F75), the label a pdkit command puts on the prompt
// it sends (D6, F80), in the plugin instance of the session's directory.
// Behind it is everything real — the bridge, the runner, a node process
// running bin/pdkit, prompt-submit.js — in a repository whose main checkout
// is on one issue's branch while another issue has a worktree, against a
// throwaway $PDKIT_HOME.
//
// What the handler says for each case is test/prompt-submit.test.js's, on
// this same form; here is the bridge's part. That the context goes with the
// prompt as an attached text and leaves what the person typed alone. That a
// prompt without the label — nearly every prompt — costs nothing: no read, no
// process. That it shares the hook with session-start, neither in the other's
// way. And that Open Code waits on this hook before it takes the prompt in,
// and loses the prompt on an exception from it or a hang (F81), where Claude
// Code's hook never blocked — so whatever fails lets the prompt through, in
// time, and says why.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import plugin from '../opencode/server.js';
import { createBridge } from '../opencode/bridge/hooks.js';
import { PLUGIN_ROOT } from '../lib/config.js';
import { handle } from '../lib/hooks/prompt-submit.js';
import { transition } from '../lib/state.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const POSIX = process.platform !== 'win32';
const execFileAsync = promisify(execFile);

/** The issue whose branch the main checkout is on. */
const HERE = 4101;
/** The issue with a worktree of its own, which the command names. */
const AWAY = 4102;

/** The session a person drives. */
const PERSON = 'ses_person';

let home;
let base;
let main;
let away;
let previousHome;

const git = (cwd, ...args) => execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd });

before(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-prompt-bridge-home-')));
  // The child process takes $PDKIT_HOME from the server's environment, as it
  // would in a session; here the server is this process.
  previousHome = process.env.PDKIT_HOME;
  process.env.PDKIT_HOME = home;
  base = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-prompt-bridge-repo-')));
  main = join(base, 'podman-desktop');
  away = join(base, `DESKTOP-${AWAY}`);
  await mkdir(main);
  await git(main, 'init', '-q', '-b', 'main');
  await git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
  await git(main, 'switch', '-q', '-c', `DESKTOP-${HERE}/1-reconnect-the-event-stream`);
  await git(main, 'worktree', 'add', '-q', '-b', `DESKTOP-${AWAY}/1-quit-and-install`, away, 'main');
  await transition(AWAY, 'triaged', { home });
  // So that session-start, on the same hook, has something to say in the
  // main checkout: it stands on this issue's branch.
  await transition(HERE, 'triaged', { home });
});

after(async () => {
  if (previousHome === undefined) delete process.env.PDKIT_HOME;
  else process.env.PDKIT_HOME = previousHome;
  for (const dir of [home, base]) await rm(dir, { recursive: true, force: true });
});

/** A pdkit command's label on the prompt it sends (D6): which command, with what. */
const label = (command = 'pd:preflight', args = `${AWAY}`) => ({ source: 'opencode-pdkit', command, arguments: args });

/** The prompt hook's event (F75): the line a command's execute sent, its label, and the files the person attached. */
const prompting = ({ metadata = label(), text = `/pd:preflight ${AWAY}`, files = [], sessionID = PERSON } = {}) => ({
  sessionID,
  messageID: 'msg_test',
  prompt: { text, files, agents: [] },
  metadata,
  delivery: 'steer',
});

/** A session that has run (F270): session-start, on the same hook, leaves its prompts alone. */
const ran = (directory = main) => ({
  id: PERSON,
  projectID: 'global',
  outcome: 'succeeded',
  time: { created: 1794850025467, updated: 1794850025924, busy: 1794850025888, idle: 1794850025921 },
  location: { directory },
});

/** A session that has never run (F270): its first prompt is where session-start runs. */
const fresh = (directory = main) => ({ id: PERSON, projectID: 'global', time: { created: 1794850025467, updated: 1794850025467 }, location: { directory } });

/**
 * A stand-in for setup()'s context, in `directory`: just enough for the entry
 * point to load in full, with the sessions it knows and the instruction
 * entries it was given. `submit` calls the prompt hook as Open Code does and
 * checks the callbacks give nothing back. `directory: null` is an instance
 * with no location; `fail.hook` names a hook point the host does not have.
 *
 * `hooks.get(name)` runs every callback registered on the point, in the order
 * they were registered, on the one event — as Open Code 2.3.0 triggers a
 * point (src/plugin/hooks.ts) — and gives back the first answer that is not
 * undefined: the prompt point carries the bridge's and the grant of a
 * command's allowed-tools (opencode/allowed.js).
 */
function host({ directory = main, sessions = { [PERSON]: ran() }, fail = {} } = {}) {
  const hooks = new Map();
  const callbacks = new Map();
  const looked = [];
  const entries = [];
  const registered = { dispose: async () => {} };
  const transforms = { transform: async () => registered };
  const ctx = {
    app: { name: 'cli', version: '2.3.0', channel: 'latest' },
    location: directory === null ? undefined : { directory, project: { id: 'global', directory, canonical: directory } },
    tool: { hook: async () => registered },
    session: {
      hook: async (name, callback) => {
        if (fail.hook === name) throw new Error(`unknown session hook: ${name}`);
        callbacks.set(name, [...(callbacks.get(name) ?? []), callback]);
        hooks.set(name, async (event) => {
          const answers = [];
          for (const each of callbacks.get(name)) answers.push(await each(event));
          return answers.find((answer) => answer !== undefined);
        });
        return registered;
      },
      get: async ({ sessionID }) => {
        looked.push(sessionID);
        if (!Object.hasOwn(sessions, sessionID)) throw new Error(`Session not found: ${sessionID}`);
        return sessions[sessionID];
      },
      instructions: {
        entry: {
          put: async (input) => entries.push({ op: 'put', ...input }),
          remove: async (input) => entries.push({ op: 'remove', ...input }),
          list: async () => [],
        },
      },
    },
    shell: { hook: async () => registered },
    permission: { hook: async () => registered },
    agent: transforms,
    command: transforms,
    skill: transforms,
    event: { subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }) },
  };
  return {
    ctx,
    hooks,
    looked,
    entries,
    submit: async (event) => {
      assert.equal(await hooks.get('prompt')(event), undefined, 'the callback gives the host nothing back');
      return event;
    },
  };
}

/** What setup() and the callbacks write to the server's stderr. */
function logOf(t) {
  const error = t.mock.method(console, 'error', () => {});
  return () => error.mock.calls.map((entry) => entry.arguments.join(' '));
}

/** The plugin in this checkout, loaded in the stand-in's directory. */
async function loaded(t, options) {
  const log = logOf(t);
  const stand = host(options);
  const cleanup = await plugin.setup(stand.ctx);
  t.after(() => cleanup?.());
  return { ...stand, log };
}

/**
 * A copy of the plugin with some files replaced, loaded in the main checkout.
 *
 * @param {import('node:test').TestContext} t
 * @param {Record<string, string|((text: string) => string)|null>} files
 */
async function broken(t, files, options) {
  const dir = await mkdtemp(join(tmpdir(), 'pdkit-prompt-bridge-plugin-'));
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
  const stand = host(options);
  const cleanup = await copy.setup(stand.ctx);
  t.after(() => cleanup?.());
  return { ...stand, log };
}

/** The files the bridge attached to a prompt, each with its text. */
const attachments = (event) =>
  (event.prompt?.files ?? [])
    .filter((file) => file?.name === 'pdkit-context')
    .map((file) => ({ ...file, text: Buffer.from(file.uri.replace(/^data:text\/plain;base64,/, ''), 'base64').toString('utf8') }));

/** What handle() says for the command as typed, in `cwd`. */
const typed = async (command, args, cwd = main) => (await handle({ prompt: `/${command} ${args}`.trimEnd(), cwd }, { event: 'prompt-submit', pluginRoot: PLUGIN_ROOT })).message;

describe('the context of a pdkit command goes with its prompt', () => {
  // HK-24, on Open Code's form: what the handler says for `/pd:preflight
  // <n>` typed in another issue's tree.
  test('HK-24: as one plain-text file attached to the prompt, the handler\'s words', async (t) => {
    const { submit, log } = await loaded(t);

    const event = await submit(prompting());

    const [file, ...more] = attachments(event);
    assert.deepEqual(more, []);
    assert.equal(file.text, await typed('pd:preflight', `${AWAY}`));
    assert.match(file.text, new RegExp(`^pdkit: /pd:preflight is about issue ${AWAY} — triaged, and this tree is not its\\.`));
    assert.match(file.uri, /^data:text\/plain;base64,/);
    assert.match(file.description, /^Added by pdkit, not by the person/);
    assert.deepEqual(log(), []);
  });

  // Claude Code added the context beside the prompt; the person's words and
  // the command's label stay as they were (F79: a change to the text would
  // change what is kept as theirs).
  test('what the person typed is left as it was', async (t) => {
    const { submit } = await loaded(t);

    const event = await submit(prompting());

    assert.deepEqual({ ...event, prompt: { ...event.prompt, files: [] } }, prompting());
  });

  test('after the files the person attached, which are kept', async (t) => {
    const { submit } = await loaded(t);
    const own = { uri: 'file:///tmp/notes.md', name: 'notes.md' };

    const event = await submit(prompting({ files: [own] }));

    assert.equal(event.prompt.files.length, 2);
    assert.equal(event.prompt.files[0], own);
    assert.equal(event.prompt.files[1].name, 'pdkit-context');
  });

  // `files` is optional on a prompt (F75).
  test('a prompt with no files gets a list of one', async (t) => {
    const { submit } = await loaded(t);
    const event = prompting();
    delete event.prompt.files;

    await submit(event);
    assert.equal(attachments(event).length, 1);
  });

  // The hook's event names no directory: the instance's is the session's
  // (F75, F275). In the issue's own tree, the handler is quiet.
  test("the tree is the instance directory's: in the issue's own, nothing", async (t) => {
    const { submit, log } = await loaded(t, { directory: away, sessions: { [PERSON]: ran(away) } });

    const event = await submit(prompting());

    assert.deepEqual(event.prompt.files, []);
    assert.deepEqual(log(), []);
  });

  // The command, put back together from its label, is what the handler
  // reads as typed: arguments and all.
  test('the arguments as the label gives them', async (t) => {
    const { submit } = await loaded(t);

    const event = await submit(prompting({ metadata: label('pd:preflight', `#${AWAY} and then some`) }));
    assert.equal(attachments(event)[0]?.text, await typed('pd:preflight', `#${AWAY} and then some`));
  });

  test('no lookup of the session beyond the one session-start makes', async (t) => {
    const { submit, looked } = await loaded(t);

    await submit(prompting());
    assert.deepEqual(looked, [PERSON]);
  });
});

// prompt-submit runs on every prompt Open Code takes in, and looks at a pdkit
// command's alone (D6). Every other prompt must cost it nothing — not a
// process, not a read of the location. Shown with a copy whose CLI cannot load
// and whose instance has a location that throws: any run, or any read, would
// say so in the log.
describe('any other prompt costs nothing', () => {
  for (const [what, event] of [
    ['what a person types', prompting({ metadata: null, text: 'what is left on the reconnect fix?' })],
    ['a pdkit command typed where no command runs — `opencode run` (F78)', prompting({ metadata: null, text: `/pd:preflight ${AWAY}` })],
    ["a subagent's first task", { ...prompting({ text: 'You are a subagent spawned by another session.\nRun pwd.' }), metadata: undefined }],
    ["another plugin's command", prompting({ metadata: { source: 'goal', goalID: 'goal_1' } })],
    ['a label that names no pdkit command', prompting({ metadata: label('preflight') })],
    ['a prompt with no session', prompting({ sessionID: '' })],
  ]) {
    test(`${what}: no read, no process, nothing attached`, async (t) => {
      const stand = await broken(t, { 'lib/cli.js': 'this is not valid javascript {{{\n' });
      Object.defineProperty(stand.ctx, 'location', {
        get() {
          throw new Error('the location was read');
        },
      });
      const before = JSON.parse(JSON.stringify(event));

      await stand.submit(event);

      assert.deepEqual(JSON.parse(JSON.stringify(event)), before);
      assert.deepEqual(stand.log(), []);
    });
  }
});

// session-start runs on a session's first prompt, and that prompt may well
// be a pdkit command. One callback runs both, side by side; each fails on its
// own.
describe('on the hook it shares with session-start', () => {
  test("a session's first prompt, a pdkit command: the summary is the session's entry, the context goes with the prompt", async (t) => {
    const { submit, entries, log } = await loaded(t, { sessions: { [PERSON]: fresh() } });

    const event = await submit(prompting());

    assert.equal(entries.length, 1);
    assert.equal(entries[0].op, 'put');
    assert.equal(entries[0].sessionID, PERSON);
    assert.equal(attachments(event)[0]?.text, await typed('pd:preflight', `${AWAY}`));
    assert.deepEqual(log(), []);
  });

  test("a session that cannot be looked up costs session-start's summary, not the command's context", async (t) => {
    const { submit, entries, log } = await loaded(t, { sessions: {} });

    const event = await submit(prompting());

    assert.deepEqual(entries, []);
    assert.equal(attachments(event).length, 1);
    assert.deepEqual(log(), [`opencode-pdkit: pdkit: hook "session-start" failed in the hook bridge (Session not found: ${PERSON}); allowing`]);
  });

  test("a prompt-submit that fails costs the command's context, not session-start's summary", async (t) => {
    const { submit, entries, log } = await broken(t, { 'lib/hooks/prompt-submit.js': "export async function handle() { throw new Error('the tree broke'); }\n" }, { sessions: { [PERSON]: fresh() } });

    const event = await submit(prompting());

    assert.equal(entries.length, 1);
    assert.deepEqual(event.prompt.files, []);
    assert.equal(log().length, 1, log().join('\n'));
    assert.match(log()[0], /^opencode-pdkit: pdkit: hook "prompt-submit" failed \(the tree broke\); allowing$/);
  });
});

/** The one line a prompt left without context writes: prompt-submit's, saying `problem`. */
const allowing = (log, problem) => {
  assert.equal(log().length, 1, log().join('\n'));
  assert.match(log()[0], new RegExp(`^opencode-pdkit: pdkit: hook "prompt-submit" ${problem}.*; allowing$`, 's'));
};

// prompt-submit fails open (FAIL_CLOSED names pre-bash alone), and here that
// is the person's input: Open Code waits on the hook without end, and drops
// the prompt on an exception from it (F81). So every failure returns, in
// time, with the prompt as it came.
describe('no answer lets the prompt through, and says why', () => {
  const handler = (body) => ({ 'lib/hooks/prompt-submit.js': `export async function handle() { ${body} }\n` });

  const untouched = (event) => assert.deepEqual(event.prompt.files, [], 'nothing attached');

  test('no node on the PATH of the server', { skip: !POSIX && 'T10.10' }, async (t) => {
    const { submit, log } = await loaded(t);
    const path = process.env.PATH;
    process.env.PATH = home;
    t.after(() => (process.env.PATH = path));

    untouched(await submit(prompting()));
    allowing(log, 'cannot run: "node" was not found on the PATH of the process that runs hooks \\(ENOENT\\)');
  });

  test('an instance directory that does not exist', async (t) => {
    const { submit, log } = await loaded(t, { directory: join(main, 'missing') });

    untouched(await submit(prompting()));
    allowing(log, 'cannot run: its working directory does not exist: ');
  });

  test('an instance without a directory', async (t) => {
    const { submit, log } = await loaded(t, { directory: null });

    untouched(await submit(prompting()));
    allowing(log, 'cannot run: the payload names no working directory');
  });

  test('a CLI that does not load: exit 1', async (t) => {
    const { submit, log } = await broken(t, { 'lib/cli.js': 'this is not valid javascript {{{\n' });

    untouched(await submit(prompting()));
    allowing(log, 'exited with code 1 \\(SyntaxError: ');
  });

  test('a handler that does not load: runHook allows, as under Claude Code', async (t) => {
    const { submit, log } = await broken(t, { 'lib/hooks/prompt-submit.js': 'this is not valid javascript {{{\n' });

    untouched(await submit(prompting()));
    allowing(log, 'handler "prompt-submit\\.js" is unavailable');
  });

  test('a handler that throws: runHook allows, as under Claude Code', async (t) => {
    const { submit, log } = await broken(t, handler("throw new Error('the tree broke');"));

    untouched(await submit(prompting()));
    allowing(log, 'failed \\(the tree broke\\)');
  });

  // Open Code would hold the prompt for as long as the hook takes (F81): the
  // deadline is the bridge's.
  test('a handler that hangs: stopped at the deadline, and the prompt goes on', async (t) => {
    const { submit, log } = await broken(t, {
      'lib/hooks/prompt-submit.js': 'export function handle() { return new Promise(() => setInterval(() => {}, 1000)); }\n',
      'lib/hooks/runner.js': (source) => source.replace('export const DEADLINE_MS = 10_000;', 'export const DEADLINE_MS = 2_000;'),
    });
    const started = Date.now();

    untouched(await submit(prompting()));

    assert.ok(Date.now() - started < 8_000, `returned after ${Date.now() - started} ms`);
    allowing(log, 'gave no answer within 2s and was stopped');
  });

  // The handler never refuses. One that does discards nothing: Claude Code
  // would have dropped the prompt, and only a throw could here.
  test('a refusal lets the prompt through, and reaches no one', async (t) => {
    const { submit, log } = await broken(t, handler("return { block: true, reason: 'pdkit: not now' };"));

    untouched(await submit(prompting()));
    assert.deepEqual(log(), ['opencode-pdkit: prompt-submit reason, which reaches no one here: pdkit: not now']);
  });

  // The plugin has no line for the person (D12); the model's text is
  // attached as ever.
  test('a notice reaches no one, and the message beside it goes with the prompt', async (t) => {
    const { submit, log } = await broken(t, handler("return { block: false, message: 'pdkit: for the model', notice: 'pdkit: for the person' };"));

    const event = await submit(prompting());

    assert.deepEqual(attachments(event).map(({ text }) => text), ['pdkit: for the model']);
    assert.deepEqual(log(), ['opencode-pdkit: prompt-submit notice, which reaches no one here: pdkit: for the person']);
  });

  // A handler that allows and writes to stderr: Claude Code put that in its
  // debug log.
  test('what a handler writes to stderr while it allows goes to the log', async (t) => {
    const { submit, log } = await broken(t, handler("process.stderr.write('pdkit: a note\\n'); return { block: false };"));

    untouched(await submit(prompting()));
    assert.deepEqual(log(), ['opencode-pdkit: pdkit: a note']);
  });

  test('a bridge that fails before the run', async () => {
    const lines = [];
    const stand = host();
    Object.defineProperty(stand.ctx, 'location', {
      get() {
        throw new Error('the location is gone');
      },
    });
    const bridge = createBridge(stand.ctx, { root: ROOT, settings: { models: {} }, log: (line) => lines.push(line) });
    const event = prompting();

    assert.equal(await bridge.promptSubmit(event), undefined);
    assert.deepEqual(lines, ['pdkit: hook "prompt-submit" failed in the hook bridge (the location is gone); allowing']);
    untouched(event);
  });

  // The context is ready, and the prompt has no shape to attach it to.
  test('a prompt the bridge cannot attach to', async () => {
    const lines = [];
    const bridge = createBridge(host().ctx, { root: ROOT, settings: { models: {} }, log: (line) => lines.push(line) });
    const event = { sessionID: PERSON, messageID: 'msg_test', metadata: label(), delivery: 'steer' };

    assert.equal(await bridge.promptSubmit(event), undefined);
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /^pdkit: hook "prompt-submit" failed in the hook bridge \(.+\); allowing$/);
  });

  test('a callback with no event says nothing, and does nothing', async (t) => {
    const { hooks, log, looked } = await loaded(t);

    for (const event of [undefined, null, {}]) {
      assert.equal(await hooks.get('prompt')(event), undefined);
    }
    assert.deepEqual(looked, []);
    assert.deepEqual(log(), []);
  });
});

describe('where it is registered', () => {
  // The prompt point carries two hooks of the bridge's, and the end of the
  // grant a command's allowed-tools gives (opencode/allowed.js); a host
  // without it loses all three, and each part says so once.
  test('a host without the prompt hook leaves the rest registered, and is reported', async (t) => {
    const { hooks, log } = await loaded(t, { fail: { hook: 'prompt' } });

    assert.deepEqual(log(), [
      'opencode-pdkit: cannot register its hooks (unknown session hook: prompt); the gate and the rest are unaffected',
      "opencode-pdkit: cannot register its allowed tools (unknown session hook: prompt); /pd:editor, /pd:open run their commands as the person's rules say, asking where they ask",
    ]);
    // context and generate: the agents' hiding of tools (opencode/agents.js).
    assert.deepEqual([...hooks.keys()].sort(), ['compaction', 'context', 'experimental.idle', 'fork', 'generate']);
  });

  test('one callback of the bridge on the prompt hook, for session-start and prompt-submit both', async () => {
    const registrations = [];
    const stand = host();
    const hook = stand.ctx.session.hook;
    stand.ctx.session.hook = async (name, callback) => {
      registrations.push(name);
      return hook(name, callback);
    };
    const bridge = createBridge(stand.ctx, { root: ROOT, settings: { models: {} }, log: () => {} });
    await bridge.register();
    try {
      assert.equal(registrations.filter((name) => name === 'prompt').length, 1);
    } finally {
      await bridge.cleanup();
    }
  });

  test('beside it, after it, the one that ends a grant of allowed-tools', async (t) => {
    const registrations = [];
    const stand = host();
    const hook = stand.ctx.session.hook;
    stand.ctx.session.hook = async (name, callback) => {
      registrations.push(name);
      return hook(name, callback);
    };
    logOf(t);
    const cleanup = await plugin.setup(stand.ctx);
    t.after(() => cleanup?.());

    assert.equal(registrations.filter((name) => name === 'prompt').length, 2);
  });
});
