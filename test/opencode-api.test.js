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

// Tests for lib/opencode-api.js: asking the running Open Code server about a
// directory, and reading its answers.
//
// Nothing here talks to a server. `opencode api` is replaced by a stand-in
// that records its arguments and replies as the CLI of Open Code 2.3.0 does,
// and the answers are written out in the shapes that version gives.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DIRECTORY_HEADER,
  NOT_RUNNING,
  agentModels,
  agentRules,
  askRunning,
  catalog,
  commands,
  configDirectories,
  configRules,
  configuredAgents,
  decision,
  expandHome,
  get,
  mcpServers,
  mcpStatuses,
  pluginEntry,
  plugins,
  serviceStatus,
  skills,
  takenBy,
  toolPrefix,
  turnedOff,
  waitFor,
  wildcard,
} from '../lib/opencode-api.js';

/** An execFile stand-in that replies once, as given, and keeps what it was asked to run. */
function exec(reply) {
  const calls = [];
  const runner = (command, args, options, callback) => {
    calls.push({ command, args, options });
    setImmediate(() => callback(reply.error ?? null, reply.stdout ?? '', reply.stderr ?? ''));
  };
  return { runner, calls };
}

describe('asking the server', () => {
  test('is `opencode api GET <path>` about the directory, by header', async () => {
    const { runner, calls } = exec({ stdout: '{"location":{"directory":"/fork"},"data":[]}\n' });
    const answer = await get('/api/mcp', { directory: '/fork', exec: runner });

    assert.deepEqual(answer, { ok: true, data: { location: { directory: '/fork' }, data: [] } });
    assert.equal(calls[0].command, 'opencode');
    assert.deepEqual(calls[0].args, ['api', 'GET', '/api/mcp', '-H', `${DIRECTORY_HEADER}:/fork`]);
    assert.equal(DIRECTORY_HEADER, 'x-opencode-directory');
  });

  test('no opencode is said in those words', async () => {
    const error = Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' });
    const { runner } = exec({ error });

    assert.deepEqual(await get('/api/mcp', { directory: '/fork', exec: runner }), { ok: false, error: 'opencode: not found' });
  });

  // `opencode api` prints the body on stdout either way and puts the status on
  // stderr, exiting 1.
  test('a status other than 2xx is the line the CLI put on stderr', async () => {
    const error = Object.assign(new Error('Command failed: opencode api GET /api/mcp'), { code: 1 });
    const { runner } = exec({ error, stdout: '{"_tag":"Boom"}', stderr: '\nHTTP 500 Internal Server Error\n' });

    assert.deepEqual(await get('/api/mcp', { directory: '/fork', exec: runner }), {
      ok: false,
      error: 'opencode api GET /api/mcp: HTTP 500 Internal Server Error',
    });
  });

  test('an answer that is not JSON is not an answer', async () => {
    const { runner } = exec({ stdout: 'No MCP servers configured\n' });
    const answer = await get('/api/mcp', { directory: '/fork', exec: runner });

    assert.equal(answer.ok, false);
    assert.match(answer.error, /not JSON: No MCP servers configured/);
  });
});

describe('waiting for a directory the server is still loading', () => {
  function clock() {
    let time = 0;
    return { now: () => time, pause: async (ms) => void (time += ms) };
  }
  function answers(...list) {
    let index = 0;
    const ask = async () => list[Math.min(index++, list.length - 1)];
    return { ask, count: () => index };
  }

  test('asks again until the answer is the one waited for', async () => {
    const { ask, count } = answers({ ok: true, data: [] }, { ok: true, data: [] }, { ok: true, data: ['x'] });
    const result = await waitFor(ask, (data) => data.length > 0, { wait: 5000, ...clock() });

    assert.deepEqual(result, { ok: true, data: ['x'], settled: true });
    assert.equal(count(), 3);
  });

  test('gives back the last answer, unsettled, when the time is up', async () => {
    const { ask, count } = answers({ ok: true, data: [] });
    const result = await waitFor(ask, (data) => data.length > 0, { wait: 1000, ...clock() });

    assert.deepEqual(result, { ok: true, data: [], settled: false });
    assert.equal(count(), 5, 'at 0, 250, 500, 750 and 1000 ms');
  });

  test('a question that failed is not asked again', async () => {
    const { ask, count } = answers({ ok: false, error: 'opencode: not found' });
    const result = await waitFor(ask, () => true, { wait: 5000, ...clock() });

    assert.deepEqual(result, { ok: false, error: 'opencode: not found', settled: false });
    assert.equal(count(), 1);
  });
});

/**
 * An execFile stand-in for the two commands the module runs: `opencode service
 * status` gets `status`, `opencode api` gets `api`. It keeps every call.
 */
function cli({ status, api = { stdout: '[]' } }) {
  const calls = [];
  const runner = (command, args, options, callback) => {
    calls.push({ command, args, options });
    const reply = args[0] === 'service' ? status : api;
    setImmediate(() => callback(reply.error ?? null, reply.stdout ?? '', reply.stderr ?? ''));
  };
  return { runner, calls };
}

// `opencode api` starts the background service when it is not running, and a
// service that starts takes over every session another Open Code server is in
// the middle of a turn in (F328, F331, F332). `opencode service status` only
// looks: it prints the service's URL, or `stopped`.
describe('whether the background service runs', () => {
  test('is `opencode service status`: a URL is a service that runs', async () => {
    const { runner, calls } = cli({ status: { stdout: 'http://127.0.0.1:4096\n' } });

    assert.deepEqual(await serviceStatus({ exec: runner }), { ok: true, running: true, url: 'http://127.0.0.1:4096' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'opencode');
    assert.deepEqual(calls[0].args, ['service', 'status']);
  });

  test('stopped is a service that does not run', async () => {
    const { runner } = cli({ status: { stdout: 'stopped\n' } });

    assert.deepEqual(await serviceStatus({ exec: runner }), { ok: true, running: false });
  });

  test('no opencode is said in those words', async () => {
    const error = Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' });
    const { runner } = cli({ status: { error } });

    assert.deepEqual(await serviceStatus({ exec: runner }), { ok: false, error: 'opencode: not found' });
  });

  test('a failure is the first line the CLI put on stderr', async () => {
    const error = Object.assign(new Error('Command failed: opencode service status'), { code: 1 });
    const { runner } = cli({ status: { error, stderr: '\nError: Failed to read service config\n    at …\n' } });

    assert.deepEqual(await serviceStatus({ exec: runner }), { ok: false, error: 'opencode service status: Error: Failed to read service config' });
  });

  test('anything else it prints is not an answer', async () => {
    const { runner } = cli({ status: { stdout: 'starting\n' } });

    assert.deepEqual(await serviceStatus({ exec: runner }), {
      ok: false,
      error: 'opencode service status printed "starting", neither "stopped" nor a URL',
    });
  });
});

describe('asking only a background service that runs', () => {
  test('a stopped service is neither asked nor started: each question fails with why, after one look', async () => {
    const { runner, calls } = cli({ status: { stdout: 'stopped\n' } });
    const ask = askRunning({ directory: '/fork', exec: runner });

    assert.deepEqual(await ask('/api/plugin'), { ok: false, error: NOT_RUNNING });
    assert.deepEqual(await ask('/api/config'), { ok: false, error: NOT_RUNNING });
    assert.deepEqual(
      calls.map((call) => call.args),
      [['service', 'status']],
    );
  });

  test('says why it does not ask, and how to get an answer', () => {
    assert.match(NOT_RUNNING, /^Open Code’s background service is not running/);
    assert.match(NOT_RUNNING, /does not start it/);
    assert.match(NOT_RUNNING, /takes over/);
    assert.match(NOT_RUNNING, /opencode service start/);
    assert.match(NOT_RUNNING, /run pdkit doctor again$/);
  });

  test('a service that runs is asked, and looked at once', async () => {
    const { runner, calls } = cli({ status: { stdout: 'http://127.0.0.1:4096\n' }, api: { stdout: '{"data":[]}' } });
    const ask = askRunning({ directory: '/fork', exec: runner });

    assert.deepEqual(await ask('/api/plugin'), { ok: true, data: { data: [] } });
    assert.deepEqual(await ask('/api/mcp'), { ok: true, data: { data: [] } });
    assert.deepEqual(
      calls.map((call) => call.args),
      [
        ['service', 'status'],
        ['api', 'GET', '/api/plugin', '-H', `${DIRECTORY_HEADER}:/fork`],
        ['api', 'GET', '/api/mcp', '-H', `${DIRECTORY_HEADER}:/fork`],
      ],
    );
  });

  test('questions asked together look once', async () => {
    const { runner, calls } = cli({ status: { stdout: 'stopped\n' } });
    const ask = askRunning({ directory: '/fork', exec: runner });
    await Promise.all([ask('/api/config'), ask('/api/agent'), ask('/api/model')]);

    assert.equal(calls.length, 1);
  });

  test('when it cannot tell whether the service runs, it asks nothing, and says why', async () => {
    const error = Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' });
    const { runner, calls } = cli({ status: { error } });
    const ask = askRunning({ directory: '/fork', exec: runner });

    assert.deepEqual(await ask('/api/plugin'), { ok: false, error: 'opencode: not found' });
    assert.equal(calls.length, 1);
  });
});

describe('the MCP servers a config turns on', () => {
  const document = (servers) => ({ type: 'document', path: '/config/opencode.json', info: { mcp: { servers } } });

  // The command line matters, not just the name: a Playwright server without
  // `--cdp-endpoint` reads like one wired correctly by name alone.
  test('keeps the command line, and the URL of a remote server', () => {
    const servers = mcpServers([
      document({ playwright: { type: 'local', command: ['npx', '@playwright/mcp@latest', '--cdp-endpoint', 'http://127.0.0.1:9222'] } }),
      document({ context7: { type: 'remote', url: 'https://mcp.example.invalid/mcp' } }),
    ]);

    assert.deepEqual(servers.get('playwright'), { command: 'npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:9222' });
    assert.deepEqual(servers.get('context7'), { command: 'https://mcp.example.invalid/mcp' });
  });

  // Open Code takes a server whole from the last document that names it
  // (src/config/plugin/mcp.ts in 2.3.0): fields are not merged across documents.
  test('the last document that names a server decides it, whole', () => {
    const servers = mcpServers([
      document({ playwright: { type: 'local', command: ['npx', '@playwright/mcp@latest', '--cdp-endpoint', 'http://127.0.0.1:9222'] } }),
      document({ playwright: { type: 'local', command: ['npx', '@playwright/mcp@latest'] } }),
    ]);

    assert.deepEqual(servers.get('playwright'), { command: 'npx @playwright/mcp@latest' });
  });

  test('a server that document disables is not on; one it enables again is', () => {
    const off = mcpServers([
      document({ playwright: { type: 'local', command: ['a'] } }),
      document({ playwright: { type: 'local', command: ['a'], disabled: true } }),
    ]);
    const on = mcpServers([
      document({ playwright: { type: 'local', command: ['a'], disabled: true } }),
      document({ playwright: { type: 'local', command: ['b'], disabled: false } }),
    ]);

    assert.equal(off.has('playwright'), false);
    assert.deepEqual(on.get('playwright'), { command: 'b' });
  });

  test('reads documents only, and keeps no environment', () => {
    const servers = mcpServers([
      { type: 'directory', path: '/config', info: { mcp: { servers: { ghost: { type: 'local', command: ['x'] } } } } },
      document({ playwright: { type: 'local', command: ['a'], environment: { TOKEN: 'do-not-print-me' } } }),
    ]);

    assert.deepEqual([...servers.keys()], ['playwright']);
    assert.doesNotMatch(JSON.stringify([...servers]), /do-not-print-me|TOKEN/);
  });

  test('anything that is not a list of documents is no servers', () => {
    assert.equal(mcpServers({ location: {}, data: [] }).size, 0);
    assert.equal(mcpServers(undefined).size, 0);
  });
});

describe('what the server says each MCP server is doing', () => {
  test('a status by name, with the error when there is one', () => {
    const statuses = mcpStatuses({
      location: { directory: '/fork' },
      data: [
        { name: 'playwright', status: { status: 'connected' } },
        { name: 'broken', status: { status: 'failed', error: 'NotFound: ChildProcess.spawn (/nonexistent/server )' } },
        { name: 'off', status: { status: 'disabled' } },
      ],
    });

    assert.deepEqual(statuses.get('playwright'), { status: 'connected' });
    assert.deepEqual(statuses.get('broken'), { status: 'failed', error: 'NotFound: ChildProcess.spawn (/nonexistent/server )' });
    assert.deepEqual(statuses.get('off'), { status: 'disabled' });
  });

  test('a fresh directory’s empty list is an empty map', () => {
    assert.equal(mcpStatuses({ location: { directory: '/fork' }, data: [] }).size, 0);
  });
});

describe('the rules an agent ends up with', () => {
  const ANSWER = { location: { directory: '/fork' }, data: [{ id: 'pd-validator', permissions: [{ action: '*', resource: '*', effect: 'deny' }] }] };

  test('are the agent’s permissions; no agent is undefined', () => {
    assert.deepEqual(agentRules(ANSWER, 'pd-validator'), [{ action: '*', resource: '*', effect: 'deny' }]);
    assert.equal(agentRules(ANSWER, 'pd-auditor'), undefined);
  });
});

describe('Open Code’s names and rules', () => {
  test('a server’s tools are prefixed with its name, made safe as Open Code makes it', () => {
    assert.equal(toolPrefix('playwright'), 'playwright_');
    assert.equal(toolPrefix('my.server x'), 'my_server_x_');
  });

  // Wildcard.match in Open Code 2.3.0.
  test('a rule’s pattern: * is any run, ? is one character, the whole name fits', () => {
    assert.equal(wildcard('playwright_browser_navigate', 'playwright_*'), true);
    assert.equal(wildcard('playwright_browser_navigate', '*'), true);
    assert.equal(wildcard('playwright_browser_navigate', 'playwright_browser_navigat?'), true);
    assert.equal(wildcard('playwright_browser_navigate', 'playwright'), false);
    assert.equal(wildcard('playwright_browser_navigate', 'browser_*'), false);
    assert.equal(wildcard('a.b', 'a?b'), true);
    assert.equal(wildcard('axb', 'a.b'), false, 'a dot is a dot');
    assert.equal(wildcard('git', 'git *'), true, 'a trailing " *" also matches nothing');
  });

  test('a tool is taken by the last rule that fits it, when that rule denies on every resource', () => {
    const allow = { action: 'playwright_browser_navigate', resource: '*', effect: 'allow' };
    const denyAll = { action: '*', resource: '*', effect: 'deny' };
    const denyServer = { action: 'playwright_*', resource: '*', effect: 'deny' };

    assert.equal(takenBy('playwright_browser_navigate', [denyAll, allow]), undefined);
    assert.deepEqual(takenBy('playwright_browser_navigate', [denyAll, allow, denyServer]), denyServer);
    assert.equal(takenBy('playwright_browser_navigate', [denyAll, allow, denyServer, allow]), undefined);
    assert.equal(takenBy('playwright_browser_navigate', [allow, { action: 'playwright_*', resource: '/x/*', effect: 'deny' }]), undefined);
    assert.equal(takenBy('playwright_browser_navigate', []), undefined);
  });

  // evaluate in Open Code 2.3.0 (F341).
  test('a call is decided by the last rule whose action and resource both fit; with none, it is asked', () => {
    const rules = [
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'shell', resource: '*', effect: 'allow' },
      { action: 'shell', resource: 'git push *', effect: 'deny' },
      { action: 'edit', resource: '/x/*', effect: 'ask' },
    ];

    assert.deepEqual(decision(rules, 'shell', 'git status'), { effect: 'allow', index: 1 });
    assert.deepEqual(decision(rules, 'shell', 'git push origin'), { effect: 'deny', index: 2 });
    assert.deepEqual(decision(rules, 'edit', '/x/a.ts'), { effect: 'ask', index: 3 });
    assert.deepEqual(decision(rules, 'edit', '/y/a.ts'), { effect: 'deny', index: 0 });
    assert.deepEqual(decision(rules.slice(1), 'read', '/x'), { effect: 'ask', index: -1 });
  });

  // expandHome in Open Code 2.3.0 (F339): only the actions on a path.
  test('`~` and `$HOME` are spelled out in the rules of a path, and nowhere else', () => {
    const rule = (action, resource) => ({ action, resource, effect: 'allow' });

    assert.deepEqual(expandHome(rule('read', '~/x/*'), '/home/u'), rule('read', '/home/u/x/*'));
    assert.deepEqual(expandHome(rule('edit', '$HOME/x'), '/home/u'), rule('edit', '/home/u/x'));
    assert.deepEqual(expandHome(rule('external_directory', '~'), '/home/u'), rule('external_directory', '/home/u'));
    assert.deepEqual(expandHome(rule('read', '~/x'), 'C:\\Users\\u'), rule('read', 'C:\\Users\\u\\x'));
    assert.deepEqual(expandHome(rule('shell', '~/x'), '/home/u'), rule('shell', '~/x'));
    assert.deepEqual(expandHome(rule('read', '/a/~/x'), '/home/u'), rule('read', '/a/~/x'));
  });
});

// GET /api/config, as Open Code 2.3.0 answered it (research/T7.20-raw): the
// rules of the documents, as written, and the config directories, with
// nothing of the agent files in them (F339).
describe('the rules the config documents add to an agent', () => {
  const rule = (action, resource, effect) => ({ action, resource, effect });
  const DOCUMENTS = [
    {
      type: 'document',
      path: '/h/.config/opencode/opencode.json',
      info: {
        permissions: [rule('shell', 'g-top', 'allow'), rule('read', '~/x/*', 'allow')],
        agents: { 'pd-auditor': { permissions: [rule('shell', 'g-agent', 'allow')] }, 'pd-scout': { model: { providerID: 'p', model: 'm' } } },
      },
    },
    { type: 'directory', path: '/h/.config/opencode', info: {} },
    {
      type: 'document',
      path: '/fork/opencode.json',
      info: { permissions: [rule('shell', 'p-top', 'allow'), { action: 'shell' }], agents: { 'pd-auditor': { permissions: [rule('shell', 'p-agent', 'allow')] } } },
    },
    { type: 'directory', path: '/fork/.opencode', info: {} },
  ];

  test('are every document’s top-level permissions, then each one’s for the agent, in the order Open Code appends them', () => {
    assert.deepEqual(configRules(DOCUMENTS, 'pd-auditor', '/h'), [
      { rule: rule('shell', 'g-top', 'allow'), document: '/h/.config/opencode/opencode.json', key: 'permissions' },
      { rule: rule('read', '/h/x/*', 'allow'), document: '/h/.config/opencode/opencode.json', key: 'permissions' },
      { rule: rule('shell', 'p-top', 'allow'), document: '/fork/opencode.json', key: 'permissions' },
      { rule: rule('shell', 'g-agent', 'allow'), document: '/h/.config/opencode/opencode.json', key: 'agents.pd-auditor.permissions' },
      { rule: rule('shell', 'p-agent', 'allow'), document: '/fork/opencode.json', key: 'agents.pd-auditor.permissions' },
    ]);
  });

  test('an agent no document names gets the top-level ones alone; an answer that is not a list, none', () => {
    assert.deepEqual(
      configRules(DOCUMENTS, 'pd-scout', '/h').map((entry) => entry.key),
      ['permissions', 'permissions', 'permissions'],
    );
    assert.deepEqual(configRules(DOCUMENTS, 'constructor', '/h').length, 3);
    assert.deepEqual(configRules({ status: 500 }, 'pd-scout', '/h'), []);
  });

  test('the config directories are named, in order', () => {
    assert.deepEqual(configDirectories(DOCUMENTS), ['/h/.config/opencode', '/fork/.opencode']);
    assert.deepEqual(configDirectories(undefined), []);
  });
});

// GET /api/plugin, as Open Code 2.3.0 answered it (research/T7.6-raw): Open
// Code's own and the config's, in the order of their hooks; one that failed to
// load has no ID.
describe('the plugins the server runs for a directory', () => {
  test('each with where it comes from and its state, in order', () => {
    const answer = {
      location: { directory: '/fork' },
      data: [
        { id: 'opencode.tool.input.repair', source: { type: 'builtin' }, features: { server: true }, state: { status: 'active' } },
        { id: 'opencode-pdkit', source: { type: 'local', path: '/src/opencode-pdkit' }, features: { server: true }, state: { status: 'active' } },
        { id: 'opencode-pdkit', source: { type: 'package', target: 'opencode-pdkit', version: '0.16.0', outdated: true }, state: { status: 'active' } },
        { source: { type: 'local', path: '/src/broken' }, features: { server: true }, state: { status: 'failed', error: 'Plugin failed to load', ref: 'err_78288714' } },
        { id: null, source: { type: 'package', target: 'opencode-pdkit' }, state: { status: 'failed', error: 'Plugin failed to load', ref: 'err_a81b3f27' } },
      ],
    };

    assert.deepEqual(plugins(answer), [
      { id: 'opencode.tool.input.repair', builtin: true, source: '', status: 'active' },
      { id: 'opencode-pdkit', builtin: false, source: '/src/opencode-pdkit', status: 'active' },
      { id: 'opencode-pdkit', builtin: false, source: 'opencode-pdkit', version: '0.16.0', outdated: true, status: 'active' },
      { builtin: false, source: '/src/broken', status: 'failed', error: 'Plugin failed to load', ref: 'err_78288714' },
      { builtin: false, source: 'opencode-pdkit', status: 'failed', error: 'Plugin failed to load', ref: 'err_a81b3f27' },
    ]);
  });

  test('a directory still loading has none', () => {
    for (const answer of [{ location: { directory: '/fork' }, data: [] }, {}, null, { data: 'x' }]) {
      assert.deepEqual(plugins(answer), [], JSON.stringify(answer));
    }
  });
});

describe('where a config turns a plugin off', () => {
  const doc = (path, info) => ({ type: 'document', path, info });

  test('a directive with its ID, in any document; another ID is not it', () => {
    const off = turnedOff(
      [doc('/g.json', { plugins: ['/src/opencode-pdkit', '-other'] }), { type: 'directory', path: '/g', info: { plugins: ['-opencode-pdkit'] } }, doc('/p.json', { plugins: ['-opencode-pdkit'] })],
      'opencode-pdkit',
    );

    assert.deepEqual(off.removed, ['/p.json']);
    assert.deepEqual(off.added, [{ document: '/g.json', target: '/src/opencode-pdkit' }]);
    assert.deepEqual(off.denied, []);
  });

  test('an entry that adds it by name: the package, with a version, a tarball, a directory, an object', () => {
    const { added } = turnedOff(
      [
        doc('/g.json', {
          plugins: ['opencode-pdkit', 'opencode-pdkit@0.16.0', 'file:/pack/opencode-pdkit-0.16.0.tgz', '/src/opencode-pdkit', { package: 'opencode-pdkit', options: {} }, 'other', { package: 7 }],
        }),
      ],
      'opencode-pdkit',
    );

    assert.deepEqual(
      added.map((entry) => entry.target),
      ['opencode-pdkit', 'opencode-pdkit@0.16.0', 'file:/pack/opencode-pdkit-0.16.0.tgz', '/src/opencode-pdkit', 'opencode-pdkit'],
    );
  });

  test('a policy only where its last word on an entry is deny', () => {
    const deny = (resource) => ({ action: 'plugin.use', resource, effect: 'deny' });
    const allow = (resource) => ({ action: 'plugin.use', resource, effect: 'allow' });
    const { denied } = turnedOff(
      [
        doc('/g.json', { plugins: ['opencode-pdkit@1.0.0', '/src/opencode-pdkit'], policies: [deny('opencode-pdkit'), { action: 'tool.use', resource: '*', effect: 'deny' }] }),
        doc('/p.json', { policies: [allow('opencode-pdkit'), deny('/src/*')] }),
      ],
      'opencode-pdkit',
    );

    // The package: the global document's deny is read last, so it holds. The
    // path: only the project document names it.
    assert.deepEqual(denied, [
      { document: '/g.json', resource: 'opencode-pdkit', target: 'opencode-pdkit@1.0.0' },
      { document: '/p.json', resource: '/src/*', target: '/src/opencode-pdkit' },
    ]);
  });

  test('nothing to read is nothing found', () => {
    for (const documents of [undefined, null, {}, [], [doc('/g.json', {})], [doc('/g.json', { plugins: 'opencode-pdkit', policies: 'x' })]]) {
      assert.deepEqual(turnedOff(documents, 'opencode-pdkit'), { removed: [], denied: [], added: [] }, JSON.stringify(documents));
    }
  });
});

// The shapes are Open Code 2.3.0's, as a private server gave them (F228,
// F315, F316): an agent's model is `{ id, providerID, variant }`; in a config
// document `agents.<id>.model` is what Open Code read, `{ providerID, model,
// variant }`, and an entry whose model it could not read is not there at all; a
// catalog entry carries its provider's settings.
describe('the models the server reports', () => {
  const doc = (path, info) => ({ type: 'document', path, info });

  test('each agent with the model it ends up with, or null for none', () => {
    const answer = {
      location: { directory: '/fork' },
      data: [
        { id: 'pd-scout', model: { id: 'alpha', providerID: 'mock', variant: 'high' }, permissions: [] },
        { id: 'pd-slicer', model: { id: 'sonnet', providerID: 'claude-agent' } },
        { id: 'build' },
        { name: 'no id' },
      ],
    };
    assert.deepEqual(
      [...agentModels(answer)],
      [
        ['pd-scout', { providerID: 'mock', id: 'alpha', variant: 'high' }],
        ['pd-slicer', { providerID: 'claude-agent', id: 'sonnet' }],
        ['build', null],
      ],
    );
    for (const nothing of [undefined, null, {}, { data: 'x' }]) assert.equal(agentModels(nothing).size, 0);
  });

  test('agents.<id> of the config: the last document that sets a model, or disables one, wins', () => {
    const agents = configuredAgents([
      doc('/g.json', { agents: { 'pd-review-synth': { model: { providerID: 'mock', model: 'beta', variant: 'low' } }, 'pd-slicer': { disabled: true } } }),
      { type: 'directory', path: '/g', info: { agents: { 'pd-review-synth': { model: { providerID: 'x', model: 'y' } } } } },
      doc('/p.json', { agents: { 'pd-review-synth': { model: { providerID: 'mock', model: 'alpha' } }, 'pd-scout': { description: 'mine' } } }),
    ]);
    assert.deepEqual(agents.get('pd-review-synth'), { model: { ref: { providerID: 'mock', id: 'alpha' }, document: '/p.json' } });
    assert.deepEqual(agents.get('pd-slicer'), { disabled: '/g.json' });
    assert.deepEqual(agents.get('pd-scout'), {});
    for (const nothing of [undefined, null, {}, [doc('/g.json', {})], [doc('/g.json', { agents: { a: { model: 'mock/alpha' } } })]]) {
      assert.equal(configuredAgents(nothing).get('a')?.model, undefined, JSON.stringify(nothing));
    }
  });

  test('the catalog keeps what the check reads, and nothing of the provider’s settings', () => {
    const models = catalog({
      location: { directory: '/fork' },
      data: [
        { id: 'alpha', modelID: 'alpha', providerID: 'mock', enabled: true, status: 'active', variants: [{ id: 'low', body: { x: 1 } }, { id: 'high' }, {}], settings: { apiKey: 'sk-not-a-key' } },
        { id: 'opus', modelID: 'claude-opus-5-5', providerID: 'claude-agent', enabled: false, settings: { apiKey: 'sk-not-a-key' } },
        { id: 'no-provider' },
      ],
    });
    assert.deepEqual(models, [
      { providerID: 'mock', id: 'alpha', modelID: 'alpha', enabled: true, variants: [{ id: 'low' }, { id: 'high' }] },
      { providerID: 'claude-agent', id: 'opus', modelID: 'claude-opus-5-5', enabled: false, variants: [] },
    ]);
    assert.doesNotMatch(JSON.stringify(models), /sk-not-a-key/);
  });
});

// Whose options a plugin is handed when more than one entry adds it: the first
// that loads it, unless a later one names the same target — then that one,
// with its options; a later one by the plugin's ID only turns it on, and one
// with another target is a duplicate Open Code refuses
// (src/plugin/supervisor.ts; F317).
describe('the entry whose options reach the plugin', () => {
  const doc = (path, info) => ({ type: 'document', path, info });
  const ID = 'opencode-pdkit';

  test('one entry: its options, its document, its target', () => {
    const options = { models: { 'pd-scout': 'mock/alpha#high' } };
    assert.deepEqual(pluginEntry([doc('/g/opencode.json', { plugins: ['other', { package: '/src/opencode-pdkit', options }] })], ID), {
      entry: { document: '/g/opencode.json', target: '/src/opencode-pdkit', options },
      unread: [],
    });
  });

  test('a plain string entry has no options; a directive and another plugin are not entries of it', () => {
    assert.deepEqual(pluginEntry([doc('/g.json', { plugins: ['-opencode-pdkit', 'other', 'opencode-pdkit@0.16.0'] })], ID), {
      entry: { document: '/g.json', target: 'opencode-pdkit@0.16.0', options: undefined },
      unread: [],
    });
    for (const documents of [undefined, null, {}, [], [doc('/g.json', {})], [doc('/g.json', { plugins: 'opencode-pdkit' })], [{ type: 'directory', path: '/g', info: { plugins: ['opencode-pdkit'] } }]]) {
      assert.deepEqual(pluginEntry(documents, ID), { unread: [] }, JSON.stringify(documents));
    }
  });

  test('the same target later: the later one is read, and the earlier one’s options are not', () => {
    const { entry, unread } = pluginEntry(
      [doc('/g.json', { plugins: [{ package: '/src/opencode-pdkit', options: { models: { a: 'm/low' } } }] }), doc('/p.json', { plugins: [{ package: '/src/opencode-pdkit', options: { models: { a: 'm/high' } } }] })],
      ID,
    );
    assert.deepEqual(entry, { document: '/p.json', target: '/src/opencode-pdkit', options: { models: { a: 'm/high' } } });
    assert.deepEqual(unread, [{ document: '/g.json', target: '/src/opencode-pdkit', why: '/p.json names the same target later, and Open Code loads it with the options there' }]);
  });

  test('another target later: the first is read, the later one is refused as a second copy', () => {
    const { entry, unread } = pluginEntry(
      [doc('/g.json', { plugins: [{ package: '/src/opencode-pdkit', options: { models: { a: 'm/low' } } }] }), doc('/p.json', { plugins: [{ package: '/link/opencode-pdkit', options: { models: { a: 'm/high' } } }] })],
      ID,
    );
    assert.equal(entry.document, '/g.json');
    assert.deepEqual(unread, [{ document: '/p.json', target: '/link/opencode-pdkit', why: '/g.json loads the plugin first, and Open Code refuses a second copy' }]);
  });

  test('the package by its ID later only turns on the one loaded first: the first is read', () => {
    const { entry, unread } = pluginEntry(
      [doc('/g.json', { plugins: [{ package: 'opencode-pdkit', options: { models: { a: 'm/low' } } }] }), doc('/p.json', { plugins: [{ package: 'opencode-pdkit', options: { models: { a: 'm/high' } } }] })],
      ID,
    );
    assert.deepEqual(entry, { document: '/g.json', target: 'opencode-pdkit', options: { models: { a: 'm/low' } } });
    assert.deepEqual(unread, [{ document: '/p.json', target: 'opencode-pdkit', why: 'it names the plugin by its ID, which only turns on the one /g.json loads' }]);
  });

  test('an entry without options that is not read is not reported: it loses nothing', () => {
    const { entry, unread } = pluginEntry([doc('/g.json', { plugins: ['/src/opencode-pdkit'] }), doc('/p.json', { plugins: ['/link/opencode-pdkit', { package: '/other/opencode-pdkit' }] })], ID);
    assert.equal(entry.target, '/src/opencode-pdkit');
    assert.deepEqual(unread, []);
  });

  test('a relative target is from its document’s directory, a file URL is its path', () => {
    const root = process.platform === 'win32' ? 'C:\\' : '/';
    const g = `${root}home${root === '/' ? '/' : '\\'}g.json`;
    const first = pluginEntry([doc(g, { plugins: ['./plugins/opencode-pdkit'] })], ID).entry.target;
    assert.match(first, /plugins[\\/]opencode-pdkit$/);
    assert.ok(first.startsWith(`${root}home`), first);
    const url = process.platform === 'win32' ? 'file:///C:/src/opencode-pdkit' : 'file:///src/opencode-pdkit';
    const fromUrl = pluginEntry([doc(g, { plugins: [url] })], ID).entry.target;
    assert.match(fromUrl, /src[\\/]opencode-pdkit$/);
  });
});

describe('the commands and skills the server offers', () => {
  // As Open Code 2.3.0 gives them (F318): a command is a name and, when it has
  // one, a description; a skill carries its whole text besides its path.
  test('commands by name, with the description shown, or none', () => {
    const listed = commands({
      location: { directory: '/fork' },
      data: [
        { name: 'review', description: 'review changes [commit|branch|pr], defaults to uncommitted' },
        { name: 'pd:sync', description: 'Report fork status against upstream and the state of every worktree.' },
        { name: 'pd:close' },
        { description: 'no name' },
      ],
    });

    assert.deepEqual(
      [...listed],
      [
        ['review', 'review changes [commit|branch|pr], defaults to uncommitted'],
        ['pd:sync', 'Report fork status against upstream and the state of every worktree.'],
        ['pd:close', undefined],
      ],
    );
  });

  test('skills by ID, with the file each is read from and nothing of its text', () => {
    const listed = skills({
      location: { directory: '/fork' },
      data: [
        { id: 'opencode', name: 'OpenCode', description: 'd', path: 'skill://opencode/SKILL.md', content: '# OpenCode' },
        { id: 'pd:package-map', name: 'pd:package-map', description: 'd', path: '/fork/.opencode/skills/pd:package-map/SKILL.md', content: 'x' },
      ],
    });

    assert.deepEqual(
      [...listed],
      [
        ['opencode', { path: 'skill://opencode/SKILL.md' }],
        ['pd:package-map', { path: '/fork/.opencode/skills/pd:package-map/SKILL.md' }],
      ],
    );
  });

  test('an answer of another shape is an empty list', () => {
    for (const answer of [undefined, null, {}, { data: {} }, { data: 'x' }]) {
      assert.equal(commands(answer).size, 0);
      assert.equal(skills(answer).size, 0);
    }
  });
});
