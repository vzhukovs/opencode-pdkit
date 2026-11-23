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

// `pdkit self-review target`, end to end: what it hands the axes, and that it
// is where a round of the self-review starts.
//
// The axes judge against what they are given. A session that retells the issue
// from GitHub hands them a scope triage has since narrowed, so the command
// prints the triage record itself, and the session passes its output on. And a
// session that runs the axes and fixes without ever recording still runs
// rounds: the count has to start here, where the axes get the commit.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { writeReceipt } from '../lib/evidence.js';
import { read as readJournal } from '../lib/journal.js';
import { AUDIT_EVENTS, EVENTS } from '../lib/self-review.js';
import { adopt, read as readState, setOwns, transition } from '../lib/state.js';
import { approvablePlan } from './helpers/approvable-plan.js';
import { cleanup, commitAll, git, initRepo, writeFiles, writeTask } from './helpers/repo-fixture.js';

const exec = promisify(execFile);
const BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'pdkit');
const ISSUE = 4244;

let home;
let repo;
let tree;

/** @returns {Promise<{code: number, stdout: string, stderr: string}>} */
async function pdkitIn(cwd, ...args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], {
      cwd,
      env: { ...process.env, PDKIT_HOME: home },
      encoding: 'utf8',
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

/** @returns {Promise<{code: number, stdout: string, stderr: string}>} */
const pdkit = (...args) => pdkitIn(tree, ...args);

/** One more commit on the issue's branch, so the next target reads a new one. */
async function nextCommit(n) {
  await writeFiles(tree, { 'fix.ts': `export const fixed = ${n};\n` });
  await commitAll(tree, `fix(main): the thing, take ${n}`);
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-self-review-target-'));

  repo = await initRepo('pdkit-self-review-target-repo-');
  await writeFiles(repo, { 'README.md': 'x\n' });
  await commitAll(repo, 'chore: start');
  tree = await mkdtemp(join(tmpdir(), 'pdkit-self-review-target-tree-'));
  await rm(tree, { recursive: true });
  await git(['worktree', 'add', '-b', `DESKTOP-${ISSUE}/fix-thing`, tree], repo);
  await nextCommit(1);

  await writeFile(join(home, 'config.yaml'), 'repo:\n  fork: me/podman-desktop\n');
  await mkdir(join(home, 'issues'), { recursive: true });
  const adopted = await adopt(ISSUE, { home, state: 'quickfix', route: 'quickfix', reason: 'a fixture' });
  assert.ok(adopted.ok, adopted.error);
});

after(async () => {
  await cleanup(home, tree, repo);
});

describe('pdkit self-review target', () => {
  test('says when triage recorded no scope, so the axes have the issue alone', async () => {
    const result = await pdkit('self-review', 'target', '--issue', String(ISSUE));

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /triage: none recorded \(.*issue\.md\) — the axes have the issue on GitHub alone/);
  });

  test('prints the triage record the axes and the synthesis judge against', async () => {
    await writeFile(join(home, 'issues', String(ISSUE), 'issue.md'), '## Summary\n\n[operator] the legacy section only.\n');
    const result = await pdkit('self-review', 'target', '--issue', String(ISSUE));

    assert.equal(result.code, 0, result.stderr);
    const line = result.stdout.split('\n').find((text) => text.startsWith('triage:'));
    assert.ok(line, result.stdout);
    assert.match(line, new RegExp(`issues[\\\\/]${ISSUE}[\\\\/]issue\\.md`));
    assert.match(line, /the scope this pull request was cut to/);

    const json = JSON.parse((await pdkit('self-review', 'target', '--issue', String(ISSUE), '--json')).stdout);
    assert.match(json.triage, /issue\.md$/);
  });

  test('starts a round on each new commit, and refuses the fourth until a person says why', async () => {
    await nextCommit(2);
    assert.equal((await pdkit('self-review', 'target', '--issue', String(ISSUE))).code, 0);
    await nextCommit(3);
    const third = await pdkit('self-review', 'target', '--issue', String(ISSUE));
    assert.equal(third.code, 0, third.stderr);
    assert.match(third.stdout, /round: {2}3 of 3 since the last clean review/);

    await nextCommit(4);
    const fourth = await pdkit('self-review', 'target', '--issue', String(ISSUE));
    assert.equal(fourth.code, 1);
    assert.match(fourth.stderr, /Stop and ask the person/);
    assert.match(fourth.stderr, new RegExp(`pdkit self-review continue --issue ${ISSUE} --reason "`));
    assert.equal(fourth.stdout, '', 'nothing for the axes to read');

    const started = await readJournal({ issue: ISSUE, event: EVENTS.started }, { home });
    assert.equal(new Set(started.map((entry) => entry.detail)).size, 3, 'the refused round wrote nothing');

    const said = await pdkit('self-review', 'continue', '--issue', String(ISSUE), '--reason', 'the last test was the one left');
    assert.equal(said.code, 0, said.stderr);
    assert.equal((await pdkit('self-review', 'target', '--issue', String(ISSUE))).code, 0);
  });
});

// `--audit`: the review of the whole branch, once, in `/pd:audit`. What the
// axes get on top of a pull request's — the plan and each task's tests, since
// there is no body yet — where it may run, and what it says about each open
// finding: the task that owns its file, which is the one a fix starts.
describe('pdkit self-review --audit', () => {
  const AUDITED = 4246;
  const OWNED = 'packages/main/src/index.ts';
  let branchTree;

  /** One more commit on the audited branch. */
  async function nextAuditCommit(n) {
    await writeFiles(branchTree, { [OWNED]: `export const platform = ${n};\n` });
    await commitAll(branchTree, `feat(main): platform, take ${n}`);
  }

  /** @param {...string} args */
  const inBranch = (...args) => pdkitIn(branchTree, ...args);

  before(async () => {
    branchTree = await mkdtemp(join(tmpdir(), 'pdkit-self-review-audit-tree-'));
    await rm(branchTree, { recursive: true });
    await git(['worktree', 'add', '-b', `DESKTOP-${AUDITED}/pull-platform`, branchTree], repo);
    await nextAuditCommit(1);

    await approvablePlan(AUDITED, { home });
    for (const to of ['triaged', 'planned', 'plan-approved', 'implemented', 'validated']) {
      const moved = await transition(AUDITED, to, { home });
      assert.ok(moved.ok, `${to}: ${moved.error}`);
    }
    await writeTask({ home, issue: AUDITED, id: 'T1', satisfies: ['R1'], owns: [OWNED] });
    await setOwns(AUDITED, 'T1', [OWNED], { home });
    await writeReceipt({
      issue: AUDITED,
      taskId: 'T1',
      run: { command: 'true', exitCode: 0, stdout: '', stderr: '', durationMs: 1, at: '2026-11-23T10:00:00.000Z', complete: true },
      files: [OWNED],
      home,
    });
  });

  after(async () => {
    await git(['worktree', 'remove', '--force', branchTree], repo).catch(() => {});
    await cleanup(branchTree);
  });

  test('hands the axes the plan and the tests each task owes, and starts a round of its own', async () => {
    const result = await inBranch('self-review', 'target', '--issue', String(AUDITED), '--audit');
    assert.equal(result.code, 0, result.stderr);

    const line = (name) => result.stdout.split('\n').find((text) => text.startsWith(`${name}:`));
    assert.match(line('diff'), /^diff: {3}git diff \S+\.\.\.HEAD$/);
    assert.match(line('plan'), new RegExp(`issues[\\\\/]${AUDITED}[\\\\/]plan\\.md — the requirements, each task's intent and the frozen interfaces`));
    assert.match(line('tests'), /^tests: {2}T1 1 case\(s\) — /);
    assert.match(line('tests'), /a row is a test the branch owes/);
    assert.match(line('triage'), /none recorded/);
    assert.match(line('round'), /^round: {2}1 of 3 since the last clean review$/);

    const started = await readJournal({ issue: AUDITED, event: AUDIT_EVENTS.started }, { home });
    assert.equal(started.length, 1);
    assert.equal((await readJournal({ issue: AUDITED, event: EVENTS.started }, { home })).length, 0, 'not a round of a pull request');

    const json = JSON.parse((await inBranch('self-review', 'target', '--issue', String(AUDITED), '--audit', '--json')).stdout);
    assert.match(json.plan, /plan\.md$/);
    assert.deepEqual(json.tests.tasks.map((task) => [task.id, task.cases]), [['T1', 1]]);
    assert.equal(json.tests.predates, false);
  });

  test('says when the plan predates the lists of tests', async () => {
    const plan = join(home, 'issues', String(AUDITED), 'plan.md');
    const original = await readFile(plan, 'utf8');
    await writeFile(plan, original.replace(/^## (Reuse|Modes|Gates|Body must disclose)[ \t]*$/gm, '## Earlier $1'));
    try {
      const result = await inBranch('self-review', 'target', '--issue', String(AUDITED), '--audit');
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /^tests: {2}none listed — the plan predates ## Tests; the tests axis judges by section 2 alone$/m);
    } finally {
      await writeFile(plan, original);
    }
  });

  test('records the branch with no body, and names the task that owns each open finding', async () => {
    const findings = join(home, 'audit-findings.json');
    await writeFile(
      findings,
      JSON.stringify({
        axes: ['architecture', 'api-compat', 'tests', 'product'],
        findings: [
          { label: 'issue', text: 'logic in the component', path: OWNED, line: 1, section: 3 },
          { label: 'issue', text: 'a file nobody planned', path: 'packages/renderer/src/x.ts', line: 2, section: 1 },
          { label: 'nit', text: 'a name', path: OWNED, line: 1, section: 10 },
        ],
      }),
    );

    const withBody = await inBranch('self-review', 'record', '--issue', String(AUDITED), '--audit', '--findings', findings, '--body', findings);
    assert.equal(withBody.code, 1);
    assert.match(withBody.stderr, /the audit's review reads no body/);

    const recorded = await inBranch('self-review', 'record', '--issue', String(AUDITED), '--audit', '--findings', findings);
    assert.equal(recorded.code, 0, recorded.stderr);
    assert.match(recorded.stdout, /: 3 finding\(s\), 2 open/);
    assert.match(recorded.stdout, new RegExp(`${OWNED.replace(/\./g, '\\.')}:1 — issue: logic in the component → T1`));
    assert.match(recorded.stdout, /packages\/renderer\/src\/x\.ts:2 — issue: a file nobody planned → no live task owns it: a finding about the plan/);

    const shown = await inBranch('self-review', 'show', '--issue', String(AUDITED), '--audit');
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /\[open\] packages\/main\/src\/index\.ts:1 issue: logic in the component → T1/);
    assert.match(shown.stdout, /rounds since the last clean review: 1 of 3/);

    assert.equal((await readJournal({ issue: AUDITED, event: AUDIT_EVENTS.recorded }, { home })).length, 1);
  });

  test('audited is refused while the branch stands on the commit the open review read, and earned once it moved', async () => {
    const refused = await inBranch('state', String(AUDITED), '--to', 'audited');
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /left 2 finding\(s\) open, and the branch is still at/);

    await nextAuditCommit(2);
    const moved = await inBranch('state', String(AUDITED), '--to', 'audited');
    assert.equal(moved.code, 0, moved.stderr);
    assert.match(moved.stdout, new RegExp(`next: /pd:slice ${AUDITED}`));
    assert.equal((await readState(AUDITED, { home })).state, 'audited');
  });

  test('task start on a task that is done says its receipt predates the start', async () => {
    const started = await inBranch('task', 'start', '--issue', String(AUDITED), '--task', 'T1');
    assert.equal(started.code, 0, started.stderr);
    assert.match(
      started.stdout,
      new RegExp(`T1 is done, and its receipt was captured before this start: what changes now is not in it until pdkit receipt write --issue ${AUDITED} --task T1 captures again`),
    );
    assert.equal((await inBranch('task', 'stop')).code, 0);
  });

  test('continue takes a sentence for the audit alone', async () => {
    const said = await inBranch('self-review', 'continue', '--issue', String(AUDITED), '--audit', '--reason', 'the plan was amended');
    assert.equal(said.code, 0, said.stderr);
    assert.match(said.stdout, new RegExp(`the review of issue ${AUDITED}'s whole branch may run again; the count of rounds starts over`));
    assert.equal((await readJournal({ issue: AUDITED, event: AUDIT_EVENTS.continued }, { home })).length, 1);
  });

  test('is refused with --slice, on the quickfix route, and outside the audit', async () => {
    const both = await inBranch('self-review', 'target', '--issue', String(AUDITED), '--audit', '--slice', '1');
    assert.equal(both.code, 1);
    assert.match(both.stderr, /--audit and --slice name different things/);

    const quick = await pdkit('self-review', 'target', '--issue', String(ISSUE), '--audit');
    assert.equal(quick.code, 1);
    assert.match(quick.stderr, new RegExp(`issue ${ISSUE} is on the quickfix route, which has no audit`));

    const early = 4247;
    await approvablePlan(early, { home });
    for (const to of ['triaged', 'planned', 'plan-approved', 'implemented']) await transition(early, to, { home });
    const before = await inBranch('self-review', 'target', '--issue', String(early), '--audit');
    assert.equal(before.code, 1);
    assert.match(before.stderr, new RegExp(`issue ${early} is implemented; the review of the whole branch is /pd:audit's, from validated or audited`));
  });

  test('is refused from another issue\'s tree', async () => {
    const foreign = await pdkit('self-review', 'target', '--issue', String(AUDITED), '--audit');
    assert.equal(foreign.code, 1);
    assert.match(foreign.stderr, new RegExp(`this tree is not DESKTOP-${AUDITED}'s`));
  });
});
