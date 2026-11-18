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

import { DIRECTORY_HEADER, agentRules, get, mcpServers, mcpStatuses, plugins, takenBy, toolPrefix, turnedOff, waitFor, wildcard } from '../lib/opencode-api.js';

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
