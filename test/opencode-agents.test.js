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

// The agents' registrar, against a stand-in for Open Code's agent editor.
//
// What is pinned here is what Claude Code gave each agent and what no session
// would show until a review went wrong: the tools each agent may use and
// nothing more, the model each one runs on, the plugin's files named by a path
// the agent may read, and the implementer under the very ID the receipt gate
// looks for. Permissions are checked the way Open Code decides them: the last
// rule whose action and resource match wins, `*` matches anything, and with
// no rule the answer is to ask.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACTIONS, ROOT_TOKEN, actionOf, agentModels, permissionsFor, readAgents, registerAgents } from '../opencode/agents.js';
import { PLUGIN_ROOT, issueDir, resolveHome } from '../lib/config.js';
import { cutDecision } from '../lib/hooks/cut.js';
import { IMPLEMENTER } from '../lib/hooks/task-completed.js';

/** The package directory, as the entry point hands it over: with a trailing separator. */
const ROOT = fileURLToPath(new URL('../', import.meta.url));

const READS = ['read', 'grep', 'glob'];

/**
 * Each agent as Claude Code ran it (§1.3 of the migration plan): the Open Code
 * actions its `tools:` amount to, and its model. That is the default its
 * frontmatter names as provider/model#variant (the class it had under Claude
 * Code, at the effort of the command that calls it), or, while the agent is
 * not ported yet, the Claude Code alias its frontmatter still has.
 */
const EXPECTED = {
  'pd-archaeologist': { model: { providerID: 'claude-agent', id: 'sonnet', variant: 'high' }, actions: [...READS, 'shell'] },
  'pd-auditor': { alias: 'opus', actions: [...READS, 'shell'] },
  'pd-conflict-analyst': { alias: 'opus', actions: [...READS, 'shell'] },
  'pd-implementer': { alias: 'sonnet', actions: ['read', 'edit', 'grep', 'glob', 'shell'] },
  'pd-plan-critic': { alias: 'opus', actions: READS },
  'pd-review-api-compat': { alias: 'sonnet', actions: READS },
  'pd-review-architecture': { alias: 'sonnet', actions: READS },
  'pd-review-product': { alias: 'sonnet', actions: READS },
  'pd-review-synth': { alias: 'opus', actions: ['read'] },
  'pd-review-tests': { alias: 'sonnet', actions: READS },
  'pd-scout': { alias: 'sonnet', actions: [...READS, 'shell'] },
  'pd-slicer': { alias: 'sonnet', actions: [...READS, 'shell'] },
  'pd-thread-resolver': { alias: 'sonnet', actions: ['read', 'edit', 'grep', 'glob', 'shell'] },
  'pd-validator': {
    alias: 'sonnet',
    actions: [
      'read',
      'shell',
      'playwright_browser_navigate',
      'playwright_browser_click',
      'playwright_browser_type',
      'playwright_browser_snapshot',
      'playwright_browser_take_screenshot',
      'playwright_browser_wait_for',
    ],
  },
};

/** Every action of Open Code 2.3.0's own tools, and an MCP tool no agent was given. */
const EVERY_ACTION = [
  'read',
  'edit',
  'glob',
  'grep',
  'shell',
  'subagent',
  'skill',
  'question',
  'webfetch',
  'websearch',
  'execute',
  'playwright_browser_evaluate',
  'rea_open_binary',
];

const escape = (text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** Open Code's wildcard: `*` is anything, slashes included; the rest is literal. */
const matches = (pattern, value) => new RegExp(`^${pattern.split('*').map(escape).join('.*')}$`, 's').test(value);

/** Open Code's decision: the last rule that matches, `ask` when none does. */
const decide = (rules, action, resource) =>
  rules.findLast((rule) => matches(rule.action, action) && matches(rule.resource, resource))?.effect ?? 'ask';

/** What Open Code asks about before a tool reads `file` outside the project. */
const outside = (file) => `${dirname(file)}/*`;

/**
 * A stand-in for Open Code's agent editor: update() hands over the agent with
 * that ID, or a new one made from Open Code's defaults (a primary agent that
 * may do anything, and asks before reading .env files).
 */
function editor() {
  const agents = new Map();
  return {
    agents,
    update(id, change) {
      const info = agents.get(id) ?? {
        name: id,
        mode: 'primary',
        hidden: false,
        request: { settings: {}, headers: {}, body: {} },
        permissions: [
          { action: '*', resource: '*', effect: 'allow' },
          { action: 'read', resource: '*.env', effect: 'ask' },
          { action: 'read', resource: '*.env.*', effect: 'ask' },
          { action: 'read', resource: '*.env.example', effect: 'allow' },
        ],
      };
      change(info);
      agents.set(id, info);
    },
  };
}

/** Register against a stand-in, run the transform once, and hand back what it made. */
async function register({ root = ROOT, models = {} } = {}) {
  const lines = [];
  const transforms = [];
  const ctx = {
    agent: {
      transform: async (callback) => {
        transforms.push(callback);
      },
    },
  };
  const report = await registerAgents(ctx, { root, settings: { models }, log: (line) => lines.push(line) });
  const host = editor();
  for (const transform of transforms) transform(host);
  return { report, lines, agents: host.agents, transforms };
}

/** A plugin root of its own, with these agent files. */
async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'pdkit-agents-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'agents'));
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, 'agents', name), text);
  return root;
}

const agentFile = ({ name, model, tools = 'Read', body = 'Do the one thing.' }) =>
  ['---', `name: ${name}`, `description: "The ${name} agent."`, ...(model ? [`model: ${model}`] : []), `tools: ${tools}`, '---', '', body, ''].join('\n');

describe('the 14 agents', () => {
  test('are the files under agents/, each under its name, and nothing is logged', async () => {
    const { agents, lines } = await register();

    assert.deepEqual([...agents.keys()].sort(), Object.keys(EXPECTED).sort());
    const { agents: sources } = await readAgents(ROOT);
    for (const source of sources) assert.equal(source.file, `agents/${source.id}.md`);
    assert.deepEqual(lines, []);
  });

  // The receipt gate knows the implementer by the ID Open Code reports for
  // the child session, which is the ID registered here. Under any other, the
  // gate would let the implementer go as it lets any agent go.
  test('the implementer is registered under the ID the receipt gate looks for', async () => {
    const { agents } = await register();
    const { agents: sources } = await readAgents(ROOT);

    assert.equal(sources.find((source) => source.file === 'agents/pd-implementer.md')?.id, IMPLEMENTER);
    assert.ok(agents.has(IMPLEMENTER));
  });

  for (const [id, { actions }] of Object.entries(EXPECTED)) {
    describe(id, () => {
      test('is a subagent, described as its frontmatter describes it', async () => {
        const { agents } = await register();
        const text = await readFile(join(ROOT, 'agents', `${id}.md`), 'utf8');

        assert.equal(agents.get(id).mode, 'subagent');
        assert.equal(agents.get(id).description, /^description:\s*"(.*)"\s*$/m.exec(text)[1]);
      });

      test('may use the tools Claude Code gave it, and nothing else', async () => {
        const { agents } = await register();
        const rules = agents.get(id).permissions;

        assert.deepEqual(rules, [
          { action: '*', resource: '*', effect: 'deny' },
          ...actions.map((action) => ({ action, resource: '*', effect: 'allow' })),
          { action: 'external_directory', resource: `${PLUGIN_ROOT}/*`, effect: 'allow' },
          { action: 'external_directory', resource: `${resolveHome()}/*`, effect: 'allow' },
        ]);
        for (const action of EVERY_ACTION) {
          assert.equal(decide(rules, action, '*'), actions.includes(action) ? 'allow' : 'deny', `${id}: ${action}`);
        }
        // Open Code's own .env rules go with the defaults: Claude Code's Read did not ask either.
        assert.equal(decide(rules, 'read', '.env'), actions.includes('read') ? 'allow' : 'deny');
      });

      if (EXPECTED[id].model) {
        test('runs on the default model its frontmatter names, with its variant', async () => {
          const { agents, report } = await register();

          assert.deepEqual(agents.get(id).model, EXPECTED[id].model);
          assert.deepEqual(report.unread.filter((line) => line.startsWith(`agents/${id}.md:`)), []);
        });
      } else {
        test('runs on the model of its caller until the defaults name one (T5.B)', async () => {
          const { agents, report } = await register();

          assert.equal(Object.hasOwn(agents.get(id), 'model'), false);
          assert.ok(report.unread.includes(`agents/${id}.md: model "${EXPECTED[id].alias}" is not provider/model#variant`));
        });
      }

      test('reads the plugin files its prompt names, by their absolute path', async () => {
        const { agents } = await register();
        const text = await readFile(join(ROOT, 'agents', `${id}.md`), 'utf8');
        const { system, permissions } = agents.get(id);

        assert.equal(system.includes(ROOT_TOKEN), false);
        const named = [...system.matchAll(new RegExp(`${escape(PLUGIN_ROOT)}/[A-Za-z0-9_./-]+`, 'g'))].map(([path]) => path.replace(/\.$/, ''));
        assert.equal(named.length, text.split(ROOT_TOKEN).length - 1);
        for (const path of named) {
          await access(path);
          assert.equal(decide(permissions, 'external_directory', outside(path)), 'allow', path);
          if (actions.includes('read')) assert.equal(decide(permissions, 'read', path), 'allow', path);
        }
      });
    });
  }

  test('their prompts are the bodies of their files, with the root spelled out', async () => {
    const { agents } = await register();
    const { agents: sources } = await readAgents(ROOT);

    for (const source of sources) {
      assert.equal(agents.get(source.id).system, source.body.replaceAll(ROOT_TOKEN, PLUGIN_ROOT));
      assert.ok(source.body.length > 0);
    }
  });

  // post-bash and post-read (lib/hooks/cut.js) and post-claim point the model
  // at the pitfalls file by its absolute path, and a subagent gets those
  // messages too.
  test('each may read the pitfalls file the hooks point the model at', async () => {
    const { agents } = await register();
    const message = cutDecision(['sed -n 1,2p'], 'a {\n', PLUGIN_ROOT).message;
    const pitfalls = / in (\S+\/knowledge\/pitfalls\.md)\.$/.exec(message)?.[1];

    assert.ok(pitfalls, message);
    await access(pitfalls);
    for (const [id, { permissions }] of agents) assert.equal(decide(permissions, 'external_directory', outside(pitfalls)), 'allow', id);
  });

  // `pdkit plan brief` names plan.md and the task files under $PDKIT_HOME,
  // and the plan critic reads them with no shell to fall back on.
  test("each may read an issue's plan under $PDKIT_HOME, and nothing else outside the project", async () => {
    const { agents } = await register();
    const plan = join(issueDir(resolveHome(), 1), 'plan.md');
    const task = join(issueDir(resolveHome(), 1), 'tasks', 'T1.md');

    for (const [id, { permissions }] of agents) {
      for (const file of [plan, task]) assert.equal(decide(permissions, 'external_directory', outside(file)), 'allow', `${id}: ${file}`);
      for (const elsewhere of ['/etc/passwd', join(dirname(resolveHome()), 'other', 'x.md'), `${PLUGIN_ROOT}-other/x.md`]) {
        assert.equal(decide(permissions, 'external_directory', outside(elsewhere)), 'deny', `${id}: ${elsewhere}`);
      }
    }
  });
});

describe('the model', () => {
  test("is the options' when they name one, with its variant", async () => {
    const models = Object.fromEntries(Object.keys(EXPECTED).map((id, n) => [id, n % 2 ? `prov/${id}-model#high` : `prov/${id}-model`]));
    const { agents, lines, report } = await register({ models });

    for (const [n, id] of Object.keys(EXPECTED).entries()) {
      assert.deepEqual(agents.get(id).model, n % 2 ? { providerID: 'prov', id: `${id}-model`, variant: 'high' } : { providerID: 'prov', id: `${id}-model` });
    }
    assert.deepEqual(lines, []);
    assert.deepEqual(report.unread, []);
  });

  test("is the frontmatter's when the options name none, and the options win over it", async (t) => {
    const root = await fixture(t, {
      'a.md': agentFile({ name: 'a', model: 'claude-agent/claude-sonnet-5#medium' }),
      'b.md': agentFile({ name: 'b', model: 'claude-agent/claude-sonnet-5#medium' }),
      'c.md': agentFile({ name: 'c' }),
    });

    const { agents, report } = await register({ root, models: { b: 'openai/gpt-6.1-terra#high' } });

    assert.deepEqual(agents.get('a').model, { providerID: 'claude-agent', id: 'claude-sonnet-5', variant: 'medium' });
    assert.deepEqual(agents.get('b').model, { providerID: 'openai', id: 'gpt-6.1-terra', variant: 'high' });
    assert.equal(Object.hasOwn(agents.get('c'), 'model'), false);
    assert.deepEqual(report.unread, []);
  });

  // Open Code would take a string on the agent and then fail to list any
  // agent of the location; the registrar must never hand it one.
  test('is an object, never the string it was written as', async () => {
    const { agents } = await register({ models: { 'pd-scout': 'openai/gpt-6.1-terra#high' } });

    assert.equal(typeof agents.get('pd-scout').model, 'object');
  });

  test('that is not provider/model#variant is dropped and logged, and the agent keeps its default', async (t) => {
    const root = await fixture(t, { 'a.md': agentFile({ name: 'a', model: 'mock/alpha#low' }), 'b.md': agentFile({ name: 'b' }) });

    const { agents, lines, report } = await register({ root, models: { a: 'sonnet', b: 'openai/' } });

    assert.deepEqual(agents.get('a').model, { providerID: 'mock', id: 'alpha', variant: 'low' });
    assert.equal(Object.hasOwn(agents.get('b'), 'model'), false);
    assert.deepEqual(lines, [
      'options.models.a: "sonnet" is not provider/model#variant; dropped, the agent keeps its default',
      'options.models.b: "openai/" is not provider/model#variant; dropped, the agent keeps its default',
    ]);
    assert.deepEqual(report.dropped, lines);
  });

  test("of a key that names no agent is dropped and logged; a command's key is left to the commands", async () => {
    const { lines, report } = await register({ models: { 'pd-scuot': 'openai/gpt-6.1-terra', 'pd:plan': 'openai/gpt-6.1-terra#high', 'pd:nothing': 'x' } });

    assert.deepEqual(lines, ['options.models.pd-scuot: no agent or command of this plugin is called that; dropped']);
    assert.deepEqual(report.dropped, lines);
  });

  test('is chosen the same way outside the registrar', () => {
    const sources = [
      { id: 'a', file: 'agents/a.md', model: 'p/m', tools: [], body: '' },
      { id: 'b', file: 'agents/b.md', model: 'opus', tools: [], body: '' },
      { id: 'c', file: 'agents/c.md', model: undefined, tools: [], body: '' },
    ];

    const { models, dropped, unread } = agentModels(sources, { c: 'q/n#x' });

    assert.deepEqual(Object.fromEntries(models), { a: { providerID: 'p', id: 'm' }, c: { providerID: 'q', id: 'n', variant: 'x' } });
    assert.deepEqual(dropped, []);
    assert.deepEqual(unread, ['agents/b.md: model "opus" is not provider/model#variant']);
  });
});

describe('the transform', () => {
  // Open Code calls it again on every change to its config and agent files,
  // each time on agents rebuilt from scratch.
  test('gives the same agents on every call', async () => {
    const { transforms } = await register();
    const runs = [editor(), editor()];
    for (const host of runs) for (const transform of transforms) transform(host);

    assert.deepEqual(Object.fromEntries(runs[0].agents), Object.fromEntries(runs[1].agents));
  });

  test('hands Open Code copies, which it may change without changing the next call', async () => {
    const { transforms } = await register({ models: { 'pd-scout': 'a/b#c' } });
    const first = editor();
    for (const transform of transforms) transform(first);
    const given = structuredClone(first.agents.get('pd-scout'));
    first.agents.get('pd-scout').permissions.push({ action: 'webfetch', resource: '*', effect: 'allow' });
    first.agents.get('pd-scout').permissions[0].effect = 'allow';
    first.agents.get('pd-scout').model.variant = 'changed';

    const second = editor();
    for (const transform of transforms) transform(second);

    assert.deepEqual(second.agents.get('pd-scout'), given);
  });

  // A transform that throws disables the plugin, and the gate with it.
  test('does not throw when Open Code refuses an agent, and registers the others', async () => {
    const { transforms, lines } = await register();
    const host = editor();
    const update = host.update;
    host.update = (id, change) => {
      if (id === 'pd-scout') throw new Error('no scouts today');
      update(id, change);
    };

    for (const transform of transforms) transform(host);

    assert.equal(host.agents.size, 13);
    assert.deepEqual(lines, ['cannot register the agent pd-scout: no scouts today']);
  });
});

describe('tools and permissions', () => {
  test("every one of Claude Code's tools the agents name has an action", () => {
    assert.deepEqual(Object.keys(ACTIONS).sort(), ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write']);
  });

  for (const [tool, action] of [
    ['mcp__playwright__browser_navigate', 'playwright_browser_navigate'],
    ['mcp__my.server__browser_take-screenshot', 'my_server_browser_take-screenshot'],
    ['mcp__a b__c:d', 'a_b_c_d'],
  ]) {
    test(`an MCP tool is named as Open Code names it: ${tool}`, () => {
      assert.equal(actionOf(tool), action);
    });
  }

  for (const tool of ['NotebookEdit', 'WebFetch', 'Task', 'mcp__nothing', 'read']) {
    test(`a tool with no counterpart has no action: ${tool}`, () => {
      assert.equal(actionOf(tool), undefined);
    });
  }

  test('Write and Edit are one action, given once', () => {
    assert.deepEqual(permissionsFor(['Write', 'Edit', 'Read'], []).rules, [
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'edit', resource: '*', effect: 'allow' },
      { action: 'read', resource: '*', effect: 'allow' },
    ]);
  });

  test('a directory given twice is one rule', () => {
    assert.equal(permissionsFor([], ['/a/b', '/a/b/']).rules.length, 2);
  });

  test('a tool with no counterpart stays denied, and the agent is registered without it', async (t) => {
    const root = await fixture(t, { 'a.md': agentFile({ name: 'a', tools: 'Read, NotebookEdit' }) });

    const { agents, lines } = await register({ root });

    assert.deepEqual(
      agents.get('a').permissions.filter((rule) => rule.action !== 'external_directory'),
      [
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'read', resource: '*', effect: 'allow' },
      ],
    );
    assert.deepEqual(lines, ['agents/a.md: Open Code has no permission for the tool NotebookEdit; the agent goes without it']);
  });
});

describe('a file it cannot register', () => {
  test('is left out and named, and the rest are registered', async (t) => {
    const root = await fixture(t, {
      'a.md': agentFile({ name: 'a' }),
      'b.md': 'No frontmatter here.\n',
      'c.md': '---\ndescription: "Nameless."\ntools: Read\n---\nBody.\n',
      'd.md': agentFile({ name: 'a' }),
      // Claude Code gave an agent with no tools: every tool; here it would get none.
      'e.md': '---\nname: e\ndescription: "No tools."\n---\nBody.\n',
      'f.md': '---\nname: [unclosed\n---\nBody.\n',
      'notes.txt': 'not an agent',
    });

    const { agents, lines } = await register({ root });

    assert.deepEqual([...agents.keys()], ['a']);
    assert.equal(lines.length, 5, lines.join('\n'));
    assert.deepEqual(lines.slice(0, 4), [
      'agents/b.md: no frontmatter; not registered',
      'agents/c.md: no name:; not registered',
      'agents/d.md: a second agent called a; not registered',
      'agents/e.md: no tools:; not registered',
    ]);
    assert.match(lines[4], /^agents\/f\.md: .+; not registered$/);
  });
});
