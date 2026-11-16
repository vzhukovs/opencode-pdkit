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

import { answer, combine, withText } from '../opencode/bridge/answer.js';
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

describe('pre-write', () => {
  test('a refusal refuses, with the reason as its text', () => {
    assert.deepEqual(answer('pre-write', { block: true, reason: 'pdkit: a.ts is not owned by T1 (issue 1).' }), {
      action: { kind: 'refuse', text: 'pdkit: a.ts is not owned by T1 (issue 1).' },
      dropped: [],
    });
  });

  test('anything else lets the call through', () => {
    assert.deepEqual(answer('pre-write', { block: false }), { action: { kind: 'pass' }, dropped: [] });
  });

  // pre-write fails open: runner.decide has made no answer into a pass that
  // says why, and that is what goes ahead.
  test('a run that gave no answer arrives as a pass, and is one', () => {
    const decision = decide('pre-write', { code: null, stdout: '', stderr: '', failure: { kind: 'deadline', detail: 'gave no answer within 10s and was stopped' } });
    assert.equal(decision.block, false);
    assert.deepEqual(answer('pre-write', decision), { action: { kind: 'pass' }, dropped: [] });
  });

  // HK-10: a task with no Owns recorded. Under Claude Code the message was a
  // PreToolUse hook's stdout on exit 0, which went to its debug log.
  test('the message for a task with no Owns recorded is listed as dropped', () => {
    const message = 'pdkit: T9 of issue 4242 has no recorded Owns set, so writes are not constrained.';
    assert.deepEqual(answer('pre-write', { block: false, message }), { action: { kind: 'pass' }, dropped: [{ field: 'message', text: message }] });
  });
});

// After a tool the call has happened: exit 2 cannot undo it, under Claude Code
// or here. What the handler had for the model goes into the call's result.
describe('post-write', () => {
  const HEADER = 'pdkit: src/a.ts has no license header. … Insert this at the top of the file:\n\n/****…';

  test('exit 2 adds its reason to the result, and refuses nothing (HK-12)', () => {
    assert.deepEqual(answer('post-write', { block: true, rule: 'spdx', reason: HEADER }), {
      action: { kind: 'append', text: HEADER },
      dropped: [],
    });
  });

  test('a message adds itself to the result (HK-13)', () => {
    const message = 'pdkit: /x/schemas/a.ts affects the generated schemas — run `pnpm generate:schemas` and commit the result';
    assert.deepEqual(answer('post-write', { block: false, message }), { action: { kind: 'append', text: message }, dropped: [] });
  });

  test('nothing to say changes nothing', () => {
    assert.deepEqual(answer('post-write', { block: false }), { action: { kind: 'pass' }, dropped: [] });
    assert.deepEqual(answer('post-write', { block: false, message: '' }), { action: { kind: 'pass' }, dropped: [] });
  });

  test('a run that gave no answer arrives as a pass, and is one', () => {
    const decision = decide('post-write', { code: 1, stdout: '', stderr: 'SyntaxError: x\n', failure: null });
    assert.equal(decision.block, false);
    assert.deepEqual(answer('post-write', decision), { action: { kind: 'pass' }, dropped: [] });
  });

  test('a notice has no way to the person, and is listed as dropped', () => {
    assert.deepEqual(answer('post-write', { block: false, notice: 'for the person', message: 'for the model' }), {
      action: { kind: 'append', text: 'for the model' },
      dropped: [{ field: 'notice', text: 'for the person' }],
    });
  });
});

describe('combine: one answer for a call several runs decided', () => {
  const pass = { action: { kind: 'pass' }, dropped: [] };
  const refuse = (text) => ({ action: { kind: 'refuse', text }, dropped: [] });
  const append = (text) => ({ action: { kind: 'append', text }, dropped: [] });
  const dropping = (text) => ({ action: { kind: 'pass' }, dropped: [{ field: 'message', text }] });

  // A patch that left several files, post-write ran on each.
  test('adds every distinct text, in the order of the runs, as one', () => {
    assert.deepEqual(combine([append('a.ts has no header'), pass, append('schemas/b.ts'), append('a.ts has no header')]).action, {
      kind: 'append',
      text: 'a.ts has no header\n\nschemas/b.ts',
    });
  });

  test('a refusal outweighs text for the result', () => {
    assert.deepEqual(combine([append('context'), refuse('no')]).action, { kind: 'refuse', text: 'no' });
  });

  test('passes when every run passed, and when there was none', () => {
    assert.deepEqual(combine([pass, pass]), pass);
    assert.deepEqual(combine([]), pass);
  });

  // The host applies a patch whole or not at all.
  test('refuses when any run refused, whatever the others said', () => {
    assert.deepEqual(combine([pass, refuse('pdkit: b.ts is not owned'), pass]).action, { kind: 'refuse', text: 'pdkit: b.ts is not owned' });
  });

  test('says every distinct reason, in the order of the runs', () => {
    assert.deepEqual(combine([refuse('first'), pass, refuse('second'), refuse('first')]).action, { kind: 'refuse', text: 'first\n\nsecond' });
  });

  test('lists what reaches no one once', () => {
    assert.deepEqual(combine([dropping('no Owns'), dropping('no Owns'), dropping('other')]).dropped, [
      { field: 'message', text: 'no Owns' },
      { field: 'message', text: 'other' },
    ]);
    assert.deepEqual(combine([{ action: { kind: 'pass' }, dropped: [{ field: 'notice', text: 'no Owns' }] }, dropping('no Owns')]).dropped.length, 2);
  });
});

// The way to the model after a tool (F29): a text part at the end of the
// result's content, after what the tool said.
describe('withText', () => {
  test('adds a text part after the parts the result has, and keeps the rest of it', () => {
    const result = { output: 'Created file successfully: a.ts', content: [{ type: 'text', text: 'Created file successfully: a.ts' }], metadata: { truncated: false } };
    assert.deepEqual(withText(result, 'pdkit: a.ts has no license header.'), {
      output: 'Created file successfully: a.ts',
      content: [
        { type: 'text', text: 'Created file successfully: a.ts' },
        { type: 'text', text: '\npdkit: a.ts has no license header.' },
      ],
      metadata: { truncated: false },
    });
  });

  test('does not change the result it is given', () => {
    const result = { content: [{ type: 'text', text: 'ok' }] };
    withText(result, 'more');
    assert.deepEqual(result, { content: [{ type: 'text', text: 'ok' }] });
  });

  // As Open Code reads a result (F28), for one another plugin replaced.
  test('reads content as the host does: a string is one part; none is the output, as text', () => {
    assert.deepEqual(withText({ content: 'ok' }, 'x').content, [
      { type: 'text', text: 'ok' },
      { type: 'text', text: '\nx' },
    ]);
    assert.deepEqual(withText({ content: [], output: 'done' }, 'x').content, [
      { type: 'text', text: 'done' },
      { type: 'text', text: '\nx' },
    ]);
    assert.deepEqual(withText({ output: {} }, 'x').content, [
      { type: 'text', text: '{}' },
      { type: 'text', text: '\nx' },
    ]);
    assert.deepEqual(withText(undefined, 'x'), { content: [{ type: 'text', text: 'x' }] });
  });

  test('keeps a part that is not text where it was', () => {
    const file = { type: 'file', mime: 'image/png', url: 'data:,' };
    assert.deepEqual(withText({ content: [file] }, 'x').content, [file, { type: 'text', text: '\nx' }]);
  });

  // A model on OpenAI's provider got the parts of a result run together, and
  // read the last file the tool named into the first word of the text (F263).
  test('starts the text on a line of its own after what the tool said, and only then', () => {
    assert.equal(withText({ content: [{ type: 'text', text: 'A a.ts' }] }, 'pdkit: x').content.at(-1).text, '\npdkit: x');
    assert.equal(withText({ content: [] }, 'pdkit: x').content.at(-1).text, 'pdkit: x');
  });
});

test('an event the bridge does not carry is a mistake, not a pass', () => {
  assert.throws(() => answer('no-such-event', { block: true, reason: 'x' }), /carries no "no-such-event"/);
  assert.throws(() => answer('toString', { block: false }), /carries no "toString"/);
});
