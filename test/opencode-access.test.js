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

// The answer that keeps the plugin's own files readable when a person's config
// asks before every directory outside the project. It settles one question —
// an `ask` about directories that all lie under the plugin's root — and no
// other: not another action, not a directory beside the root, not $PDKIT_HOME,
// and never a `deny`.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { raises, registerAccess } from '../opencode/access.js';
import { directoryRule, slash } from '../lib/opencode-permissions.js';
import { PLUGIN_ROOT, resolveHome } from '../lib/config.js';

/** The package directory, as the entry point hands it over: with a trailing separator. */
const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** A question as permission.hook("evaluate") receives it. */
const question = (resources, { action = 'external_directory', effect = 'ask' } = {}) => ({
  sessionID: 'ses_child',
  agent: 'pd-plan-critic',
  action,
  resources,
  metadata: {},
  effect,
});

const under = (...parts) => `${slash(join(PLUGIN_ROOT, ...parts))}/*`;

describe('a question it raises to allow', () => {
  for (const [label, resources] of [
    ['the knowledge base', [under('knowledge')]],
    ['a template', [under('templates')]],
    ['a file at the root itself', [`${slash(PLUGIN_ROOT)}/*`]],
    ['several directories under the root', [under('knowledge'), under('skills', 'review-pr')]],
  ]) {
    test(label, () => {
      assert.equal(raises(question(resources), ROOT), true);
    });
  }
});

describe('a question it leaves to the rules', () => {
  for (const [label, event] of [
    ['an allow', question([under('knowledge')], { effect: 'allow' })],
    // A deny never reaches the hook; were one to, it stands.
    ['a deny', question([under('knowledge')], { effect: 'deny' })],
    ['another action', question([under('knowledge')], { action: 'read' })],
    ['an edit', question([under('knowledge')], { action: 'edit' })],
    ['a directory beside the root that shares its name', question([`${slash(PLUGIN_ROOT)}-other/*`])],
    ['a directory above the root', question([`${slash(join(PLUGIN_ROOT, '..'))}/*`])],
    ['a path that climbs out of the root', question([`${slash(PLUGIN_ROOT)}/knowledge/../../elsewhere/*`])],
    ['one directory under the root and one outside', question([under('knowledge'), '/etc/*'])],
    ['$PDKIT_HOME, left to the person as Claude Code left it', question([`${slash(resolveHome())}/issues/1/*`])],
    ['no directory', question([])],
    ['resources that are not a list', question(under('knowledge'))],
    ['a resource that is not a string', question([42])],
    ['no event', undefined],
    ['an event that is not an object', 'external_directory'],
  ]) {
    test(label, () => {
      assert.equal(raises(event, ROOT), false);
    });
  }
});

describe('the hook', () => {
  async function registered() {
    const lines = [];
    const hooks = [];
    const ctx = { permission: { hook: async (name, callback) => hooks.push({ name, callback }) } };
    await registerAccess(ctx, { root: ROOT, log: (line) => lines.push(line) });
    return { hooks, lines };
  }

  test('is the evaluate hook, and sets the effect it raises', async () => {
    const { hooks, lines } = await registered();
    const raised = question([under('knowledge')]);
    const left = question(['/etc/*']);

    assert.deepEqual(
      hooks.map(({ name }) => name),
      ['evaluate'],
    );
    hooks[0].callback(raised);
    hooks[0].callback(left);

    assert.equal(raised.effect, 'allow');
    assert.equal(left.effect, 'ask');
    assert.deepEqual(lines, []);
  });

  // A throw would fail the call being decided, whatever it was.
  test('does not throw on an event it cannot read, and says so', async () => {
    const { hooks, lines } = await registered();
    const event = {
      get action() {
        throw new Error('no action');
      },
    };

    assert.doesNotThrow(() => hooks[0].callback(event));
    assert.deepEqual(lines, ['cannot decide a question about its own files: no action']);
  });
});

describe('the rule for a directory', () => {
  test('lets an agent into it and everything under it', () => {
    assert.deepEqual(directoryRule(ROOT), { action: 'external_directory', resource: `${slash(PLUGIN_ROOT)}/*`, effect: 'allow' });
  });

  test('is written with forward slashes', () => {
    assert.equal(directoryRule(PLUGIN_ROOT).resource.includes('\\'), false);
  });
});
