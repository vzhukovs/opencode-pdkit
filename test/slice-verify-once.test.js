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

// Contract for how often `slice verify` builds, and what a build runs.
//
// One build is minutes of the repository's whole typecheck, lint and scoped
// tests. On a podman-desktop issue: seven runs, fifty-three minutes, and four of
// the twelve builds inside them built a tree that had already passed, or
// measured the same base commit a second time. What is defended here is that
// the minutes go to builds nobody has made: a tree that passed before is taken
// from that run and named as taken, a red one never is; the base a red slice is
// compared with is measured once per commit; and lint runs beside the typecheck
// and the tests rather than after them.
//
// The fixture's scripts write when they start and end to a file outside every
// tree, so a build that did not run is something the test can see.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { approvablePlan } from './helpers/approvable-plan.js';
import { auditReviewed } from './helpers/audit-review.js';
import { cleanup, commitAll, git, initRepo, packageMap, seedWorkspace, writeFiles, writeTask } from './helpers/repo-fixture.js';
import { issueDir } from '../lib/config.js';
import { validateReceipt } from '../lib/evidence.js';
import * as ids from '../lib/ids.js';
import * as slice from '../lib/slice.js';
import * as state from '../lib/state.js';

const ISSUE = 4343;

const API = 'packages/extension-api/src/api.ts';
const EXEC = 'packages/main/src/exec.ts';
const THEME = 'packages/ui/src/theme.ts';

let repo;
let home;
let trees;
let marks;

/** @returns {object} the config, with the worktree root beside the fixture */
function config(verify = {}) {
  return {
    repo: { base_branch: 'main', package_manager: 'npm' },
    branches: { single: 'DESKTOP-{issue}/{slug}', sliced: 'DESKTOP-{issue}/{index}-{slug}' },
    slicing: {
      strategy: 'prefer-independent',
      max_files_per_slice: 12,
      layer_order: ['extension-api', 'main', 'ui', 'tests'],
      verify: { worktree: 'reuse', install: 'never', ...verify },
    },
    worktrees: { root: trees, copy_files: [] },
  };
}

/**
 * A script that records when it started and ended, waits long enough for two of
 * them to overlap when they run together, and fails when `when` holds.
 *
 * @param {string} name
 * @param {string} when  a function of `read`, as source
 * @returns {string}
 */
function script(name, when) {
  return [
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    '',
    "const log = join(process.env.PDKIT_FIXTURE_MARKS ?? '.', 'runs.log');",
    `appendFileSync(log, \`${name} start \${Date.now()}\\n\`);`,
    'await new Promise((resolve) => setTimeout(resolve, 300));',
    "const read = (path) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };",
    `const failed = (${when})(read);`,
    `appendFileSync(log, \`${name} end \${Date.now()}\\n\`);`,
    `if (failed) { console.error('${name} failed'); process.exit(2); }`,
    `console.log('${name} ok');`,
    '',
  ].join('\n');
}

/** @returns {Promise<string[]>} the lines one script wrote, oldest first */
async function lines(name) {
  try {
    return (await readFile(join(marks, 'runs.log'), 'utf8')).split('\n').filter((line) => line.startsWith(`${name} `));
  } catch {
    return [];
  }
}

/** How many times a script started. */
const runs = async (name) => (await lines(name)).filter((line) => line.includes(' start ')).length;

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

before(async () => {
  repo = await initRepo('pdkit-once-');
  home = await initRepo('pdkit-once-home-');
  trees = join(repo, '..', `${basename(repo)}-trees`);
  marks = await mkdtemp(join(tmpdir(), 'pdkit-once-marks-'));
  process.env.PDKIT_FIXTURE_MARKS = marks;

  await seedWorkspace(repo);
  await writeFiles(repo, {
    'scripts/typecheck.mjs': script(
      'typecheck',
      '(read) => read("packages/main/src/exec.ts").includes("RunOptions") && !read("packages/extension-api/src/api.ts").includes("interface RunOptions")',
    ),
    'scripts/lint.mjs': script('lint', '(read) => read("packages/ui/src/theme.ts").includes("lint-error")'),
    'scripts/test.mjs': script('test', '() => false'),
  });
  const manifest = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
  manifest.scripts = {
    ...manifest.scripts,
    typecheck: 'node scripts/typecheck.mjs',
    'lint:check': 'node scripts/lint.mjs',
    'test:unit': 'node scripts/test.mjs',
    'test:main': 'node scripts/test.mjs',
    'test:ui': 'node scripts/test.mjs',
  };
  await writeFile(join(repo, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await commitAll(repo, 'chore: seed');

  await git(['checkout', '-b', `DESKTOP-${ISSUE}/work`], repo);
  await writeFiles(repo, {
    [API]: '// SPDX-License-Identifier: Apache-2.0\nexport const version = 1;\nexport interface RunOptions { env?: string }\n',
    [EXEC]: '// SPDX-License-Identifier: Apache-2.0\nimport type { RunOptions } from "@fixture/api";\nexport function exec(_options: RunOptions) {}\n',
    [THEME]: '// SPDX-License-Identifier: Apache-2.0\nexport const theme = "high-contrast";\n',
  });
  await commitAll(repo, 'feat: the whole change set');

  await state.transition(ISSUE, 'triaged', { home });
  await state.transition(ISSUE, 'planned', { home });
  for (let i = 0; i < 3; i += 1) await ids.allocateRequirement(ISSUE, { home });
  await ids.freezeRequirements(ISSUE, { home });
  await writeTask({ home, issue: ISSUE, id: 'T1', satisfies: ['R1'], owns: [API] });
  await writeTask({ home, issue: ISSUE, id: 'T2', satisfies: ['R2'], owns: [EXEC] });
  await writeTask({ home, issue: ISSUE, id: 'T3', satisfies: ['R3'], owns: [THEME] });

  const facts = await slice.facts({ issue: ISSUE, repoRoot: repo, home, config: config(), packageMap: packageMap(repo) });
  const stored = await slice.set({
    issue: ISSUE,
    facts,
    config: config(),
    home,
    proposal: {
      strategy: 'prefer-independent',
      whyDeviates: 'the fixture wants a stack beside an independent slice',
      slices: [
        { slug: 'extension-api-run-options', title: 'add RunOptions', files: [API], baseSlice: null, whySeparate: 'api', selfJustifying: 'yes' },
        { slug: 'main-exec-options', title: 'exec takes options', files: [EXEC], baseSlice: 1, whySeparate: 'main', selfJustifying: 'yes' },
        { slug: 'ui-contrast', title: 'high contrast', files: [THEME], baseSlice: null, whySeparate: 'ui', selfJustifying: 'yes' },
      ],
    },
  });
  assert.equal(stored.ok, true, JSON.stringify(stored.problems));
});

after(async () => {
  delete process.env.PDKIT_FIXTURE_MARKS;
  await cleanup(repo, home, trees);
  await rm(marks, { recursive: true, force: true });
});

/**
 * @param {number} index
 * @param {{prepare?: string[], standalone?: boolean}} [options]
 */
function verify(index, options = {}) {
  return slice.verifySlice({
    issue: ISSUE,
    index,
    repoRoot: repo,
    home,
    config: config(options.prepare ? { prepare: options.prepare } : {}),
    packageMap: packageMap(repo),
    ...(options.standalone ? { standalone: true } : {}),
  });
}

const receipt = (index) => readFile(join(issueDir(home, ISSUE), 'verify', `S${index}.md`), 'utf8');
const journal = () => readFile(join(home, 'journal', `${new Date().toISOString().slice(0, 7)}.md`), 'utf8');

describe('a tree is built once', () => {
  test('the same tree, green before, is taken from that run and says so', async () => {
    const first = await verify(1);
    assert.equal(first.ok, true, first.error ?? first.output);
    assert.match(first.verification.tree, /^[0-9a-f]{40}$/);
    assert.deepEqual(first.verification.prepare, []);
    const built = await runs('typecheck');
    const evidence = await receipt(1);

    const second = await verify(1);

    assert.equal(second.ok, true, second.error);
    assert.equal(second.reused, true);
    assert.equal(await runs('typecheck'), built, 'the command ran again');
    assert.equal(await receipt(1), evidence, 'the receipt was written again');
    assert.equal(second.verification.tree, first.verification.tree);
    assert.equal(second.verification.verifiedAt, first.verification.verifiedAt, 'the time is the run that measured it');
    assert.equal(second.verification.evidence, 'verify/S1.md');
    assert.equal(second.verification.standalone, true);
    assert.equal(second.verification.revertsCleanly, true);
    assert.match(second.verification.reusedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(
      await journal(),
      new RegExp(
        `event:slice-verify-reused\\s+standalone, the same tree ${first.verification.tree.slice(0, 12)} as the run of ` +
          `${escape(first.verification.verifiedAt)}, verify/S1\\.md`,
      ),
    );
    assert.equal(slice.verdict(second.verification), 'green');
  });

  test('a red verification is built again', async () => {
    const first = await verify(2, { standalone: true });
    assert.equal(first.ok, false);
    const before_ = await runs('typecheck');

    const second = await verify(2, { standalone: true });

    assert.equal(second.ok, false);
    assert.notEqual(second.reused, true);
    assert.equal(await runs('typecheck'), before_ + 1, 'the slice ran again, and the base it is compared with did not');
    assert.notEqual(second.verification.verifiedAt, first.verification.verifiedAt);
  });

  test('another preparation is another build, both ways', async () => {
    await verify(1);
    const before_ = await runs('typecheck');

    const prepared = await verify(1, { prepare: ['build:marker'] });
    assert.notEqual(prepared.reused, true);
    assert.deepEqual(prepared.verification.prepare, ['build:marker']);

    const back = await verify(1);
    assert.notEqual(back.reused, true);
    assert.equal(await runs('typecheck'), before_ + 2);
  });

  test('a record from before trees were kept, of another command, or whose receipt is gone is built again', async () => {
    const path = join(issueDir(home, ISSUE), 'slices.json');
    const edit = async (change) => {
      const graph = JSON.parse(await readFile(path, 'utf8'));
      change(graph.slices[0].verification);
      await writeFile(path, `${JSON.stringify(graph, null, 2)}\n`);
    };

    await verify(1);
    await edit((verification) => delete verification.tree);
    assert.notEqual((await verify(1)).reused, true, 'a record without a tree');

    await edit((verification) => {
      verification.command = 'npm run typecheck';
    });
    assert.notEqual((await verify(1)).reused, true, 'a record of another command');

    await rm(join(issueDir(home, ISSUE), 'verify', 'S1.md'));
    assert.notEqual((await verify(1)).reused, true, 'a record whose receipt is gone');
    assert.equal((await verify(1)).reused, true, 'and the build after it is taken again');
  });
});

describe('a materialized branch', () => {
  before(async () => {
    await approvablePlan(ISSUE, { home });
    await auditReviewed(ISSUE, { home });
    for (const next of ['plan-approved', 'implemented', 'validated', 'audited', 'sliced']) {
      const moved = await state.transition(ISSUE, next, { home });
      assert.equal(moved.ok, true, moved.error);
    }
    const approved = await state.transition(ISSUE, 'slices-approved', { home, approvedBy: 'the owner' });
    assert.equal(approved.ok, true, approved.error);
  });

  test('of the tree the change set built takes the change set run', async () => {
    const change = await verify(1);
    assert.equal(change.ok, true, change.error);
    const before_ = await runs('typecheck');

    const made = await slice.materialize({ issue: ISSUE, index: 1, repoRoot: repo, subject: 'feat(extension-api): add RunOptions', home, config: config() });
    assert.equal(made.ok, true, made.error);
    try {
      const branch = await verify(1);

      assert.equal(branch.ok, true, branch.error);
      assert.equal(branch.reused, true);
      assert.equal(branch.verification.tree, change.verification.tree);
      assert.equal(branch.verification.standalone, true);
      assert.equal(await runs('typecheck'), before_);
    } finally {
      await git(['checkout', `DESKTOP-${ISSUE}/work`], repo);
    }
  });

  // The base a red slice is compared with is `main`, measured once per commit of
  // it. It was cached by the commit of the tree the slice was built in, and for
  // a branch that is the branch itself: every fix on it measured the same base
  // again.
  test('red at two commits measures the base once', async () => {
    const made = await slice.materialize({ issue: ISSUE, index: 3, repoRoot: repo, subject: 'feat(ui): high contrast', home, config: config() });
    assert.equal(made.ok, true, made.error);
    const cache = join(issueDir(home, ISSUE), 'verify', 'baseline.json');

    try {
      await writeFiles(repo, { [THEME]: '// SPDX-License-Identifier: Apache-2.0\nexport const theme = "lint-error one";\n' });
      await commitAll(repo, 'feat(ui): one');
      const first = await verify(3);
      assert.equal(first.ok, false);
      assert.equal(first.verification.baselineOk, true);
      const measured = JSON.parse(await readFile(cache, 'utf8'));
      const lintRuns = await runs('lint');

      await writeFiles(repo, { [THEME]: '// SPDX-License-Identifier: Apache-2.0\nexport const theme = "lint-error two";\n' });
      await commitAll(repo, 'feat(ui): two');
      const second = await verify(3);

      assert.equal(second.ok, false);
      assert.equal(second.verification.baselineOk, true);
      assert.equal(await runs('lint'), lintRuns + 1, 'the base was measured again');
      assert.deepEqual(JSON.parse(await readFile(cache, 'utf8')), measured);
      const main = await git(['rev-parse', 'main'], repo);
      assert.ok(Object.keys(measured).every((key) => key.startsWith(`${main}:`)), JSON.stringify(measured));
    } finally {
      await git(['checkout', `DESKTOP-${ISSUE}/work`], repo);
    }
  });
});

describe('lint beside the typecheck and the tests', () => {
  test('runs at the same time, in one receipt, with each part under its own command', async () => {
    const result = await verify(1, { prepare: ['build:marker'] });
    assert.equal(result.ok, true, result.error ?? result.output);
    assert.notEqual(result.reused, true);
    assert.equal(result.verification.command, 'npm run typecheck && npm run test:unit & npm run lint:check');

    const at = (line) => Number(line.split(' ').pop());
    const [lintStart, lintEnd] = (await lines('lint')).slice(-2).map(at);
    const [typeStart, typeEnd] = (await lines('typecheck')).slice(-2).map(at);
    assert.ok(lintStart < typeEnd && typeStart < lintEnd, 'lint and the typecheck did not overlap');

    const text = await receipt(1);
    assert.equal(validateReceipt(text).ok, true, validateReceipt(text).reason);
    assert.match(text, /^\$ npm run typecheck && npm run test:unit$/m);
    assert.match(text, /^\$ npm run lint:check$/m);
  });

  test('a typecheck that fails skips the tests and not lint, and the run is red', async () => {
    const lintBefore = await runs('lint');
    const testBefore = await runs('test');

    const result = await verify(2, { standalone: true });

    assert.equal(result.ok, false);
    assert.equal(await runs('lint'), lintBefore + 1, 'lint did not run beside the failing typecheck');
    assert.equal(await runs('test'), testBefore, 'the tests ran after a failed typecheck');
    const text = await receipt(2);
    assert.match(text, /typecheck failed/);
    assert.match(text, /lint ok/);
  });
});
