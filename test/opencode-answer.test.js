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

// Tests for opencode/bridge/answer.js: a hook's decision, as the action Open
// Code takes, and the list of what reaches no one. The list is the point of
// the second half: what the host has no way for is reported, never lost
// without a word.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { answer } from '../opencode/bridge/answer.js';
import { decide } from '../lib/hooks/runner.js';

describe('pre-bash', () => {
  test('a refusal refuses, with the reason as its text', () => {
    assert.deepEqual(answer('pre-bash', { block: true, reason: 'pdkit: no consent token\n  command: git push' }), {
      action: { kind: 'refuse', text: 'pdkit: no consent token\n  command: git push' },
      dropped: [],
    });
  });

  test('anything else lets the call through', () => {
    assert.deepEqual(answer('pre-bash', { block: false }), { action: { kind: 'pass' }, dropped: [] });
  });

  // The policy is runner.decide's; this only carries out what it decided.
  test('a run that gave no answer arrives as a refusal already, and is one', () => {
    const decision = decide('pre-bash', { code: null, stdout: '', stderr: '', failure: { kind: 'deadline', detail: 'gave no answer within 10s and was stopped' } });
    assert.deepEqual(answer('pre-bash', decision).action, { kind: 'refuse', text: decision.reason });
  });

  // Before a tool runs there is no text to the model beside a call that goes
  // ahead, and no line to the person. Claude Code wrote a PreToolUse message
  // to its debug log; here it is listed for the bridge to write to its own.
  test('a message, which only a refusal could carry here, is listed as dropped', () => {
    assert.deepEqual(answer('pre-bash', { block: false, message: 'pdkit: consent token for DESKTOP-1/x spent' }), {
      action: { kind: 'pass' },
      dropped: [{ field: 'message', text: 'pdkit: consent token for DESKTOP-1/x spent' }],
    });
  });

  test('so is a notice', () => {
    assert.deepEqual(answer('pre-bash', { block: false, notice: 'for the person', message: 'for the model' }).dropped, [
      { field: 'message', text: 'for the model' },
      { field: 'notice', text: 'for the person' },
    ]);
  });

  test('an empty one is nothing to report', () => {
    assert.deepEqual(answer('pre-bash', { block: false, message: '' }).dropped, []);
  });
});

test('an event the bridge does not carry is a mistake, not a pass', () => {
  assert.throws(() => answer('no-such-event', { block: true, reason: 'x' }), /carries no "no-such-event"/);
  assert.throws(() => answer('toString', { block: false }), /carries no "toString"/);
});
