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

// A skill's allowed-tools, read and matched as Claude Code read and matched
// it: the entries of the key, the patterns of its Bash rules, and when a
// question Open Code asks about shell is one a grant answers. How a command
// gives the grant and what ends it is test/opencode-commands.test.js's.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { LABEL_SOURCE } from '../opencode/bridge/payload.js';
import { allowedEntries, allowedPatterns, createGrants, matches, raises } from '../opencode/allowed.js';

describe('the entries of allowed-tools', () => {
  test('separated by commas, as the skills write them', () => {
    assert.deepEqual(allowedEntries('Bash(pdkit editor), Bash(pdkit editor:*)'), ['Bash(pdkit editor)', 'Bash(pdkit editor:*)']);
  });

  test('or by spaces, which a pattern in parentheses keeps', () => {
    assert.deepEqual(allowedEntries('Bash(git add *) Bash(git commit *)  Read'), ['Bash(git add *)', 'Bash(git commit *)', 'Read']);
  });

  test('or as a YAML list', () => {
    assert.deepEqual(allowedEntries(['Bash(git status)', ' Read ', '']), ['Bash(git status)', 'Read']);
  });

  test('anything else is none', () => {
    for (const value of [undefined, null, 42, {}, '', '  ,  ']) assert.deepEqual(allowedEntries(value), [], String(value));
  });

  test('a Bash entry is a shell pattern, Bash alone is every command, any other tool is named', () => {
    assert.deepEqual(allowedPatterns('Bash(pdkit editor), Bash(pdkit editor:*), Bash, Read, mcp__playwright__browser_click'), {
      patterns: ['pdkit editor', 'pdkit editor:*', '*'],
      unknown: ['Read', 'mcp__playwright__browser_click'],
    });
  });
});

describe("a pattern, as Claude Code's Bash rules match it", () => {
  test('without a *, one exact command', () => {
    assert.equal(matches('pdkit editor', 'pdkit editor'), true);
    assert.equal(matches('pdkit editor 42', 'pdkit editor'), false);
    assert.equal(matches('pdkit edito', 'pdkit editor'), false);
  });

  test('a trailing :* is a trailing space and *, which matches the bare command too', () => {
    for (const pattern of ['pdkit editor:*', 'pdkit editor *']) {
      assert.equal(matches('pdkit editor', pattern), true, pattern);
      assert.equal(matches('pdkit editor 42', pattern), true, pattern);
      assert.equal(matches('pdkit editor 42 --json', pattern), true, pattern);
      assert.equal(matches('pdkit editorial', pattern), false, pattern);
      assert.equal(matches('pdkit edit', pattern), false, pattern);
    }
  });

  test('without the space, a * runs on into the word', () => {
    assert.equal(matches('lsof', 'ls*'), true);
    assert.equal(matches('lsof', 'ls *'), false);
  });

  test('a * elsewhere stands for any text, spaces included; the rest is literal', () => {
    assert.equal(matches('git push origin main', 'git * main'), true);
    assert.equal(matches('git main', 'git * main'), false);
    assert.equal(matches('axb', 'a.b'), false);
    assert.equal(matches('a.b', 'a.b'), true);
    assert.equal(matches('anything at all', '*'), true);
  });
});

describe('the questions a grant answers', () => {
  const grants = new Map([['ses_1', { command: 'pd:editor', patterns: ['pdkit editor', 'pdkit editor:*'], sent: true }]]);
  const question = (resources, more = {}) => ({ sessionID: 'ses_1', agent: 'build', action: 'shell', resources, effect: 'ask', ...more });

  test('about shell, asked, in a granted session, every command plain and matched', () => {
    assert.equal(raises(question(['pdkit editor 42']), grants), true);
    assert.equal(raises(question(['pdkit editor', 'pdkit editor 7']), grants), true);
  });

  test('not when one command is not matched, or nothing is asked about', () => {
    assert.equal(raises(question(['pdkit editor 42', 'touch x']), grants), false);
    assert.equal(raises(question([]), grants), false);
    assert.equal(raises(question('pdkit editor 42'), grants), false);
  });

  test('not when a command nests, redirects or chains another', () => {
    for (const command of ['pdkit editor $(id)', 'pdkit editor `id`', 'pdkit editor <(id)', 'pdkit editor 1 >x', 'pdkit editor 1 <x', 'pdkit editor 1;id', 'pdkit editor 1 & id', 'pdkit editor 1 | id', 'pdkit editor 1\nid', 'pdkit editor 1\rid']) {
      assert.equal(raises(question([command]), grants), false, command);
    }
  });

  test('not for another action, an answer already given, or another session', () => {
    assert.equal(raises(question(['pdkit editor 42'], { action: 'edit' }), grants), false);
    assert.equal(raises(question(['pdkit editor 42'], { effect: 'allow' }), grants), false);
    assert.equal(raises(question(['pdkit editor 42'], { effect: 'deny' }), grants), false);
    assert.equal(raises(question(['pdkit editor 42'], { sessionID: 'ses_2' }), grants), false);
    assert.equal(raises(null, grants), false);
  });
});

describe('a grant, from the command to the next message', () => {
  const label = { source: LABEL_SOURCE, command: 'pd:editor', arguments: '42' };

  test("lasts through the command's own prompt and ends with the next one", () => {
    const { give, take, decide } = createGrants();
    give('ses_1', 'pd:editor', ['pdkit editor:*']);
    take({ sessionID: 'ses_1', metadata: label });
    const event = { sessionID: 'ses_1', action: 'shell', resources: ['pdkit editor 42'], effect: 'ask' };
    decide(event);
    assert.equal(event.effect, 'allow');

    take({ sessionID: 'ses_1', metadata: null });
    const next = { sessionID: 'ses_1', action: 'shell', resources: ['pdkit editor 42'], effect: 'ask' };
    decide(next);
    assert.equal(next.effect, 'ask');
  });

  test("a prompt that is not the command's ends it before it is used", () => {
    const { give, take, grants } = createGrants();
    give('ses_1', 'pd:editor', ['pdkit editor:*']);
    take({ sessionID: 'ses_1', metadata: { ...label, command: 'pd:open' } });
    assert.equal(grants.has('ses_1'), false);
  });

  test('nothing is given for a command that lists nothing, or for no session', () => {
    const { give, grants } = createGrants();
    give('ses_1', 'pd:audit', []);
    give(undefined, 'pd:editor', ['pdkit editor']);
    assert.equal(grants.size, 0);
  });
});
