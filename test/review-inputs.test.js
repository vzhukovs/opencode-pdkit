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

// Tests for lib/review-inputs.js: what the review axes read besides the diff.
//
// The axes of a sandbox issue's second slice asked what its plan had settled —
// the platform a default pull sends, the fallback for an unknown host — and the
// person answered on the pull request what they had decided while planning.
// The plan had it; nothing handed it over. These are the facts `self-review
// target` hands over now: what the plan decided, the lines a body must
// disclose, and the tests owed, for a pull request and for the whole branch.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { issueDir } from '../lib/config.js';
import { render } from '../lib/render.js';
import { disclosures, reviewInputs } from '../lib/review-inputs.js';
import { writeTask } from './helpers/repo-fixture.js';

const ISSUE = 4301;
const OPTIONS = 'packages/main/src/options.ts';
const VERSION = 'packages/main/src/version.ts';

const DECISIONS = 'Asked and answered:\n- the fallback for an unknown host: linux/amd64, as Build does (operator)';
const DISCLOSE = [
  '- S1: the pull spec stops asserting a platform it never chose',
  '- S2: a default pull now sends linux/<desktop arch> instead of leaving the platform to the engine',
  '- the Build page is untouched',
].join('\n');

let home;

/**
 * A plan in the template's present shape over two tasks, each owning one file
 * of code, with what it decided. `predates` renames the four answer sections,
 * which is how a plan written before them reads.
 *
 * @param {number} issue
 * @param {{predates?: boolean}} [over]
 */
async function writePlan(issue, over = {}) {
  const gated = (file) => `\`pnpm typecheck && pnpm exec eslint ${file} && pnpm test:main\``;
  let text = await render(
    'plan',
    {
      issue,
      requirementIds: 'R1, R2',
      e2eCoverage: 'no — the operator chose unit tests alone',
      sliceCount: 2,
      context: `- \`${OPTIONS}:1\` — where the options are read`,
      reuse: 'searched: `RunOptions` in packages -> 0',
      modes: 'none: the main process only',
      interfaces: 'none',
      tasks: [
        '### T1: the options',
        '- Satisfies: R1',
        `- Owns: ${OPTIONS}`,
        `- Done when: ${gated(OPTIONS)}`,
        '- Intent: read the options (R1)',
        '',
        '### T2: the version',
        '- Satisfies: R2',
        `- Owns: ${VERSION}`,
        `- Done when: ${gated(VERSION)}`,
        '- Intent: name the version (R2)',
      ].join('\n'),
      gates: '- T1, T2: typecheck, eslint on its file, test:main',
      spdx: 'no new files',
      schemas: 'no',
      extensionApi: 'no',
      scope: 'main',
      sliceHypothesis: 'S1, then S2.',
      bodyMustDisclose: DISCLOSE,
      decisions: DECISIONS,
    },
    { home },
  );
  if (over.predates) text = text.replace(/^## (Reuse|Modes|Gates|Body must disclose)[ \t]*$/gm, '## Earlier $1');

  await mkdir(issueDir(home, issue), { recursive: true });
  await writeFile(join(issueDir(home, issue), 'plan.md'), text);
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-review-inputs-'));
  await writePlan(ISSUE);
  await writeTask({ home, issue: ISSUE, id: 'T1', satisfies: ['R1'], owns: [OPTIONS] });
  await writeTask({ home, issue: ISSUE, id: 'T2', satisfies: ['R2'], owns: [VERSION] });
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('what the review axes read besides the diff', () => {
  test('the whole branch: the plan, what it decided, every line to disclose and the tests of every task with code', async () => {
    const inputs = await reviewInputs(ISSUE, { home });

    assert.equal(inputs.plan.exists, true);
    assert.equal(inputs.plan.path, join(issueDir(home, ISSUE), 'plan.md'));
    assert.deepEqual(inputs.plan.requirements, ['R1', 'R2']);
    assert.deepEqual(inputs.decided, { openDecisions: DECISIONS, e2eCoverage: 'no — the operator chose unit tests alone' });
    assert.deepEqual(inputs.disclose, {
      predates: false,
      lines: [
        'S1: the pull spec stops asserting a platform it never chose',
        'S2: a default pull now sends linux/<desktop arch> instead of leaving the platform to the engine',
        'the Build page is untouched',
      ],
      others: 0,
    });
    assert.equal(inputs.tests.predates, false);
    assert.deepEqual(
      inputs.tests.tasks.map((task) => [task.id, task.cases, task.file]),
      [
        ['T1', 1, join(issueDir(home, ISSUE), 'tasks', 'T1.md')],
        ['T2', 1, join(issueDir(home, ISSUE), 'tasks', 'T2.md')],
      ],
    );
  });

  test('a pull request: the tests of the tasks that own its files, and the lines that name its slice or none', async () => {
    const inputs = await reviewInputs(ISSUE, { home, slice: 2, files: [VERSION] });

    assert.deepEqual(inputs.tests.tasks.map((task) => task.id), ['T2']);
    assert.deepEqual(inputs.disclose, {
      predates: false,
      lines: ['S2: a default pull now sends linux/<desktop arch> instead of leaving the platform to the engine', 'the Build page is untouched'],
      others: 1,
    });

    const single = await reviewInputs(ISSUE, { home, files: [OPTIONS, VERSION] });
    assert.deepEqual(single.tests.tasks.map((task) => task.id), ['T1', 'T2']);
    assert.equal(single.disclose.lines.length, 3, 'a single pull request discloses every line');

    const untouched = await reviewInputs(ISSUE, { home, files: ['README.md'] });
    assert.deepEqual(untouched.tests.tasks, [], 'no task with code owns a file of this pull request');
  });

  test('the preflight check reads the same lines for a slice', async () => {
    assert.deepEqual(await disclosures(ISSUE, { home, slice: 1 }), {
      plan: { path: join(issueDir(home, ISSUE), 'plan.md'), exists: true },
      predates: false,
      lines: ['S1: the pull spec stops asserting a platform it never chose', 'the Build page is untouched'],
      others: 1,
    });
  });

  test('a plan written before the answer sections still says what it decided, and lists nothing to disclose', async () => {
    const old = ISSUE + 1;
    await writePlan(old, { predates: true });

    const inputs = await reviewInputs(old, { home });
    assert.deepEqual(inputs.decided, { openDecisions: DECISIONS, e2eCoverage: 'no — the operator chose unit tests alone' });
    assert.deepEqual(inputs.disclose, { predates: true, lines: [], others: 0 });
    assert.equal(inputs.tests.predates, true);
    assert.equal((await disclosures(old, { home, slice: 2 })).predates, true);
  });

  test('with no plan, nothing was decided and nothing is to disclose', async () => {
    const none = ISSUE + 2;
    const inputs = await reviewInputs(none, { home });

    assert.deepEqual(inputs.plan, { path: join(issueDir(home, none), 'plan.md'), exists: false, requirements: [] });
    assert.equal(inputs.decided, null);
    assert.equal(inputs.disclose, null);
    assert.deepEqual(inputs.tests, { predates: true, tasks: [] });
    assert.deepEqual(await disclosures(none, { home, slice: null }), {
      plan: { path: join(issueDir(home, none), 'plan.md'), exists: false },
      predates: false,
      lines: [],
      others: 0,
    });
  });

  test("the quickfix route's tests are the ## Tests of issue.md", async () => {
    const quick = ISSUE + 3;
    const path = join(issueDir(home, quick), 'issue.md');
    await mkdir(issueDir(home, quick), { recursive: true });

    await writeFile(path, '# ISSUE 4304: a fix\n\n## Verdict\nquickfix\n');
    assert.deepEqual((await reviewInputs(quick, { home })).issueTests, { path, listed: false, cases: 0 });

    await writeFile(
      path,
      '# ISSUE 4304: a fix\n\n## Verdict\nquickfix\n\n## Tests\n| Case | When | Asserts | Fails without the fix because |\n|---|---|---|---|\n| a | b | c | d |\n| e | f | g | h |\n',
    );
    assert.deepEqual((await reviewInputs(quick, { home })).issueTests, { path, listed: true, cases: 2 });
  });
});
