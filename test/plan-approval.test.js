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

// The approval of a plan could be typed: no rule read the plan or the freeze,
// and the freeze was held by the `&&` in the approval line alone. These hold
// the two places that read them now — the move to `plan-approved` and
// `pdkit ids freeze`, which runs first in that line — to the same answer.

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { issueDir } from '../lib/config.js';
import { render } from '../lib/render.js';
import { allocateRequirement, freezeRequirements, read, transition } from '../lib/state.js';
import { approvablePlan } from './helpers/approvable-plan.js';

const exec = promisify(execFile);
const BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'pdkit');
const ISSUE = 17101;

let home;
const homes = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-plan-approval-'));
  homes.push(home);
  await transition(ISSUE, 'triaged', { home, route: 'standard' });
  await transition(ISSUE, 'planned', { home });
});

after(async () => {
  for (const dir of homes) await rm(dir, { recursive: true, force: true });
});

/**
 * Run the CLI against this test's own state directory, refusals included.
 *
 * @param {...string} args
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
async function pdkit(...args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], { env: { ...process.env, PDKIT_HOME: home } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

/** The helper's one `Done when`. */
const GATED = '- Done when: `pnpm typecheck:main && pnpm exec eslint packages/main/src/index.ts && pnpm test:main`';

/** The helper's plan with its one `Done when` written as prose, which `plan check` refuses. */
async function proseDoneWhen() {
  const path = join(issueDir(home, ISSUE), 'plan.md');
  const text = await readFile(path, 'utf8');
  assert.ok(text.includes(GATED));
  await writeFile(path, text.replace(GATED, '- Done when: the registry works'));
}

describe('the move to plan-approved', () => {
  test('is refused with no plan, and says where it looked', async () => {
    const moved = await transition(ISSUE, 'plan-approved', { home });

    assert.equal(moved.ok, false);
    assert.match(moved.error, /^issue 17101: the plan fails its mechanical checks, so it cannot be approved:/);
    assert.match(moved.error, /plan: there is no plan at .*plan\.md/);
    assert.equal((await read(ISSUE, { home })).state, 'planned');
  });

  test('is refused on a plan `plan check` refuses, with what failed and the command that shows it', async () => {
    await approvablePlan(ISSUE, { home });
    await proseDoneWhen();

    const moved = await transition(ISSUE, 'plan-approved', { home });

    assert.equal(moved.ok, false);
    assert.match(moved.error, /done-when: T1 has no executable "Done when": "the registry works"/);
    assert.match(moved.error, /Run: pdkit plan check 17101\./);
  });

  test('is refused while the requirement set is open', async () => {
    await approvablePlan(ISSUE, { home, freeze: false });

    const moved = await transition(ISSUE, 'plan-approved', { home });

    assert.equal(moved.ok, false);
    assert.match(moved.error, /the requirement set is not frozen/);
    assert.match(moved.error, /Run: pdkit ids freeze 17101, then this move again\./);
  });

  test('goes through on a plan that passes, over a frozen set', async () => {
    await approvablePlan(ISSUE, { home });

    const moved = await transition(ISSUE, 'plan-approved', { home });

    assert.equal(moved.ok, true, moved.error);
  });
});

describe('pdkit ids freeze', () => {
  // Frozen on a refused plan, the set could not take the requirement a fix
  // needs, and nothing unfreezes it short of a rework.
  test('refuses on a plan that fails its checks, and leaves the set open', async () => {
    await approvablePlan(ISSUE, { home, freeze: false });
    await proseDoneWhen();

    const out = await pdkit('ids', 'freeze', String(ISSUE));

    assert.notEqual(out.code, 0);
    assert.match(out.stderr, /the plan fails its mechanical checks, so its requirement set is not frozen/);
    assert.equal((await read(ISSUE, { home })).requirements.frozen, false);
    assert.equal((await pdkit('ids', 'requirement', String(ISSUE))).code, 0, 'a requirement can still be allocated');
  });

  test('freezes on a plan that passes, and the approval line then goes through', async () => {
    await approvablePlan(ISSUE, { home, freeze: false });

    const out = await pdkit('ids', 'freeze', String(ISSUE));
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stdout, 'R1\n');

    const moved = await pdkit('state', String(ISSUE), '--to', 'plan-approved');
    assert.equal(moved.code, 0, moved.stderr);
  });
});

// The approval reads what `plan check` reads, the task files included: a plan
// whose tasks list their tests is approved only while every task that owns
// code lists its cases. A plan written before those sections were asked is
// approved as it was, and nothing it was not asked for is asked of it.
describe('a plan whose tasks list their tests', () => {
  const ROW = '| the registry starts | a provider is registered | `start` resolves | it rejects without the fix |';

  /** The helper's plan with T1's cases taken out of its block, so that only its task file can carry them. */
  async function withoutCasesInBlock() {
    const path = join(issueDir(home, ISSUE), 'plan.md');
    const text = await readFile(path, 'utf8');
    assert.match(text, /- Tests:\n {2}\|/);
    await writeFile(path, text.replace(/- Tests:\n(?: {2}\|.*\n)+/, ''));
  }

  /** tasks/T1.md, rendered from the template, with `tests` as its rows. */
  async function taskFile(tests) {
    const dir = join(issueDir(home, ISSUE), 'tasks');
    await mkdir(dir, { recursive: true });
    const text = await render('task', {
      taskId: 'T1',
      title: 'a fixture task',
      issue: String(ISSUE),
      satisfies: 'R1',
      status: 'pending',
      attempts: '0',
      ownedFiles: ['- packages/main/src/index.ts'],
      command: 'pnpm typecheck:main && pnpm exec eslint packages/main/src/index.ts && pnpm test:main',
      expected: 'exit 0',
      context: '—',
      tests,
      steps: '—',
      notes: '—',
    });
    await writeFile(join(dir, 'T1.md'), text);
  }

  test('the approval reads the task file: refused while T1 lists no case, through once it does', async () => {
    await approvablePlan(ISSUE, { home });
    await withoutCasesInBlock();
    await taskFile('');

    const refused = await transition(ISSUE, 'plan-approved', { home });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /tests: T1 owns code \(packages\/main\/src\/index\.ts\) and lists no test case under "## Tests"/);

    await taskFile(ROW);
    const moved = await transition(ISSUE, 'plan-approved', { home });
    assert.equal(moved.ok, true, moved.error);
  });

  test('pdkit plan check says the same, from the same files', async () => {
    await approvablePlan(ISSUE, { home });
    await withoutCasesInBlock();
    await taskFile('');

    const refused = await pdkit('plan', 'check', String(ISSUE));
    assert.notEqual(refused.code, 0);
    assert.match(refused.stdout, /^ {2}✘ tests {12}T1 owns code \(packages\/main\/src\/index\.ts\) and lists no test case under "## Tests"/m);

    await taskFile(ROW);
    const passed = await pdkit('plan', 'check', String(ISSUE));
    assert.equal(passed.code, 0, passed.stdout);
    assert.doesNotMatch(passed.stdout, /format/);
  });

  test('a plan written before those sections is approved as it was, and plan check says what it did not ask', async () => {
    const allocated = await allocateRequirement(ISSUE, { home });
    assert.equal(allocated.ok, true);
    await writeFile(
      join(issueDir(home, ISSUE), 'plan.md'),
      [
        `# PLAN: DESKTOP-${ISSUE}`,
        '',
        '- Requirements: R1 (frozen on approval)',
        '- e2e coverage: no — a fixture',
        '- Slice hypothesis: 1 slices',
        '',
        '## Context',
        '- `packages/main/src/index.ts:1` — the file the fixture task owns',
        '',
        '## Frozen interfaces',
        '```ts',
        'none',
        '```',
        '',
        '## Tasks',
        '### T1: a fixture task',
        '- Satisfies: R1',
        '- Owns: packages/main/src/index.ts',
        '- Done when: `pnpm test:main`',
        '- Intent: written before a task listed its tests',
        '',
        '## Upstream compliance',
        '- SPDX headers needed: no new files',
        '- Schemas touched: no',
        '- `extension-api.d.ts` touched: no',
        '- Commit scope: main',
        '',
        '## Slice hypothesis',
        'One slice.',
        '',
        '## Open decisions',
        'none',
        '',
      ].join('\n'),
    );
    const frozen = await freezeRequirements(ISSUE, { home });
    assert.equal(frozen.ok, true);

    const checked = await pdkit('plan', 'check', String(ISSUE));
    assert.equal(checked.code, 0, checked.stdout);
    assert.match(checked.stdout, /^ {2}! format {11}the plan has none of the sections Reuse, Modes, Gates and Body must disclose/m);

    const moved = await transition(ISSUE, 'plan-approved', { home });
    assert.equal(moved.ok, true, moved.error);
  });
});
