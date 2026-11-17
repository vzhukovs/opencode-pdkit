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

// The commands' and skills' registrar, against a stand-in for Open Code's
// command and skill editors and for the session a command runs in.
//
// What is pinned here is what a person typing `/pd:<skill>` got from Claude
// Code and what no listing would show until a phase went wrong: every skill
// there under its old name, the argument hint where it can be seen, the model
// of the phase checked before the session is switched to it, the plugin's
// files named by a path the model can read, the arguments where the skill
// expects them, and the label the prompt hook knows a pdkit command by.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARGUMENTS,
  PREFIX,
  commandModels,
  readSkills,
  registerCommands,
  registerRefusals,
  skillNames,
  unavailable,
  withArguments,
} from '../opencode/commands.js';
import { LABEL_SOURCE, promptSubmit } from '../opencode/bridge/payload.js';
import { modelRef } from '../opencode/options.js';
import { ROOT_TOKEN, readPrompt } from '../opencode/prompts.js';
import { ADVANCES } from '../lib/state.js';
import { HINT_SEPARATOR, commandDescription, skillArgument, skillDescription, skillModel } from '../lib/session-model.js';

/** The package directory, as the entry point hands it over: with a trailing separator. */
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ABSOLUTE = resolve(ROOT);

/** The skills a person invokes and nothing else; the other three the model may load too. */
const PHRASE = ['package-map', 'upstream-rules', 'worktree-kit'];

/** A catalog as ctx.model.list() answers it (F234): one provider, its models and their variants. */
const CATALOG = [
  { id: 'alpha', modelID: 'alpha', providerID: 'mock', enabled: true, variants: [{ id: 'low' }, { id: 'high' }] },
  { id: 'plain', modelID: 'plain', providerID: 'mock', enabled: true, variants: [] },
  { id: 'off', modelID: 'off', providerID: 'mock', enabled: false, variants: [{ id: 'low' }] },
  { id: 'alias', modelID: 'pinned-1', providerID: 'mock', enabled: true },
];

/**
 * The models the shipped defaults name, as Open Code 2.3.0 lists them for a
 * Claude subscription: the three aliases, each with five variants.
 */
const SUBSCRIPTION = ['opus', 'sonnet', 'haiku'].map((id) => ({
  id,
  modelID: id,
  providerID: 'claude-agent',
  enabled: true,
  variants: ['low', 'medium', 'high', 'xhigh', 'max'].map((variant) => ({ id: variant })),
}));

/**
 * The default of each command ported so far (decisions/T5.B): the class of its
 * Claude Code `model:` through a Claude subscription, its `effort:` as the
 * variant.
 * TODO(T6.01–T6.24): a row per port; with all 21, the alias branch below goes.
 */
const DEFAULTS = Object.freeze({
  audit: 'claude-agent/sonnet#high',
  close: 'claude-agent/sonnet#medium',
  editor: 'claude-agent/haiku#low',
  exec: 'claude-agent/sonnet#medium',
  knowledge: 'claude-agent/opus#medium',
});

/**
 * Register against a stand-in, run each transform once, and hand back what it
 * made. `calls` is every call into the session or the model catalog, in
 * order; `order`, every registration — of a hook (`<domain>.<name>`) or a
 * transform (`<domain>.transform`). `refuse` names what the editors throw on:
 * `command <name>`, `skill <id>`; `fail`, the hooks whose registration
 * rejects: `session.prompt`, `permission.evaluate`. `hooks` holds the
 * callbacks by the same names. A prompt goes through the prompt hooks before
 * it is recorded, as Open Code runs them inside the call (F77, F81);
 * `promptFails` makes the call reject after them.
 */
async function register({ root = ROOT, models = {}, catalog = [...CATALOG, ...SUBSCRIPTION], listFails = false, refuse = [], fail = [], promptFails = false } = {}) {
  const lines = [];
  const calls = [];
  const transforms = { command: [], skill: [] };
  const order = [];
  const hooks = new Map();
  const hook = (domain) => async (name, callback) => {
    if (fail.includes(`${domain}.${name}`)) throw new Error(`${domain}.${name} is unavailable`);
    order.push(`${domain}.${name}`);
    hooks.set(`${domain}.${name}`, [...(hooks.get(`${domain}.${name}`) ?? []), callback]);
  };
  const ctx = {
    command: {
      transform: async (callback) => {
        order.push('command.transform');
        transforms.command.push(callback);
      },
    },
    skill: {
      transform: async (callback) => {
        order.push('skill.transform');
        transforms.skill.push(callback);
      },
    },
    model: {
      list: async () => {
        calls.push(['model.list']);
        if (listFails) throw new Error('the catalog is out to lunch');
        return { data: catalog };
      },
    },
    permission: { hook: hook('permission') },
    session: {
      hook: hook('session'),
      switchModel: async (input) => calls.push(['switchModel', input]),
      prompt: async (input) => {
        for (const callback of hooks.get('session.prompt') ?? []) await callback({ sessionID: input.sessionID, messageID: 'msg_t6', prompt: { text: input.text }, metadata: input.metadata, delivery: input.delivery });
        if (promptFails) throw new Error('the session is gone');
        calls.push(['prompt', input]);
      },
    },
  };
  const report = await registerCommands(ctx, { root, settings: { models }, log: (line) => lines.push(line) });
  const commands = new Map();
  const skills = new Map();
  const editor = (into, kind, key) => ({
    add: (definition) => {
      if (refuse.includes(`${kind} ${definition[key]}`)) throw new Error(`Missing key at ["${key}"]`);
      into.set(definition[key], definition);
    },
  });
  for (const transform of transforms.command) transform(editor(commands, 'command', 'name'));
  for (const transform of transforms.skill) transform(editor(skills, 'skill', 'id'));
  return { report, lines, calls, commands, skills, transforms, hooks, order };
}

/** Ask the permission hooks a question about shell, as Open Code asks it (F114, F207); the effect it ends with. */
async function ask(hooks, commands, { sessionID = 'ses_t6b', effect = 'ask', action = 'shell' } = {}) {
  const event = { sessionID, agent: 'build', action, resources: commands, metadata: {}, source: { type: 'tool' }, effect };
  for (const callback of hooks.get('permission.evaluate') ?? []) await callback(event);
  return event.effect;
}

/** A prompt as the person sends it: through the prompt hooks, with no label. */
async function say(hooks, text, sessionID = 'ses_t6b') {
  for (const callback of hooks.get('session.prompt') ?? []) await callback({ sessionID, messageID: 'msg_next', prompt: { text }, metadata: null, delivery: 'steer' });
}

/** Run a command as Open Code does: the arguments only, no name (F98). */
async function run(command, text = '', prompt = {}) {
  await command.execute({ sessionID: 'ses_t6b', prompt: { text, files: [], agents: [], ...prompt }, delivery: 'steer' });
}

/** The frontmatter of a skill as YAML reads it, and its body as written. */
async function source(name, root = ROOT) {
  return readPrompt(await readFile(join(root, 'skills', name, 'SKILL.md'), 'utf8'));
}

let fixture;

/** A plugin root of its own, with skills written for the test. */
async function plugin(skills) {
  const root = await mkdtemp(join(fixture, 'plugin-'));
  for (const [name, text] of Object.entries(skills)) {
    await mkdir(join(root, 'skills', name), { recursive: true });
    await writeFile(join(root, 'skills', name, 'SKILL.md'), text);
  }
  return root;
}

const skill = (lines, body = 'Read `${CLAUDE_PLUGIN_ROOT}/knowledge/x.md`.') => `---\n${lines.join('\n')}\n---\n\n${body}\n`;

before(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'opencode-commands-'));
});

after(async () => {
  await rm(fixture, { recursive: true, force: true });
});

describe('every skill is a command', () => {
  test('/pd:<name> for each of the 24 skills, and nothing else', async () => {
    const { commands, lines } = await register();
    const names = await skillNames(ROOT);
    assert.equal(names.length, 24);
    assert.deepEqual([...commands.keys()].sort(), names.map((name) => `${PREFIX}${name}`));
    assert.deepEqual(lines, []);
  });

  test('21 of them are a person\'s to invoke, and the other three are the phrase-triggered skills', async () => {
    const { skills } = await readSkills(ABSOLUTE);
    assert.deepEqual(
      skills.filter((one) => !one.personOnly).map((one) => one.name),
      PHRASE,
    );
    assert.equal(skills.filter((one) => one.personOnly).length, 21);
  });

  test('below the minimum Open Code, the refusing commands carry the same names', async () => {
    const { commands } = await register();
    const refused = new Map();
    await registerRefusals(
      { command: { transform: async (callback) => callback({ add: (definition) => refused.set(definition.name, definition) }) } },
      { root: ROOT, log: () => {} },
      { summary: 'Unavailable', refusal: 'update' },
    );
    assert.deepEqual([...refused.keys()].sort(), [...commands.keys()].sort());
  });

  test('a second call of a transform registers the same commands and skills again', async () => {
    const { commands, skills, transforms } = await register();
    const again = new Map();
    const loaded = new Map();
    for (const transform of transforms.command) transform({ add: (definition) => again.set(definition.name, definition) });
    for (const transform of transforms.skill) transform({ add: (definition) => loaded.set(definition.id, definition) });
    assert.deepEqual([...again.keys()], [...commands.keys()]);
    assert.deepEqual([...loaded.keys()], [...skills.keys()]);
  });
});

describe('the description: argument hint first', () => {
  test('each command is described with its hint, then its description', async () => {
    const { commands } = await register();
    for (const name of await skillNames(ROOT)) {
      const { data } = await source(name);
      const hint = data['argument-hint'];
      const expected = hint ? `${hint}${HINT_SEPARATOR}${data.description}` : data.description;
      assert.equal(commands.get(`${PREFIX}${name}`).description, expected, name);
      assert.equal(await skillDescription(name), expected, name);
    }
  });

  test('the hint is the line the prompt hook reads to tell an issue from a pull request', async () => {
    let hinted = 0;
    for (const name of await skillNames(ROOT)) {
      const { data } = await source(name);
      assert.equal(await skillArgument(name), data['argument-hint'] ?? null, name);
      if (data['argument-hint']) hinted += 1;
    }
    assert.equal(hinted, 17);
  });

  test('without a hint it is the description alone', () => {
    assert.equal(commandDescription(null, 'Report fork status.'), 'Report fork status.');
    assert.equal(commandDescription('<issue-number>', 'Audit.'), `<issue-number>${HINT_SEPARATOR}Audit.`);
  });

  test('a skill without a description is still a command, and is named in the log', async () => {
    const root = await plugin({ bare: skill(['name: bare', 'disable-model-invocation: true']) });
    const { commands, lines } = await register({ root });
    assert.equal(commands.has('pd:bare'), true);
    assert.equal(commands.get('pd:bare').description, undefined);
    assert.equal(lines.some((line) => line.startsWith('skills/bare/SKILL.md: no description:')), true);
  });
});

describe('what a command sends', () => {
  test('each sends its skill with the root spelled out and the arguments put in, labeled for the prompt hook', async () => {
    const { commands, calls } = await register();
    for (const name of await skillNames(ROOT)) {
      calls.length = 0;
      await run(commands.get(`${PREFIX}${name}`), '42');
      const sent = calls.filter(([call]) => call === 'prompt');
      assert.equal(sent.length, 1, name);
      const [, input] = sent[0];
      const { body } = await source(name);

      // A shipped default is one this Open Code can use, and the session is on it before the text.
      const ref = modelRef(await skillModel(name));
      const switched = calls.filter(([call]) => call === 'switchModel').map(([, { model }]) => model);
      assert.deepEqual(switched, ref ? [ref] : [], name);
      assert.equal(calls.at(-1)[0], 'prompt', name);

      assert.equal(input.sessionID, 'ses_t6b', name);
      assert.equal(input.delivery, 'steer', name);
      assert.deepEqual(input.metadata, { source: LABEL_SOURCE, command: `${PREFIX}${name}`, arguments: '42' }, name);

      assert.equal(input.text.includes(ROOT_TOKEN), false, name);
      assert.equal(input.text.split(ABSOLUTE).length - 1, body.split(ROOT_TOKEN).length - 1, name);
      if (body.includes(ARGUMENTS)) {
        assert.equal(input.text.includes(ARGUMENTS), false, name);
        assert.equal(input.text.includes('ARGUMENTS: 42'), false, name);
      } else {
        assert.equal(input.text.endsWith('\n\nARGUMENTS: 42'), true, name);
      }
    }
  });

  test('the prompt hook reads each label back as the command a person typed', async () => {
    const { commands, calls } = await register();
    for (const name of commands.keys()) {
      calls.length = 0;
      await run(commands.get(name), ' 42 --purge ');
      const [, input] = calls.find(([call]) => call === 'prompt');
      const payloads = promptSubmit({ sessionID: input.sessionID, metadata: input.metadata }, { directory: '/fork' });
      assert.equal(payloads.length, 1, name);
      assert.equal(payloads[0].prompt, `/${name}  42 --purge `, name);
    }
  });

  test('editor and open take their arguments where the skill says, and the rest after the body', async () => {
    const { commands, calls } = await register();
    await run(commands.get('pd:open'), 'tree 42');
    assert.match(calls.at(-1)[1].text, /^Arguments: `tree 42`$/m);
    await run(commands.get('pd:exec'), '42 T3');
    assert.equal(calls.at(-1)[1].text.endsWith('\n\nARGUMENTS: 42 T3'), true);
  });

  test('without arguments nothing is appended, and a placeholder is left empty', () => {
    assert.equal(withArguments('Body.', ''), 'Body.');
    assert.equal(withArguments('Body.', '  \n'), 'Body.');
    assert.equal(withArguments('Arguments: `$ARGUMENTS`', ''), 'Arguments: ``');
  });

  test('what was typed is put in as it is, never read as a replacement pattern', () => {
    const typed = "$& $' $` $1 $$";
    assert.equal(withArguments('A: $ARGUMENTS, again $ARGUMENTS', typed), `A: ${typed}, again ${typed}`);
    assert.equal(withArguments('Body.', typed), `Body.\n\nARGUMENTS: ${typed}`);
  });

  test('lines after the first are kept: triage reads them as prior context', async () => {
    const { commands, calls } = await register();
    await run(commands.get('pd:triage'), '42\nseen on Windows only\nafter the last update');
    const [, input] = calls.at(-1);
    assert.equal(input.text.endsWith('\n\nARGUMENTS: 42\nseen on Windows only\nafter the last update'), true);
    assert.equal(input.metadata.arguments, '42\nseen on Windows only\nafter the last update');
  });

  test('files, agents and skills the person attached go along with the text', async () => {
    const { commands, calls } = await register();
    const files = [{ type: 'file', url: 'file:///fork/a.ts' }];
    const agents = [{ name: 'pd-scout' }];
    const skills = [{ id: 'pd:package-map' }];
    await run(commands.get('pd:sync'), '', { files, agents, skills });
    const [, input] = calls.at(-1);
    assert.deepEqual(input.files, files);
    assert.deepEqual(input.agents, agents);
    assert.deepEqual(input.skills, skills);
  });

  test('no skill uses a placeholder of Claude Code\'s the registrar does not fill in', async () => {
    const unfilled = /\$ARGUMENTS\[|\$\d|\$\{CLAUDE_(?!PLUGIN_ROOT\})[A-Z_]+\}|!`/;
    for (const name of await skillNames(ROOT)) {
      const { data, body } = await source(name);
      assert.equal(unfilled.test(body), false, `${name}: ${unfilled.exec(body)?.[0]}`);
      assert.equal(Object.hasOwn(data, 'arguments'), false, `${name}: named arguments`);
    }
  });
});

describe('the model a command runs on', () => {
  let root;
  before(async () => {
    root = await plugin({
      a: skill(['name: a', 'description: "Phase a."', 'disable-model-invocation: true', 'model: mock/alpha#low']),
      b: skill(['name: b', 'description: "Phase b."', 'disable-model-invocation: true', 'model: sonnet', 'effort: medium']),
      c: skill(['name: c', 'description: "Loads by itself."']),
      d: skill(['name: d', 'description: "No variant."', 'disable-model-invocation: true', 'model: "mock/plain"']),
    });
  });

  test('the frontmatter\'s, checked against the catalog, then switched to, then the text', async () => {
    const { commands, calls } = await register({ root });
    await run(commands.get('pd:a'), '7');
    assert.deepEqual(
      calls.map(([call]) => call),
      ['model.list', 'switchModel', 'prompt'],
    );
    assert.deepEqual(calls[1][1], { sessionID: 'ses_t6b', model: { providerID: 'mock', id: 'alpha', variant: 'low' } });
  });

  test('a model named without a variant is switched to without one', async () => {
    const { commands, calls } = await register({ root });
    await run(commands.get('pd:d'));
    assert.deepEqual(calls[1][1].model, { providerID: 'mock', id: 'plain' });
  });

  test('options.models wins over the frontmatter, for a phrase-triggered skill\'s command too', async () => {
    const { commands, calls } = await register({ root, models: { 'pd:a': 'mock/alpha#high', 'pd:c': 'mock/plain' } });
    await run(commands.get('pd:a'));
    await run(commands.get('pd:c'));
    const switched = calls.filter(([call]) => call === 'switchModel').map(([, input]) => input.model);
    assert.deepEqual(switched, [
      { providerID: 'mock', id: 'alpha', variant: 'high' },
      { providerID: 'mock', id: 'plain' },
    ]);
  });

  test('a map entry that is not provider/model#variant, or names no command, is dropped and logged', async () => {
    const { commands, calls, lines, report } = await register({
      root,
      models: { 'pd:a': 'alpha high', 'pd:nope': 'mock/alpha', 'pd-scout': 'mock/alpha' },
    });
    assert.deepEqual(lines, [
      'options.models.pd:a: "alpha high" is not provider/model#variant; dropped, the command keeps its default',
      'options.models.pd:nope: no agent or command of this plugin is called that; dropped',
    ]);
    assert.deepEqual(report.dropped, lines);
    await run(commands.get('pd:a'));
    assert.deepEqual(calls[1][1].model, { providerID: 'mock', id: 'alpha', variant: 'low' });
  });

  test('a model Open Code cannot use is refused, saying which, from where, and why; nothing in the session changes', async () => {
    const cases = [
      ['mock/ghost#low', 'it has no model mock/ghost for this directory'],
      ['mock/off#low', 'the model mock/off is disabled'],
      ['mock/alpha#max', 'mock/alpha has no variant max, only low, high'],
      ['mock/plain#low', 'mock/plain has no variants, so not low'],
      ['other/alpha#low', 'it has no model other/alpha for this directory'],
    ];
    for (const [model, why] of cases) {
      const { commands, calls } = await register({ root, models: { 'pd:a': model } });
      await assert.rejects(
        () => run(commands.get('pd:a'), '7'),
        (error) => {
          assert.equal(
            error.message,
            `pdkit: /pd:a is set to ${model} (options.models), which this Open Code cannot use: ${why}. The session ` +
              `stays on its model; name another for "pd:a" under options.models of the opencode-pdkit entry in opencode.json.`,
          );
          return true;
        },
      );
      assert.deepEqual(calls.map(([call]) => call), ['model.list'], model);
    }
  });

  test('the frontmatter is named as the source when the default is the one refused', async () => {
    const { commands } = await register({ root, catalog: [] });
    await assert.rejects(() => run(commands.get('pd:a')), /^Error: pdkit: \/pd:a is set to mock\/alpha#low \(skills\/a\/SKILL\.md\), which/);
  });

  test('a catalog that cannot be read is a refusal too, not a switch on trust', async () => {
    const { commands, calls } = await register({ root, listFails: true });
    await assert.rejects(() => run(commands.get('pd:a')), /cannot be listed \(the catalog is out to lunch\)/);
    assert.deepEqual(calls.map(([call]) => call), ['model.list']);
  });

  test('a model is matched by its catalog ID or by the provider\'s model ID', () => {
    assert.equal(unavailable(CATALOG, { providerID: 'mock', id: 'alias' }), undefined);
    assert.equal(unavailable(CATALOG, { providerID: 'mock', id: 'pinned-1' }), undefined);
  });

  test('a Claude Code alias is not read: the command runs on the session\'s model, and is listed as unread', async () => {
    const { commands, calls, report, lines } = await register({ root });
    await run(commands.get('pd:b'), '7');
    assert.deepEqual(calls.map(([call]) => call), ['prompt']);
    assert.deepEqual(report.unread, ['skills/b/SKILL.md: model "sonnet" is not provider/model#variant']);
    assert.deepEqual(lines, []);
  });

  test('a skill without one switches nothing', async () => {
    const { commands, calls } = await register({ root });
    await run(commands.get('pd:c'));
    assert.deepEqual(calls.map(([call]) => call), ['prompt']);
  });

  test('effort: is not read: the variant is the one model: names', async () => {
    const { models } = commandModels(
      [{ name: 'e', file: 'skills/e/SKILL.md', model: 'mock/alpha#low', personOnly: true, body: '' }],
      {},
    );
    assert.deepEqual(models.get('pd:e').ref, { providerID: 'mock', id: 'alpha', variant: 'low' });
  });
});

// Moved from test/state.test.js (D12): the model a phase was announced with in
// `pdkit next` is now the model the command switches the session to.
describe('the model of each phase a state leads to', () => {
  const phases = () => [...new Set([...Object.values(ADVANCES).filter(Boolean), 'quickfix'])].sort();

  test('every command a state advances to declares one', async () => {
    const missing = [];
    for (const name of phases()) if (!(await skillModel(name))) missing.push(name);
    assert.deepEqual(missing, []);
  });

  test('each switches the session to it, or still names the Claude Code alias its port replaces', async () => {
    const { report } = await register();
    const byName = new Map(report.commands.map((command) => [command.name, command]));
    for (const name of phases()) {
      const declared = await skillModel(name);
      const ref = modelRef(declared);
      if (ref) {
        assert.deepEqual(byName.get(`${PREFIX}${name}`).model?.ref, ref, name);
      } else {
        // TODO(T6.01–T6.24): no command is left on this branch once each
        // one's model: is provider/model#variant (decisions/T5.B).
        assert.match(declared, /^(opus|sonnet|haiku)$/, name);
        assert.equal(report.unread.includes(`skills/${name}/SKILL.md: model ${JSON.stringify(declared)} is not provider/model#variant`), true, name);
      }
    }
  });

  test('it is read from the frontmatter, in either form', async () => {
    const root = await plugin({
      ported: skill(['name: ported', 'model: claude-agent/sonnet#medium']),
      quoted: skill(['name: quoted', "model: 'claude-agent/opus'"]),
      alias: skill(['name: alias', 'model: sonnet']),
    });
    assert.equal(await skillModel('ported', root), 'claude-agent/sonnet#medium');
    assert.equal(await skillModel('quoted', root), 'claude-agent/opus');
    assert.equal(await skillModel('alias', root), 'sonnet');
  });

  test('a skill without the field gives none, and its command switches nothing', async () => {
    assert.equal(await skillModel('package-map'), null);
    const { report } = await register();
    assert.equal(report.commands.find((command) => command.name === 'pd:package-map').model, undefined);
  });

  test('a skill that does not exist gives none either', async () => {
    assert.equal(await skillModel('no-such-skill'), null);
  });
});

describe('the defaults the commands ship with', () => {
  test('a ported command names the one decided for it, and only a ported command names one', async () => {
    const named = [];
    for (const name of await skillNames(ROOT)) if (modelRef(await skillModel(name))) named.push(name);
    assert.deepEqual(named.sort(), Object.keys(DEFAULTS).sort());
    for (const [name, model] of Object.entries(DEFAULTS)) assert.equal(await skillModel(name), model, name);
  });

  test('effort: is gone from every ported skill: the variant says it', async () => {
    for (const name of Object.keys(DEFAULTS)) {
      const { data } = await source(name);
      assert.equal(Object.hasOwn(data, 'effort'), false, name);
    }
  });
});

describe('the skills the model may load', () => {
  test('the three phrase-triggered skills, as pd:<name>, with when_to_use appended to the description', async () => {
    const { skills } = await register();
    assert.deepEqual([...skills.keys()].sort(), PHRASE.map((name) => `${PREFIX}${name}`));
    for (const name of PHRASE) {
      const registered = skills.get(`${PREFIX}${name}`);
      const { data, body } = await source(name);
      assert.equal(typeof data.when_to_use, 'string', name);
      assert.equal(registered.name, `${PREFIX}${name}`, name);
      assert.equal(registered.description, `${data.description} ${data.when_to_use}`, name);
      assert.equal(registered.content.includes(ROOT_TOKEN), false, name);
      assert.equal(registered.content.split(ABSOLUTE).length - 1, body.split(ROOT_TOKEN).length - 1, name);
    }
  });

  test('each points at its own SKILL.md by absolute path, the directory Open Code tells the model to read beside', async () => {
    const { skills } = await register();
    for (const name of PHRASE) {
      const { path } = skills.get(`${PREFIX}${name}`);
      assert.equal(path, join(ABSOLUTE, 'skills', name, 'SKILL.md'));
      await access(path);
    }
  });

  test('no skill a person invokes is offered to the model', async () => {
    const { skills } = await register();
    const { skills: read } = await readSkills(ABSOLUTE);
    for (const one of read.filter((entry) => entry.personOnly)) assert.equal(skills.has(`${PREFIX}${one.name}`), false, one.name);
  });
});

// Claude Code's allowed-tools let the commands a skill lists run without a
// question during the turn that invoked it, and the grant ended with the
// person's next message; it fenced nothing in (opencode/allowed.js). The
// matching itself is test/opencode-allowed.test.js's.
describe('allowed-tools: what a command runs without asking, until the next message', () => {
  test('editor and open list the commands they run, and no other skill lists any', async () => {
    const { skills, problems } = await readSkills(ABSOLUTE);
    assert.deepEqual(problems, []);
    const listing = Object.fromEntries(skills.filter((one) => one.allowed.length > 0).map((one) => [one.name, one.allowed]));
    assert.deepEqual(listing, {
      editor: ['pdkit editor', 'pdkit editor:*'],
      open: ['pdkit open home', 'pdkit open issue', 'pdkit open issue:*', 'pdkit open tree', 'pdkit open tree:*'],
    });
  });

  test('the hooks that answer for and end a grant are there before any command is', async () => {
    const { order, lines } = await register();
    assert.deepEqual(order, ['session.prompt', 'permission.evaluate', 'command.transform', 'skill.transform']);
    assert.deepEqual(lines, []);
  });

  test("/pd:editor's command runs without a question in its turn, and the next message ends that", async () => {
    const { commands, hooks, calls } = await register();
    assert.equal(await ask(hooks, ['pdkit editor 42']), 'ask', 'nothing granted before the command');
    await run(commands.get('pd:editor'), '42');
    assert.equal(calls.at(-1)[0], 'prompt');

    assert.equal(await ask(hooks, ['pdkit editor 42']), 'allow');
    assert.equal(await ask(hooks, ['pdkit editor']), 'allow');
    // Not the skill's: another command, a longer word, or the right command with another beside it.
    assert.equal(await ask(hooks, ['pdkit open home']), 'ask');
    assert.equal(await ask(hooks, ['pdkit editorial 42']), 'ask');
    assert.equal(await ask(hooks, ['pdkit editor 42', 'touch pwned']), 'ask');
    // What the rule never covered in Claude Code: a nested command, a redirect's target, a second command unsplit.
    for (const command of ['pdkit editor $(touch pwned)', 'pdkit editor `touch pwned`', 'pdkit editor 42 > out.txt', 'pdkit editor 42; touch pwned', 'pdkit editor 42 && touch pwned', 'pdkit editor 42 | sh', 'pdkit editor 42\ntouch pwned']) {
      assert.equal(await ask(hooks, [command]), 'ask', command);
    }
    assert.equal(await ask(hooks, []), 'ask', 'a question about nothing');

    await say(hooks, 'Thanks. Now open it again.');
    assert.equal(await ask(hooks, ['pdkit editor 42']), 'ask');
  });

  test('/pd:open grants the five forms it runs', async () => {
    const { commands, hooks } = await register();
    await run(commands.get('pd:open'), 'tree 42');
    for (const command of ['pdkit open home', 'pdkit open issue', 'pdkit open issue 42', 'pdkit open tree', 'pdkit open tree 42']) {
      assert.equal(await ask(hooks, [command]), 'allow', command);
    }
    for (const command of ['pdkit open home 42', 'pdkit open', 'pdkit editor 42']) assert.equal(await ask(hooks, [command]), 'ask', command);
  });

  test("only a question is answered, about shell, in the command's session", async () => {
    const { commands, hooks } = await register();
    await run(commands.get('pd:editor'), '42');
    assert.equal(await ask(hooks, ['pdkit editor 42'], { effect: 'deny' }), 'deny');
    assert.equal(await ask(hooks, ['pdkit editor 42'], { effect: 'allow' }), 'allow');
    assert.equal(await ask(hooks, ['pdkit editor 42'], { action: 'edit' }), 'ask');
    assert.equal(await ask(hooks, ['pdkit editor 42'], { sessionID: 'ses_other' }), 'ask');
    await say(hooks, 'hello', 'ses_other');
    assert.equal(await ask(hooks, ['pdkit editor 42']), 'allow', "another session's message ends nothing here");
  });

  test('invoking another command ends the grant, even one refused for its model', async () => {
    const { commands, hooks } = await register({ models: { 'pd:audit': 'mock/off' } });
    await run(commands.get('pd:editor'), '42');
    await run(commands.get('pd:close'), '42');
    assert.equal(await ask(hooks, ['pdkit editor 42']), 'ask', 'a command that ran');

    await run(commands.get('pd:editor'), '42');
    await assert.rejects(run(commands.get('pd:audit'), '42'), /the model mock\/off is disabled/);
    assert.equal(await ask(hooks, ['pdkit editor 42']), 'ask', 'a command refused before its prompt');

    await run(commands.get('pd:editor'), '');
    assert.equal(await ask(hooks, ['pdkit editor']), 'allow', 'invoked again, granted again');
  });

  test('only the command\'s own prompt keeps the grant: the same label later ends it', async () => {
    const { commands, hooks } = await register();
    await run(commands.get('pd:editor'), '42');
    for (const callback of hooks.get('session.prompt')) {
      await callback({ sessionID: 'ses_t6b', messageID: 'msg_x', prompt: { text: 'x' }, metadata: { source: LABEL_SOURCE, command: 'pd:editor', arguments: '42' }, delivery: 'steer' });
    }
    assert.equal(await ask(hooks, ['pdkit editor 42']), 'ask');
  });

  test('a prompt that fails takes the grant with it', async () => {
    const { commands, hooks } = await register({ promptFails: true });
    await assert.rejects(run(commands.get('pd:editor'), '42'), /the session is gone/);
    assert.equal(await ask(hooks, ['pdkit editor 42']), 'ask');
  });

  test('a skill without allowed-tools registers no hook; a tool with no counterpart here is named in the log', async () => {
    const plain = await plugin({ a: skill(['name: a', 'description: "A."', 'disable-model-invocation: true']) });
    const none = await register({ root: plain });
    assert.deepEqual(none.order, ['command.transform', 'skill.transform']);

    const listing = await plugin({ b: skill(['name: b', 'description: "B."', 'disable-model-invocation: true', 'allowed-tools: Read, Bash(git status)']) });
    const { report, lines, hooks, commands } = await register({ root: listing });
    assert.deepEqual(report.commands[0].allowed, ['git status']);
    assert.deepEqual(lines, ["skills/b/SKILL.md: allowed-tools Read has no counterpart in Open Code; /pd:b is asked about it as the person's rules say"]);
    await run(commands.get('pd:b'));
    assert.equal(await ask(hooks, ['git status']), 'allow');
  });

  for (const failing of ['session.prompt', 'permission.evaluate']) {
    test(`a hook that cannot be registered is logged, and every command is: ${failing}`, async () => {
      const { commands, hooks, lines } = await register({ fail: [failing] });
      assert.equal(commands.size, 24);
      assert.deepEqual(lines, [
        `cannot register its allowed tools (${failing} is unavailable); /pd:editor, /pd:open run their commands as the person's rules say, asking where they ask`,
      ]);
      // Without the hook that ends a grant, nothing answers for one.
      if (failing === 'session.prompt') assert.equal(hooks.has('permission.evaluate'), false);
      await run(commands.get('pd:editor'), '42');
      assert.equal(await ask(hooks, ['pdkit editor 42']), 'ask');
    });
  }

  test('neither hook throws, whatever it is handed', async () => {
    const { commands, hooks, lines } = await register();
    await run(commands.get('pd:editor'), '42');
    for (const event of [undefined, null, {}, { sessionID: 42 }, { sessionID: 'ses_t6b', metadata: 'x' }]) {
      for (const callback of hooks.get('session.prompt')) await callback(event);
    }
    for (const event of [undefined, null, {}, { action: 'shell', effect: 'ask', sessionID: 'ses_t6b', resources: 'pdkit editor' }, { action: 'shell', effect: 'ask', sessionID: 'ses_t6b', resources: [42] }]) {
      for (const callback of hooks.get('permission.evaluate')) await callback(event);
    }
    assert.deepEqual(lines, []);
  });
});

describe('a transform never throws', () => {
  test('a command the editor refuses is logged, and the others are registered', async () => {
    const { commands, lines } = await register({ refuse: ['command pd:exec'] });
    assert.equal(commands.has('pd:exec'), false);
    assert.equal(commands.size, 23);
    assert.deepEqual(lines, ['cannot add the command pd:exec: Missing key at ["name"]']);
  });

  test('so does a skill', async () => {
    const { skills, lines } = await register({ refuse: ['skill pd:package-map'] });
    assert.equal(skills.size, 2);
    assert.deepEqual(lines, ['cannot add the skill pd:package-map: Missing key at ["id"]']);
  });

  test('a SKILL.md that cannot be read is named, and the rest are registered', async () => {
    const root = await plugin({
      good: skill(['name: good', 'description: "Good."', 'disable-model-invocation: true']),
      plain: 'No frontmatter at all.\n',
      broken: '---\nname: broken\ndescription: "unterminated\n---\nBody.\n',
    });
    const { commands, lines } = await register({ root });
    assert.deepEqual([...commands.keys()], ['pd:good']);
    assert.equal(lines.length, 2);
    assert.equal(lines.some((line) => line.startsWith('skills/plain/SKILL.md: no frontmatter; not registered')), true);
    assert.equal(lines.some((line) => /^skills\/broken\/SKILL\.md: .*unterminated quote.*; not registered$/.test(line)), true);
  });
});
