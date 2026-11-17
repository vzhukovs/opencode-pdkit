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

// The plugin's wiring, end to end: every event of the hook table is
// registered, and reaches the module the table names.
//
// lib/hooks/events.js lists pdkit's hook events and the module that runs each;
// the bridge stands each one on Open Code's points (WIRING in
// opencode/bridge/hooks.js), and setup() registers them. A test of a handler
// calls it, and passes as it does whether the plugin ever registered its hook
// or not — the lesson of the receipt gate that sat for four months on an event
// subagents never raise, with every test green. The bridge's tests each run
// one hook, through the point they expect it on.
//
// Here the table is held to all of them at once. The plugin is loaded, whole,
// into a stand-in for Open Code, and each callback setup() registered is
// called as the host calls it, with a call of a kind its hooks look at: what
// runs is the bridge, the runner and a node process running bin/pdkit, in a
// copy of the plugin whose handler modules do nothing but write down that
// they ran, for which event, and on what payload. A hook has a module when the
// one that ran is the one the table names; it is registered when a call to
// each point WIRING names for it runs it, and no call elsewhere does.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { FAIL_CLOSED, HOOK_HANDLERS } from '../lib/hooks/events.js';
import { WIRING } from '../opencode/bridge/hooks.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * What Claude Code ran each event on (hooks/hooks.json of 0.15.0): the host's
 * event, and the tools its matcher named. The bridge builds the payload of
 * that event, for those tools, which is what the handlers read.
 */
const HOST_EVENTS = {
  'pre-bash': ['PreToolUse', ['Bash']],
  'pre-write': ['PreToolUse', ['Write', 'Edit']],
  'post-write': ['PostToolUse', ['Write', 'Edit']],
  'post-claim': ['PostToolUse', ['Write', 'Edit']],
  'post-bash': ['PostToolUse', ['Bash']],
  'post-read': ['PostToolUse', ['Read', 'Grep']],
  'subagent-stop': ['SubagentStop', [undefined]],
  'session-start': ['SessionStart', [undefined]],
  'pre-compact': ['PreCompact', [undefined]],
  'prompt-submit': ['UserPromptSubmit', [undefined]],
};

/**
 * What setup() registers that is not a point of a hook event: the shell
 * environment, which puts `pdkit` on PATH (opencode/environment.js); the
 * answer that keeps the plugin's own files readable (opencode/access.js); the
 * registrars of agents, commands and skills, and the tools taken out of the
 * agents' requests (opencode/agents.js); and the bridge's watch on runs that
 * fail or are interrupted, which keeps what subagent-stop remembers right and
 * runs no hook. One registration each: a point can carry a hook's callback
 * and one of these both, as a compaction does.
 */
const NOT_A_HOOK = [
  'shell create.before',
  'permission evaluate',
  'session context',
  'session compaction',
  'session generate',
  'agent transform',
  'command transform',
  'skill transform',
  'event session.execution.failed',
  'event session.execution.interrupted',
];

/** The registrations of `order` that stand for a hook: all but one of each NOT_A_HOOK names. */
function hooksOf(order) {
  const rest = [...order];
  for (const name of NOT_A_HOOK) {
    const at = rest.lastIndexOf(name);
    if (at !== -1) rest.splice(at, 1);
  }
  return rest;
}

const PARENT = 'ses_parent';
const CHILD = 'ses_child';
const NEW = 'ses_new';
const RAN = 'ses_ran';
const FORKED = 'ses_forked';

/**
 * A call as a hook point's callback receives it: a tool call (before it runs,
 * or after with `after`), a session's prompt, stop, fork or compaction, or an
 * event on a stream.
 */
const tool = (name, input, after) => ({ tool: name, sessionID: RAN, agent: 'build', messageID: 'msg_1', id: 'call_1', input, ...after });
const ran = (output, text) => ({ status: 'completed', result: { output, content: [{ type: 'text', text }] } });
const prompt = (sessionID, metadata = {}) => ({ sessionID, messageID: 'msg_1', prompt: { text: 'Go on.' }, metadata, delivery: 'steer' });

/**
 * One call for each event at each point the table names for it, of a kind the
 * event's hook looks at (opencode/bridge/payload.js filters the rest out
 * before a run), and the events that run on it, in any order.
 */
const CALLS = [
  { point: 'tool execute.before', what: 'a shell command', event: () => tool('shell', { command: 'git status' }), runs: ['pre-bash'] },
  // §13 DV5: every call that carries a command, not only the shell tool's.
  { point: 'tool execute.before', what: "another tool's command", event: () => tool('example_exec', { command: 'git status' }), runs: ['pre-bash'] },
  { point: 'tool execute.before', what: 'a write', event: () => tool('write', { path: 'a.ts', content: 'a' }), runs: ['pre-write'] },
  { point: 'tool execute.after', what: 'a write that ran', event: () => tool('write', { path: 'a.ts', content: 'a' }, ran({}, 'Wrote file successfully.')), runs: ['post-write'] },
  // post-claim looks at markdown alone.
  {
    point: 'tool execute.after',
    what: 'a write of markdown that ran',
    event: () => tool('write', { path: 'notes.md', content: 'The fix is in lib/a.ts.' }, ran({}, 'Wrote file successfully.')),
    runs: ['post-write', 'post-claim'],
  },
  // post-bash looks at a shell command that exited 0 (F264).
  { point: 'tool execute.after', what: 'a shell command that exited 0', event: () => tool('shell', { command: 'ls' }, ran({ output: 'a.ts\n', exitCode: 0 }, 'a.ts\n')), runs: ['post-bash'] },
  // post-read looks at a window: here a page from line 5 to the end of the
  // file, which needs no file on disk (F265).
  {
    point: 'tool execute.after',
    what: 'a read of a page to the end of a file',
    event: () =>
      tool('read', { path: 'a.ts', offset: 5 }, ran({ type: 'text-page', content: 'a\nb', mime: 'video/mp2t', offset: 5, truncated: false }, 'Read file a.ts, lines 5-6')),
    runs: ['post-read'],
  },
  { point: 'session experimental.idle', what: "a subagent's stop", event: () => ({ sessionID: CHILD }), runs: ['subagent-stop'] },
  // session-start looks at a session's first prompt (F270); prompt-submit at a
  // prompt a pdkit command labeled as its own (D6).
  { point: 'session prompt', what: "a session's first prompt", event: () => prompt(NEW), runs: ['session-start'] },
  {
    point: 'session prompt',
    what: "a pdkit command's prompt",
    event: () => prompt(RAN, { source: 'opencode-pdkit', command: 'pd:preflight', arguments: '18248' }),
    runs: ['prompt-submit'],
  },
  { point: 'session fork', what: 'a fork', event: () => ({ sessionID: FORKED }), runs: ['session-start'] },
  {
    point: 'event session.compaction.ended',
    what: 'a compaction that ended',
    event: () => ({ type: 'session.compaction.ended', data: { sessionID: RAN, reason: 'manual' } }),
    runs: ['session-start'],
  },
  { point: 'session compaction', what: 'a compaction', event: () => ({ sessionID: RAN, model: {}, system: [], messages: [], options: {}, agent: 'compaction', tools: {} }), runs: ['pre-compact'] },
];

/**
 * A handler module that only writes down that it ran: which module, for which
 * event, and the host's event and tool its payload names. Allows; says
 * nothing.
 */
const stub = (log, module) => `import { appendFileSync } from 'node:fs';

export async function handle(payload, { event }) {
  appendFileSync(${JSON.stringify(log)}, \`\${JSON.stringify({ module: ${JSON.stringify(module)}, event, host: payload?.hook_event_name, tool: payload?.tool_name })}\\n\`);
  return { block: false };
}
`;

/**
 * An event stream as ctx.event.subscribe gives one: an async iterable, ended
 * by the signal it was given. `push` sends it an event of a type it asked for.
 */
function stream(options) {
  const queue = [];
  let wake = () => {};
  const signal = options?.signal;
  signal?.addEventListener('abort', () => wake(), { once: true });
  return {
    push: (event) => {
      if (!options?.types || options.types.includes(event.type)) queue.push(event);
      wake();
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            while (queue.length === 0) {
              if (signal?.aborted) return { done: true, value: undefined };
              await new Promise((resolve) => (wake = resolve));
            }
            return { done: false, value: queue.shift() };
          },
        };
      },
    },
  };
}

/**
 * A stand-in for setup()'s context, in `directory`: every registration is
 * recorded, in order, under the name WIRING gives its point — `<domain>
 * <hook>`, `<domain> transform`, `event <type>` for each type of a stream —
 * with its callback; the sessions are the ones the calls name.
 */
function host(directory) {
  const order = [];
  const callbacks = new Map();
  const streams = new Map();
  const registered = { dispose: async () => {} };
  const record = (name, callback) => {
    order.push(name);
    callbacks.set(name, [...(callbacks.get(name) ?? []), callback]);
    return registered;
  };
  const hooks = (domain) => ({ hook: async (name, callback) => record(`${domain} ${name}`, callback) });
  const transform = (domain) => ({ transform: async (callback) => record(`${domain} transform`, callback) });

  const at = { directory };
  const fresh = (id, more) => ({ id, projectID: 'global', time: { created: 1794850025467, updated: 1794850025472 }, location: at, ...more });
  const sessions = {
    [PARENT]: fresh(PARENT, { outcome: 'succeeded', time: { created: 1, updated: 4, busy: 2, idle: 3 } }),
    [CHILD]: fresh(CHILD, { parentID: PARENT, agent: 'pd-scout', outcome: 'succeeded', time: { created: 1, updated: 4, busy: 2, idle: 3 } }),
    [NEW]: fresh(NEW),
    [RAN]: fresh(RAN, { outcome: 'succeeded', time: { created: 1, updated: 4, busy: 2, idle: 3 } }),
    [FORKED]: fresh(FORKED, { fork: { sessionID: RAN, boundary: { type: 'through', messageID: 'msg_1' } } }),
  };

  const ctx = {
    app: { name: 'cli', version: '2.3.0', channel: 'latest' },
    location: { directory, project: { id: 'global', directory, canonical: directory } },
    tool: hooks('tool'),
    session: {
      ...hooks('session'),
      get: async ({ sessionID }) => {
        if (!Object.hasOwn(sessions, sessionID)) throw new Error(`Session not found: ${sessionID}`);
        return sessions[sessionID];
      },
      instructions: { entry: { put: async () => {}, remove: async () => {}, list: async () => [] } },
    },
    event: {
      subscribe: (options) => {
        const opened = stream(options);
        for (const type of options?.types ?? []) {
          record(`event ${type}`, opened.push);
          streams.set(type, [...(streams.get(type) ?? []), opened.push]);
        }
        return opened.iterable;
      },
    },
    shell: hooks('shell'),
    permission: hooks('permission'),
    agent: transform('agent'),
    command: transform('command'),
    skill: transform('skill'),
  };
  return { ctx, order, callbacks: (name) => callbacks.get(name) ?? [] };
}

/** The points WIRING names for an event, with whether the entry point registers it. */
const rowsOf = (event) => (Object.hasOwn(WIRING, event) ? WIRING[event] : []);

describe('every event of the table is registered and has a module', () => {
  let dir;
  let log;
  let stand;
  let cleanup;
  /** @type {Map<object, {callbacks: number, returned: unknown[], ran: Array<{module: string, event: string, host?: string, tool?: string}>}>} */
  const observed = new Map();

  /** The lines the stub handlers wrote, all of them so far. */
  const lines = async () =>
    (await readFile(log, 'utf8').catch(() => ''))
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line));

  /**
   * Call every callback on a point as Open Code does, one after another in
   * the order they were registered: how many there were, what each gave back,
   * and what the handlers wrote. What stands on a stream is not waited on by
   * the bridge (a compaction is summarized on its own), so its lines are
   * waited for.
   */
  const drive = async (call) => {
    const before = (await lines()).length;
    const callbacks = stand.callbacks(call.point);
    const returned = [];
    for (const callback of callbacks) returned.push(await callback(call.event()));
    if (callbacks.length > 0 && call.point.startsWith('event ')) {
      const deadline = Date.now() + 10_000;
      while ((await lines()).length - before < call.runs.length && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    return { callbacks: callbacks.length, returned, ran: (await lines()).slice(before) };
  };

  before(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-wiring-')));
    log = join(dir, 'ran.jsonl');
    for (const entry of ['opencode', 'lib', 'bin', 'defaults', 'agents', 'skills', 'package.json']) {
      await cp(join(ROOT, entry), join(dir, 'plugin', entry), { recursive: true });
    }
    for (const module of new Set(Object.values(HOOK_HANDLERS))) {
      await writeFile(join(dir, 'plugin', 'lib', 'hooks', module), stub(log, module));
    }

    const work = join(dir, 'work');
    await mkdir(work);
    stand = host(work);
    const plugin = (await import(pathToFileURL(join(dir, 'plugin', 'opencode', 'server.js')).href)).default;
    cleanup = await plugin.setup(stand.ctx);

    for (const call of CALLS) observed.set(call, await drive(call));
  });

  after(async () => {
    await cleanup?.();
    await rm(dir, { recursive: true, force: true });
  });

  test('setup registers each point the table names, and no other', () => {
    const named = new Set(Object.values(WIRING).flatMap((rows) => rows.map((row) => row.point)));
    const registered = hooksOf(stand.order);

    assert.deepEqual(new Set(registered), named);
    // One callback on each point, the gate's on execute.before aside: the
    // entry point registers it first, and the bridge one more behind it.
    for (const point of named) {
      const expected = point === 'tool execute.before' ? 2 : 1;
      assert.equal(registered.filter((name) => name === point).length, expected, `${point} is registered ${registered.filter((name) => name === point).length} times`);
    }
    assert.equal(stand.order[0], 'tool execute.before', 'the gate is not the first thing registered');
  });

  for (const call of CALLS) {
    test(`${call.point}, on ${call.what}: ${call.runs.join(' and ')}, from the module the table names, on the payload Claude Code sent`, () => {
      const { callbacks, returned, ran } = observed.get(call);

      assert.ok(callbacks > 0, `nothing is registered on ${call.point}`);
      assert.deepEqual(returned, Array(callbacks).fill(undefined), `a callback on ${call.point} gives the host something back`);
      assert.deepEqual(ran.map((entry) => entry.event).sort(), [...call.runs].sort());
      for (const entry of ran) {
        assert.equal(entry.module, HOOK_HANDLERS[entry.event], `${entry.event} ran ${entry.module}`);
        const [hostEvent, tools] = HOST_EVENTS[entry.event];
        assert.equal(entry.host, hostEvent, `${entry.event} ran on the payload of ${entry.host}`);
        assert.ok(tools.includes(entry.tool), `${entry.event} ran on the payload of ${entry.host} ${entry.tool}`);
      }
    });
  }

  // The check itself. Each event of HOOK_HANDLERS ran at every point WIRING
  // names for it, and at no other: a point the table names that runs nothing
  // for it, or a point that runs it the table does not name, is a pair in one
  // list and not in the other.
  test('each event runs at every point the table names for it, and nowhere else', () => {
    const named = Object.keys(HOOK_HANDLERS).flatMap((event) => rowsOf(event).map((row) => `${event} @ ${row.point}`));
    const seen = [...observed].flatMap(([call, { ran }]) => ran.map((entry) => `${entry.event} @ ${call.point}`));

    assert.ok(Object.keys(HOOK_HANDLERS).every((event) => rowsOf(event).length > 0), 'an event has no point in Open Code');
    assert.deepEqual([...new Set(seen)].sort(), [...new Set(named)].sort());
    assert.deepEqual([...new Set(seen.map((pair) => pair.split(' @ ')[0]))].sort(), Object.keys(HOOK_HANDLERS).sort());
  });

  // An event that fails closed must be registered where nothing can fail
  // before it: by the entry point, before it loads the bridge — so its row is
  // the entry point's, and register() leaves it be. A row of the entry
  // point's for any other event would be registered by no one.
  test('an event that fails closed is the entry point’s, and runs from the first callback registered', async () => {
    for (const event of Object.keys(HOOK_HANDLERS)) {
      const entry = rowsOf(event).filter((row) => row.entry === true);
      assert.deepEqual(entry.length > 0, FAIL_CLOSED.includes(event), `${event}: the entry point's rows are ${JSON.stringify(entry)}`);
      if (FAIL_CLOSED.includes(event)) assert.deepEqual(entry, rowsOf(event), `${event} also stands where the bridge registers it`);
    }

    const [gate] = stand.callbacks('tool execute.before');
    const before = (await lines()).length;
    await gate(tool('shell', { command: 'git status' }));
    assert.equal(stand.order[0], 'tool execute.before');
    assert.deepEqual((await lines()).slice(before).map((entry) => entry.event), FAIL_CLOSED);
  });
});

// register() goes through the table, not through the bridge's own: an event
// added to lib/hooks/events.js and given no point in Open Code is a hook that
// fails to register, and says so, beside every other one that did. So is a
// row that names a point the bridge has no way to stand on.
describe('an event of the table the bridge cannot place', () => {
  /**
   * A copy of the plugin, one file of it changed by `edit`, set up on a
   * stand-in: what it registered, and what it wrote to the server's log.
   */
  async function loadedWith(t, file, edit) {
    const dir = await mkdtemp(join(tmpdir(), 'pdkit-wiring-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    for (const entry of ['opencode', 'lib', 'bin', 'defaults', 'agents', 'skills', 'package.json']) {
      await cp(join(ROOT, entry), join(dir, entry), { recursive: true });
    }
    const source = await readFile(join(dir, file), 'utf8');
    const edited = edit(source);
    assert.notEqual(edited, source, `${file} is not as the test expects`);
    await writeFile(join(dir, file), edited);
    const error = t.mock.method(console, 'error', () => {});
    const stand = host(dir);

    const plugin = (await import(pathToFileURL(join(dir, 'opencode', 'server.js')).href)).default;
    const cleanup = await plugin.setup(stand.ctx);
    t.after(() => cleanup?.());
    return { registered: hooksOf(stand.order), log: error.mock.calls.map((call) => call.arguments.join(' ')) };
  }

  const named = () => new Set(Object.values(WIRING).flatMap((rows) => rows.map((row) => row.point)));

  test('one with no point is a registration that fails, reported, and the rest are registered', async (t) => {
    const row = "  'prompt-submit': 'prompt-submit.js',\n";
    const { registered, log } = await loadedWith(t, 'lib/hooks/events.js', (source) => source.replace(row, `${row}  'pre-fetch': 'owns.js',\n`));

    assert.deepEqual(log, ['opencode-pdkit: cannot register its hooks (the "pre-fetch" hook has no point in Open Code); the gate and the rest are unaffected']);
    assert.deepEqual(new Set(registered), named());
  });

  test('one on a point the bridge cannot stand on is too', async (t) => {
    const row = "  'pre-compact': rows({ point: COMPACTION, run: 'preCompact' }),";
    const { registered, log } = await loadedWith(t, 'opencode/bridge/hooks.js', (source) =>
      source.replace(row, "  'pre-compact': rows({ point: 'session nowhere', run: 'preCompact' }),"),
    );

    assert.deepEqual(log, ['opencode-pdkit: cannot register its hooks (the "pre-compact" hook cannot stand on session nowhere); the gate and the rest are unaffected']);
    assert.deepEqual(new Set(registered), new Set([...named()].filter((point) => point !== 'session compaction')));
  });
});
