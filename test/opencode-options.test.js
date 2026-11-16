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

// The plugin's settings, as read from the `options` of its entry in
// opencode.json. Whatever a user writes there, reading it must not throw —
// setup() would unload the plugin, gate included — and nothing may be ignored
// without a trace the doctor can show.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { readOptions } from '../opencode/options.js';

describe('the models setting', () => {
  test('keeps every entry whose value is a string', () => {
    const settings = readOptions({ models: { 'pd-scout': 'openai/gpt-5#high', triage: 'google/gemini-3-pro' } });

    assert.deepEqual(settings.models, { 'pd-scout': 'openai/gpt-5#high', triage: 'google/gemini-3-pro' });
    assert.deepEqual(settings.dropped, []);
  });

  test('drops an entry that is not a string, and says which', () => {
    const settings = readOptions({ models: { 'pd-scout': 42, triage: 'google/gemini-3-pro' } });

    assert.deepEqual(settings.models, { triage: 'google/gemini-3-pro' });
    assert.deepEqual(settings.dropped, ['options.models.pd-scout: expected "provider/model#variant", got number']);
  });

  for (const [models, kind] of [
    ['openai/gpt-5', 'string'],
    [['openai/gpt-5'], 'an array'],
    [null, 'null'],
  ]) {
    test(`is dropped whole when it is ${kind}`, () => {
      const settings = readOptions({ models });

      assert.deepEqual(settings.models, {});
      assert.deepEqual(settings.dropped, [`options.models: expected an object, got ${kind}`]);
    });
  }
});

describe('the options object', () => {
  // An entry written as a bare package name, as `opencode plugin add` writes it.
  for (const raw of [undefined, null, {}]) {
    test(`${JSON.stringify(raw)} is no settings and nothing dropped`, () => {
      assert.deepEqual(readOptions(raw), { models: {}, dropped: [] });
    });
  }

  for (const [raw, kind] of [
    ['models', 'string'],
    [[{ models: {} }], 'an array'],
    [7, 'number'],
  ]) {
    test(`that is ${kind} is dropped`, () => {
      assert.deepEqual(readOptions(raw), { models: {}, dropped: [`options: expected an object, got ${kind}`] });
    });
  }

  test('keys other than models are dropped by name', () => {
    const settings = readOptions({ model: 'openai/gpt-5', models: {} });

    assert.deepEqual(settings.dropped, ['options.model: not a setting of this plugin']);
  });

  test('what comes back cannot be changed by a registrar', () => {
    const settings = readOptions({ models: { triage: 'a/b' } });

    assert.ok(Object.isFrozen(settings));
    assert.ok(Object.isFrozen(settings.models));
    assert.ok(Object.isFrozen(settings.dropped));
  });
});
