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

// The plugin's entry point, run against a stand-in for the context Open Code
// passes to setup().
//
// What is pinned here is what no session would show until it went wrong: that
// the gate's callback is registered before anything that can fail, that a
// plugin which could not load refuses every shell command instead of letting
// them all through, and that below the minimum Open Code version only the gate
// and refusing commands are registered. The stand-in records every
// registration in order; a broken plugin is a copy of opencode/ with one file
// replaced.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import plugin from '../opencode/server.js';
import { minimumVersion } from '../lib/opencode-version.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const RELEASE = Object.freeze({ name: 'cli', version: '2.3.0', channel: 'latest' });
const OLD = Object.freeze({ name: 'cli', version: '2.2.7', channel: 'latest' });

const FULL = [
  'tool.hook execute.before',
  'tool.hook execute.after',
  'shell.hook create.before',
  'agent.transform',
  'command.transform',
  'skill.transform',
];

/** A shell event as execute.before receives it (input as the model wrote it). */
const shell = () => ({
  tool: 'shell',
  sessionID: 'ses_test',
  agent: 'build',
  messageID: 'msg_test',
  id: 'call_test',
  input: { command: 'git push origin HEAD' },
});

const write = () => ({ ...shell(), tool: 'write', input: { path: 'a.txt', content: 'a' } });

/**
 * A stand-in for setup()'s context: every hook and transform registration is
 * recorded in order, with its callback. `fail` names registrations that reject.
 */
function host({ app = RELEASE, options, fail = [] } = {}) {
  const order = [];
  const callbacks = new Map();
  const registration = { dispose: async () => {} };
  const record = (name, callback) => {
    if (fail.includes(name)) throw new Error(`${name} is unavailable`);
    order.push(name);
    callbacks.set(name, [...(callbacks.get(name) ?? []), callback]);
    return registration;
  };
  const hooks = (domain) => ({ hook: async (name, callback) => record(`${domain}.hook ${name}`, callback) });
  const transform = (domain) => ({ transform: async (callback) => record(`${domain}.transform`, callback) });

  const ctx = {
    app,
    options,
    location: { directory: '/work/project', project: { id: 'global', directory: '/work/project', canonical: '/work/project' } },
    tool: hooks('tool'),
    session: hooks('session'),
    shell: hooks('shell'),
    permission: hooks('permission'),
    agent: transform('agent'),
    command: transform('command'),
    skill: transform('skill'),
  };
  return {
    ctx,
    order,
    gate: (event) => callbacks.get('tool.hook execute.before')[0](event),
    callbacks: (name) => callbacks.get(name) ?? [],
  };
}

/** Run transform callbacks against an editor that records every call made on it. */
function edits(callbacks) {
  const calls = [];
  const editor = new Proxy({}, { get: (_, method) => (...args) => calls.push({ method, args }) });
  for (const callback of callbacks) callback(editor);
  return calls;
}

/** What setup() writes to the server log, one entry per console.error call. */
function logOf(t) {
  const error = t.mock.method(console, 'error', () => {});
  return () => error.mock.calls.map((call) => call.arguments.join(' '));
}

/**
 * A copy of the plugin's entry point and what it loads, with some files
 * replaced (a string) or removed (null). Returns the copy's default export.
 */
async function copy(t, files) {
  const dir = await mkdtemp(join(tmpdir(), 'pdkit-entry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(join(ROOT, 'opencode'), join(dir, 'opencode'), { recursive: true });
  await mkdir(join(dir, 'lib'));
  await cp(join(ROOT, 'lib', 'opencode-version.js'), join(dir, 'lib', 'opencode-version.js'));
  await cp(join(ROOT, 'package.json'), join(dir, 'package.json'));
  for (const [path, content] of Object.entries(files)) {
    if (content === null) await rm(join(dir, path));
    else await writeFile(join(dir, path), content);
  }
  return (await import(pathToFileURL(join(dir, 'opencode', 'server.js')).href)).default;
}

/** Every directory under skills/ with a SKILL.md: each is a command a person can type. */
async function skills() {
  const names = [];
  for (const entry of await readdir(join(ROOT, 'skills'), { withFileTypes: true })) {
    if (entry.isDirectory() && (await stat(join(ROOT, 'skills', entry.name, 'SKILL.md')).catch(() => null))) {
      names.push(entry.name);
    }
  }
  return names.sort();
}

describe('the gate comes first', () => {
  for (const [label, app] of [
    ['on a supported Open Code', RELEASE],
    ['below the minimum', OLD],
  ]) {
    test(`execute.before is the first thing setup registers, ${label}`, async (t) => {
      logOf(t);
      const { ctx, order } = host({ app });

      await plugin.setup(ctx);

      assert.equal(order[0], 'tool.hook execute.before');
      assert.equal(order.filter((name) => name === 'tool.hook execute.before').length, 1);
    });
  }
});

describe('on a supported Open Code', () => {
  test('hooks, agents, commands and skills are registered after the gate', async (t) => {
    logOf(t);
    const { ctx, order } = host();

    await plugin.setup(ctx);

    assert.deepEqual(order, FULL);
  });

  // Until the bridge and the registrars are filled in, loading the plugin must
  // not change what a session does.
  test('and none of the registrations changes anything yet', async (t) => {
    logOf(t);
    const { ctx, gate, callbacks } = host();

    await plugin.setup(ctx);

    for (const domain of ['agent', 'command', 'skill']) {
      assert.deepEqual(edits(callbacks(`${domain}.transform`)), [], `${domain}.transform edits something`);
    }
    const event = { ...shell(), result: { content: [{ type: 'text', text: 'ok' }] } };
    for (const after of callbacks('tool.hook execute.after')) await after(event);
    assert.deepEqual(event, { ...shell(), result: { content: [{ type: 'text', text: 'ok' }] } });
    await gate(shell());
    await gate(write());
  });

  // What makes `pdkit` a bare command in a session, and tells doctor which
  // server runs the plugin (opencode/environment.js has the cases).
  test("every shell command gets the plugin's bin/ first on PATH and the server's version", async (t) => {
    logOf(t);
    const { ctx, callbacks } = host();

    await plugin.setup(ctx);

    const created = { command: 'pdkit --help', cwd: '/work/project', timeout: 120000, shell: '/bin/zsh', env: { PATH: '/usr/bin' } };
    for (const before of callbacks('shell.hook create.before')) await before(created);
    assert.equal(created.env.PATH, [join(ROOT, 'bin'), '/usr/bin'].join(delimiter));
    assert.equal(created.env.PDKIT_OPENCODE_VERSION, RELEASE.version);
  });

  test('nothing is written to the log', async (t) => {
    const log = logOf(t);

    await plugin.setup(host().ctx);

    assert.deepEqual(log(), []);
  });

  test('setup returns a cleanup that can run more than once', async (t) => {
    logOf(t);

    const cleanup = await plugin.setup(host().ctx);

    assert.equal(typeof cleanup, 'function');
    await cleanup();
    await cleanup();
  });
});

// ctx.options is whatever the user wrote in opencode.json. A setup() that
// threw on it would unload the plugin, gate included, over a typo.
describe('ctx.options', () => {
  for (const options of [undefined, null, {}, { models: { 'pd-scout': 'openai/gpt-5#high' } }, 'models', [1], { models: 7 }, { model: 'x' }]) {
    test(`${JSON.stringify(options)} loads the plugin in full`, async (t) => {
      const log = logOf(t);
      const { ctx, order } = host({ options });

      await plugin.setup(ctx);

      assert.deepEqual(order, FULL);
      assert.deepEqual(log(), []);
    });
  }
});

describe('below the minimum Open Code version', () => {
  test('only the gate and the commands are registered', async (t) => {
    logOf(t);
    const { ctx, order } = host({ app: OLD });

    await plugin.setup(ctx);

    assert.deepEqual(order, ['tool.hook execute.before', 'command.transform']);
  });

  // Decided with the minimum (D9): nothing but the gate and the refusals. So
  // `pdkit` is not on PATH there either, and no variable names the server's
  // version — doctor run by its full path falls back to the CLI's.
  test('so no shell command gets bin/ on PATH or the version', async (t) => {
    logOf(t);
    const { ctx, callbacks } = host({ app: OLD });

    await plugin.setup(ctx);

    assert.deepEqual(callbacks('shell.hook create.before'), []);
  });

  test('every skill is a /pd: command that refuses and names the version to install', async (t) => {
    logOf(t);
    const minimum = minimumVersion(JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).engines.opencode);
    const { ctx, callbacks } = host({ app: OLD });

    await plugin.setup(ctx);

    const added = edits(callbacks('command.transform'));
    assert.ok(added.every((call) => call.method === 'add'));
    assert.deepEqual(
      added.map((call) => call.args[0].name),
      (await skills()).map((name) => `pd:${name}`),
    );
    for (const { args } of added) {
      assert.match(args[0].description, new RegExp(`Open Code >= ${minimum.replace(/\./g, '\\.')}`));
      await assert.rejects(args[0].execute({ sessionID: 'ses_test', prompt: {}, delivery: 'immediate' }), {
        message: `opencode-pdkit requires Open Code >= ${minimum}, running 2.2.7. Update it with: opencode upgrade`,
      });
    }
  });

  test('the gate still runs', async (t) => {
    logOf(t);
    const { ctx, gate } = host({ app: OLD });

    await plugin.setup(ctx);

    await gate(shell());
  });

  test('one line goes to the log', async (t) => {
    const log = logOf(t);

    await plugin.setup(host({ app: OLD }).ctx);

    assert.equal(log().length, 1);
    assert.match(log()[0], /^opencode-pdkit: opencode-pdkit requires Open Code >= \d+\.\d+\.\d+, running 2\.2\.7/);
  });
});

// Whoever runs a nightly or a local build chose to; it cannot be placed on the
// release line, so it is neither refused nor reported.
describe('a build that is not a release loads in full', () => {
  for (const app of [
    { name: 'cli', version: '0.0.0-dev-1297', channel: 'dev' },
    { name: 'cli', version: 'local', channel: 'local' },
  ]) {
    test(`${app.version} on ${app.channel}`, async (t) => {
      const log = logOf(t);
      const { ctx, order } = host({ app });

      await plugin.setup(ctx);

      assert.deepEqual(order, FULL);
      assert.deepEqual(log(), []);
    });
  }
});

describe('a version it cannot read', () => {
  test('loads in full and says so in the log', async (t) => {
    const log = logOf(t);
    const { ctx, order } = host();
    ctx.app = undefined;

    await plugin.setup(ctx);

    assert.deepEqual(order, FULL);
    assert.equal(log().length, 1);
    assert.match(log()[0], /no version; loading in full/);
  });
});

describe('a plugin that cannot load refuses every shell command', () => {
  const BROKEN = {
    'a bridge that throws on import': { 'opencode/bridge/hooks.js': "throw new Error('the bridge is broken');\n" },
    'a bridge that is missing': { 'opencode/bridge/hooks.js': null },
    'a bridge that cannot be created': {
      'opencode/bridge/hooks.js': "export function createBridge() { throw new Error('no bridge today'); }\n",
    },
    'a registrar with a syntax error': { 'opencode/agents.js': 'export async function registerAgents( {\n' },
    'a lib/ module that is missing': { 'lib/opencode-version.js': null },
  };

  for (const [label, files] of Object.entries(BROKEN)) {
    test(label, async (t) => {
      const log = logOf(t);
      const broken = await copy(t, files);
      const { ctx, order, gate } = host();

      const cleanup = await broken.setup(ctx);

      assert.deepEqual(order, ['tool.hook execute.before'], 'the other hooks fail open: none is registered');
      await assert.rejects(gate(shell()), (error) => {
        assert.match(error.message, /^pdkit: hook "pre-bash" cannot run: the opencode-pdkit plugin failed to load \(.+\)\./);
        assert.match(error.message, /refuses rather than allows/);
        return true;
      });
      await gate(write());
      assert.equal(log().length, 1);
      assert.match(log()[0], /failed to load .*every shell command is refused/);
      assert.equal(typeof cleanup, 'function');
      await cleanup();
    });
  }

  test('the refusal names the cause', async (t) => {
    logOf(t);
    const broken = await copy(t, BROKEN['a bridge that throws on import']);
    const { ctx, gate } = host();

    await broken.setup(ctx);

    await assert.rejects(gate(shell()), /the bridge is broken/);
  });

  // Open Code waits for setup() before it runs a tool, so this is not seen in
  // practice; if it ever were, a command must wait for the verdict rather than
  // slip through while the plugin is still loading.
  test('including one that arrives while setup is still loading', async (t) => {
    logOf(t);
    const broken = await copy(t, BROKEN['a bridge that throws on import']);
    const { ctx, gate } = host();

    const loading = broken.setup(ctx);
    const verdict = gate(shell());
    await loading;

    await assert.rejects(verdict, /pre-bash/);
  });
});

describe('a registration that fails', () => {
  for (const [what, failing] of [
    ['agents', 'agent.transform'],
    ['commands and skills', 'command.transform'],
    ['hooks', 'tool.hook execute.after'],
    ['shell environment', 'shell.hook create.before'],
  ]) {
    test(`leaves the gate and the rest in place: ${failing}`, async (t) => {
      const log = logOf(t);
      const { ctx, order, gate } = host({ fail: [failing] });

      await plugin.setup(ctx);

      assert.equal(order[0], 'tool.hook execute.before');
      for (const name of FULL.filter((name) => name !== failing && !(failing === 'command.transform' && name === 'skill.transform'))) {
        assert.ok(order.includes(name), `${name} is missing`);
      }
      await gate(shell());
      assert.equal(log().length, 1);
      assert.match(log()[0], new RegExp(`cannot register its ${what} \\(${failing} is unavailable\\)`));
    });
  }
});

describe('cleanup', () => {
  const RECORDING = `
export function createBridge() {
  return {
    async preBash() {},
    async register() {},
    async cleanup() {
      globalThis.pdkitBridgeCleanups = (globalThis.pdkitBridgeCleanups ?? 0) + 1;
      if (globalThis.pdkitBridgeCleanupThrows) throw new Error('cleanup is broken');
    },
  };
}
`;

  test("releases the bridge's state, once", async (t) => {
    logOf(t);
    globalThis.pdkitBridgeCleanups = 0;
    t.after(() => delete globalThis.pdkitBridgeCleanups);
    const recording = await copy(t, { 'opencode/bridge/hooks.js': RECORDING });

    const cleanup = await recording.setup(host().ctx);
    await cleanup();
    await cleanup();

    assert.equal(globalThis.pdkitBridgeCleanups, 1);
  });

  test('does not throw when a part of it does', async (t) => {
    const log = logOf(t);
    globalThis.pdkitBridgeCleanupThrows = true;
    t.after(() => {
      delete globalThis.pdkitBridgeCleanups;
      delete globalThis.pdkitBridgeCleanupThrows;
    });
    const recording = await copy(t, { 'opencode/bridge/hooks.js': RECORDING });

    const cleanup = await recording.setup(host().ctx);
    await cleanup();

    assert.deepEqual(log(), ['opencode-pdkit: cleanup failed: cleanup is broken']);
  });
});
