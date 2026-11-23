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
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { writeReceipt } from '../lib/evidence.js';
import { read as readJournal } from '../lib/journal.js';
import { render } from '../lib/render.js';
import { AUDIT_EVENTS, EVENTS } from '../lib/self-review.js';
import * as slice from '../lib/slice.js';
import { adopt, allocateRequirement, freezeRequirements, read as readState, setOwns, transition } from '../lib/state.js';
import { approvablePlan } from './helpers/approvable-plan.js';
import { auditReviewed } from './helpers/audit-review.js';
import { cleanup, commitAll, git, initRepo, packageMap, seedWorkspace, writeFiles, writeTask } from './helpers/repo-fixture.js';

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

// The grep before a round: maintainer-rules on the commit the axes would read.
// A rule with no exception broken there is fixed first, and no round is spent
// finding it; a rule with a condition of its own is the axes' to judge, so its
// lines come with the rest of what they get.
describe('pdkit self-review target and the grep', () => {
  const GREPPED = 4248;
  const SPEC = 'packages/renderer/src/lib/Card.spec.ts';
  let grepTree;

  /** @param {...string} args */
  const inGrep = (...args) => pdkitIn(grepTree, ...args);

  /** Commit the spec with these lines in it. */
  async function spec(lines, message) {
    await writeFiles(grepTree, { [SPEC]: `${lines.join('\n')}\n` });
    return commitAll(grepTree, message);
  }

  before(async () => {
    grepTree = await mkdtemp(join(tmpdir(), 'pdkit-self-review-grep-tree-'));
    await rm(grepTree, { recursive: true });
    await git(['worktree', 'add', '-b', `DESKTOP-${GREPPED}/card`, grepTree], repo);
    const adopted = await adopt(GREPPED, { home, state: 'quickfix', route: 'quickfix', reason: 'a fixture' });
    assert.ok(adopted.ok, adopted.error);
  });

  after(async () => {
    await git(['worktree', 'remove', '--force', grepTree], repo).catch(() => {});
    await cleanup(grepTree);
  });

  test('refuses a commit the grep fails, before a round starts', async () => {
    const sha = await spec(
      ["test('the card', () => {", "  vi.spyOn(window, 'getConfiguration');", '  const card = found as HTMLElement;', '});'],
      'test(renderer): spy on it',
    );

    const refused = await inGrep('self-review', 'target', '--issue', String(GREPPED));
    assert.equal(refused.code, 1);
    assert.equal(refused.stdout, '', 'nothing for the axes to read');
    assert.match(
      refused.stderr,
      new RegExp(
        `^pdkit self-review target: maintainer-rules fails on ${sha.slice(0, 8)}: vi\\.spyOn ×1 \\(§2\\), as <Type> on a value ×1 \\(§4\\)\\. ` +
          'What a grep sees is fixed before any axis reads the code, so no round has started\\n',
      ),
    );
    assert.match(refused.stderr, /^ {2}vi\.spyOn — §2\n {4}packages\/renderer\/src\/lib\/Card\.spec\.ts: vi\.spyOn\(window, 'getConfiguration'\);$/m);
    assert.match(refused.stderr, /^ {2}as <Type> on a value — §4\n {4}packages\/renderer\/src\/lib\/Card\.spec\.ts: const card = found as HTMLElement;$/m);
    assert.match(refused.stderr, /fix the code, commit it, and run pdkit self-review target again/);
    assert.deepEqual(await readJournal({ issue: GREPPED, event: EVENTS.started }, { home }), [], 'the refused round wrote nothing');
  });

  // The rule against comments is the plugin's own, stricter than section 4,
  // so the refusal names the file that made it strict rather than sending the
  // reader to a section that only asks for useless comments to go.
  test('refuses a comment, and names the file that made the rule strict', async () => {
    const sha = await spec(["test('the card', () => {", '  // keep in sync with the list', '  expect(cards).toEqual([]);', '});'], 'test(renderer): a note');

    const refused = await inGrep('self-review', 'target', '--issue', String(GREPPED));
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, new RegExp(`^pdkit self-review target: maintainer-rules fails on ${sha.slice(0, 8)}: a comment ×1 \\(§4\\)\\. `));
    assert.match(
      refused.stderr,
      /^ {2}a comment — §4, made strict by agents\/pd-implementer\.md\n {4}packages\/renderer\/src\/lib\/Card\.spec\.ts: \/\/ keep in sync with the list$/m,
    );
    assert.match(
      refused.stderr,
      /Each is a rule with no exception \(knowledge\/maintainer-rules\.md, the section named; the plugin's own where a file made it strict\): fix the code, commit it, and run pdkit self-review target again/,
    );
    assert.deepEqual(await readJournal({ issue: GREPPED, event: EVENTS.started }, { home }), [], 'the refused round wrote nothing');
  });

  test('prints what the grep leaves to the axes, and starts the round', async () => {
    const sha = await spec(["test('the card', () => {", "  const images = [{ Id: '1' } as ImageInfo];", '});'], 'test(renderer): a fixture');

    const result = await inGrep('self-review', 'target', '--issue', String(GREPPED));
    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stdout,
      /^grep: {3}to judge: as <Type> on an object or array literal ×1 \(§4\) — rules with a condition of their own, which the axes rule on line by line:$/m,
    );
    assert.match(
      result.stdout,
      /^ {2}as <Type> on an object or array literal — §4\n {4}packages\/renderer\/src\/lib\/Card\.spec\.ts: const images = \[\{ Id: '1' \} as ImageInfo\];$/m,
    );
    const lines = result.stdout.split('\n');
    assert.ok(lines.findIndex((line) => line.startsWith('grep:')) < lines.findIndex((line) => line.startsWith('round:')), 'the grep before the round');
    const started = await readJournal({ issue: GREPPED, event: EVENTS.started }, { home });
    assert.deepEqual(started.map((entry) => entry.detail), [sha.slice(0, 8)]);

    const json = JSON.parse((await inGrep('self-review', 'target', '--issue', String(GREPPED), '--json')).stdout);
    assert.equal(json.grep.status, 'warn');
    assert.deepEqual(json.grep.hits.map((hit) => [hit.label, hit.strict, hit.path]), [['as <Type> on an object or array literal', false, SPEC]]);
  });

  test('says in one line when the grep found nothing', async () => {
    await spec(["test('the card', () => {});"], 'test(renderer): plain');

    const result = await inGrep('self-review', 'target', '--issue', String(GREPPED));
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^grep: {3}none of the greppable maintainer rules hit$/m);

    const json = JSON.parse((await inGrep('self-review', 'target', '--issue', String(GREPPED), '--json')).stdout);
    assert.deepEqual(json.grep, { status: 'pass', summary: 'none of the greppable maintainer rules hit', hits: [] });
  });

  test('at the round limit says so, before anything the grep found', async () => {
    // Two rounds so far, the fixture's and the plain one: a third, then a fourth that breaks a rule.
    await spec(["test('the card', () => { expect(1).toBe(1); });"], 'test(renderer): a third');
    assert.equal((await inGrep('self-review', 'target', '--issue', String(GREPPED))).code, 0);
    await spec(["test('the card', () => {", "  vi.spyOn(window, 'getConfiguration');", '});'], 'test(renderer): spy again');

    const refused = await inGrep('self-review', 'target', '--issue', String(GREPPED));
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /Stop and ask the person/);
    assert.doesNotMatch(refused.stderr, /maintainer-rules/);
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

  test('quotes what the plan decided, and every line of Body must disclose for the bodies still to be written', async () => {
    const result = await inBranch('self-review', 'target', '--issue', String(AUDITED), '--audit');
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^decided: ## Open decisions and e2e coverage, as the plan wrote them:\n {2}e2e coverage: no — a fixture$/m);
    assert.match(result.stdout, /^disclose: none — the plan's ## Body must disclose names nothing$/m);

    const plan = join(home, 'issues', String(AUDITED), 'plan.md');
    const original = await readFile(plan, 'utf8');
    await writeFile(plan, original.replace(/(^## Body must disclose\n<!--[\s\S]*?-->\n)none$/m, '$1- S1: the fixture behavior changes\n- S2: a duplication kept on purpose'));
    try {
      const all = await inBranch('self-review', 'target', '--issue', String(AUDITED), '--audit');
      assert.equal(all.code, 0, all.stderr);
      assert.match(
        all.stdout,
        /^disclose: 2 line\(s\) of ## Body must disclose, for the bodies \/pd:pr writes:\n {2}- S1: the fixture behavior changes\n {2}- S2: a duplication kept on purpose$/m,
      );
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

  test('refuses a branch the grep fails, naming the task that owns each line', async () => {
    await writeFiles(branchTree, { [OWNED]: 'export function platform(): number {\n  return 3;\n}\n' });
    const sha = await commitAll(branchTree, 'feat(main): platform as a function');
    const before = (await readJournal({ issue: AUDITED, event: AUDIT_EVENTS.started }, { home })).length;

    const refused = await inBranch('self-review', 'target', '--issue', String(AUDITED), '--audit');
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, new RegExp(`maintainer-rules fails on ${sha.slice(0, 8)}: export function in packages/main ×1 \\(§6\\)\\.`));
    assert.match(refused.stderr, /^ {4}packages\/main\/src\/index\.ts: export function platform\(\): number \{ → T1$/m);
    assert.equal((await readJournal({ issue: AUDITED, event: AUDIT_EVENTS.started }, { home })).length, before, 'no round started');

    await nextAuditCommit(5);
    const fixed = await inBranch('self-review', 'target', '--issue', String(AUDITED), '--audit');
    assert.equal(fixed.code, 0, fixed.stderr);
    assert.match(fixed.stdout, /^grep: {3}none of the greppable maintainer rules hit$/m);
  });
});

// What the plan decided, for the self-review of a pull request: the axes of a
// sandbox issue's second slice asked what its plan had settled, and the person
// answered on the pull request what they had decided while planning. `target`
// quotes it now, beside the triage record — the Open decisions and the e2e
// coverage, the lines of Body must disclose this pull request has to say, and
// the tests its tasks owe — and says so when a plan predates the sections, or
// when there is no plan at all.

const DECISIONS = 'Asked and answered:\n- the fallback for an unknown host: linux/amd64, as Build does (operator)';
const E2E = 'no — the operator chose unit tests alone';
const DISCLOSE = [
  '- S1: the pull spec stops asserting a platform it never chose',
  '- S2: a default pull now sends linux/<desktop arch> instead of leaving the platform to the engine',
  '- the Build page is untouched',
].join('\n');

/**
 * Write a two-task plan of the present shape with what it decided, and the
 * task files of its tasks, each owning one file and listing one test.
 *
 * @param {number} issue
 * @param {{home: string, files: [string, string], slices?: number}} options
 * @returns {Promise<string>} the path of the plan
 */
async function decidedPlan(issue, { home: where, files: [first, second], slices = 2 }) {
  const gated = (file) => `\`pnpm typecheck && pnpm exec eslint ${file} && pnpm test:main\``;
  const text = await render(
    'plan',
    {
      issue,
      requirementIds: 'R1, R2',
      e2eCoverage: E2E,
      sliceCount: slices,
      context: `- \`${first}:1\` — the first file`,
      reuse: 'searched: `RunOptions` in packages -> 0',
      modes: 'none: a fixture',
      interfaces: 'none',
      tasks: [
        '### T1: the first file',
        '- Satisfies: R1',
        `- Owns: ${first}`,
        `- Done when: ${gated(first)}`,
        '- Intent: the first change (R1)',
        '',
        '### T2: the second file',
        '- Satisfies: R2',
        `- Owns: ${second}`,
        `- Done when: ${gated(second)}`,
        '- Intent: the second change (R2)',
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
    { home: where },
  );
  const path = join(where, 'issues', String(issue), 'plan.md');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  await writeTask({ home: where, issue, id: 'T1', satisfies: ['R1'], owns: [first] });
  await writeTask({ home: where, issue, id: 'T2', satisfies: ['R2'], owns: [second] });
  await setOwns(issue, 'T1', [first], { home: where });
  await setOwns(issue, 'T2', [second], { home: where });
  return path;
}

/** The lines `target` printed from the one that starts with `name:` to the next label. */
function block(stdout, name) {
  const lines = stdout.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${name}:`));
  if (start === -1) return null;
  const end = lines.findIndex((line, at) => at > start && /^[a-z]+:/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

describe('pdkit self-review target and what the plan decided', () => {
  const DECIDED = 4250;
  const FIRST = 'packages/main/src/options.ts';
  const SECOND = 'packages/main/src/version.ts';
  let planTree;
  let planPath;

  /** @param {...string} args */
  const inPlan = (...args) => pdkitIn(planTree, ...args);

  before(async () => {
    planTree = await mkdtemp(join(tmpdir(), 'pdkit-self-review-plan-tree-'));
    await rm(planTree, { recursive: true });
    await git(['worktree', 'add', '-b', `DESKTOP-${DECIDED}/platform`, planTree], repo);
    await writeFiles(planTree, { [SECOND]: 'export const VERSION = 2;\n' });
    await commitAll(planTree, 'feat(main): name the version');

    for (let i = 0; i < 2; i += 1) assert.ok((await allocateRequirement(DECIDED, { home })).ok);
    assert.ok((await freezeRequirements(DECIDED, { home })).ok);
    planPath = await decidedPlan(DECIDED, { home, files: [FIRST, SECOND] });
  });

  after(async () => {
    await git(['worktree', 'remove', '--force', planTree], repo).catch(() => {});
    await cleanup(planTree);
  });

  test('quotes what the plan decided and every line to disclose, and counts the tests of the tasks owning a file of the pull request', async () => {
    const result = await inPlan('self-review', 'target', '--issue', String(DECIDED));
    assert.equal(result.code, 0, result.stderr);

    assert.equal(
      block(result.stdout, 'plan'),
      `plan:   ${planPath} — requirements R1, R2; what it decided is quoted below, and a question it answers is not the person's to answer again`,
    );
    assert.equal(
      block(result.stdout, 'decided'),
      [
        'decided: ## Open decisions and e2e coverage, as the plan wrote them:',
        '  Asked and answered:',
        '  - the fallback for an unknown host: linux/amd64, as Build does (operator)',
        `  e2e coverage: ${E2E}`,
      ].join('\n'),
    );
    assert.equal(
      block(result.stdout, 'disclose'),
      [
        'disclose: 3 line(s) of ## Body must disclose for this pull request — Notes for reviewers says each:',
        '  - S1: the pull spec stops asserting a platform it never chose',
        '  - S2: a default pull now sends linux/<desktop arch> instead of leaving the platform to the engine',
        '  - the Build page is untouched',
      ].join('\n'),
    );
    assert.equal(
      block(result.stdout, 'tests'),
      `tests:  T2 1 case(s) — ## Tests of the task files beside ${planPath}; a row is a test this pull request owes`,
    );

    const order = ['triage', 'plan', 'decided', 'disclose', 'tests', 'grep', 'round'].map((name) => result.stdout.split('\n').findIndex((line) => line.startsWith(`${name}:`)));
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'beside the triage record, before the grep and the round');

    const json = JSON.parse((await inPlan('self-review', 'target', '--issue', String(DECIDED), '--json')).stdout);
    assert.equal(json.plan, planPath);
    assert.deepEqual(json.requirements, { plan: ['R1', 'R2'], pullRequest: null });
    assert.deepEqual(json.decided, { openDecisions: DECISIONS, e2eCoverage: E2E });
    assert.equal(json.disclose.predates, false);
    assert.equal(json.disclose.lines.length, 3);
    assert.deepEqual(json.tests.tasks.map((task) => [task.id, task.cases]), [['T2', 1]]);
  });

  test('a plan written before Body must disclose and ## Tests still says what it decided, and says it predates the rest', async () => {
    const original = await readFile(planPath, 'utf8');
    await writeFile(planPath, original.replace(/^## (Reuse|Modes|Gates|Body must disclose)[ \t]*$/gm, '## Earlier $1'));
    try {
      const result = await inPlan('self-review', 'target', '--issue', String(DECIDED));
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /^decided: ## Open decisions and e2e coverage, as the plan wrote them:$/m);
      assert.match(result.stdout, /^ {2}- the fallback for an unknown host: linux\/amd64, as Build does \(operator\)$/m);
      assert.match(result.stdout, /^disclose: none listed — the plan predates ## Body must disclose$/m);
      assert.match(result.stdout, /^tests: {2}none listed — the plan predates ## Tests; the tests axis judges by section 2 alone$/m);
    } finally {
      await writeFile(planPath, original);
    }
  });

  test('a plan that decided nothing for a body says so', async () => {
    const original = await readFile(planPath, 'utf8');
    await writeFile(planPath, original.replace(DISCLOSE, 'none').replace(DECISIONS, 'none').replace(`- e2e coverage: ${E2E}`, '- e2e coverage:'));
    try {
      const result = await inPlan('self-review', 'target', '--issue', String(DECIDED));
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /^decided: none written in ## Open decisions$/m);
      assert.match(result.stdout, /^disclose: none — the plan's ## Body must disclose names nothing$/m);
    } finally {
      await writeFile(planPath, original);
    }
  });

  test('with no plan, the triage record is all that was decided', async () => {
    const aside = `${planPath}.aside`;
    await rename(planPath, aside);
    try {
      const result = await inPlan('self-review', 'target', '--issue', String(DECIDED));
      assert.equal(result.code, 0, result.stderr);
      assert.equal(block(result.stdout, 'plan'), `plan:   none (${planPath}) — the axes have the triage record alone for what was decided`);
      assert.equal(block(result.stdout, 'decided'), null);
      assert.equal(block(result.stdout, 'disclose'), null);
      assert.match(result.stdout, /^tests: {2}none listed — there is no plan; the tests axis judges by section 2 alone$/m);

      const json = JSON.parse((await inPlan('self-review', 'target', '--issue', String(DECIDED), '--json')).stdout);
      assert.equal(json.plan, null);
      assert.equal(json.decided, null);
      assert.equal(json.disclose, null);
    } finally {
      await rename(aside, planPath);
    }
  });
});

describe('pdkit self-review target on the quickfix route', () => {
  const QUICK = 4251;
  let quickTree;
  let issueMd;

  /** @param {...string} args */
  const inQuick = (...args) => pdkitIn(quickTree, ...args);

  before(async () => {
    quickTree = await mkdtemp(join(tmpdir(), 'pdkit-self-review-quick-tree-'));
    await rm(quickTree, { recursive: true });
    await git(['worktree', 'add', '-b', `DESKTOP-${QUICK}/fix`, quickTree], repo);
    await writeFiles(quickTree, { 'fix.ts': 'export const fixed = true;\n' });
    await commitAll(quickTree, 'fix(main): the quick thing');
    assert.ok((await adopt(QUICK, { home, state: 'quickfix', route: 'quickfix', reason: 'a fixture' })).ok);
    issueMd = join(home, 'issues', String(QUICK), 'issue.md');
  });

  after(async () => {
    await git(['worktree', 'remove', '--force', quickTree], repo).catch(() => {});
    await cleanup(quickTree);
  });

  test('has no plan, and counts the tests issue.md lists, or says it lists none', async () => {
    await writeFile(issueMd, '# ISSUE 4251: a fix\n\n## Verdict\nquickfix\n');
    const none = await inQuick('self-review', 'target', '--issue', String(QUICK));
    assert.equal(none.code, 0, none.stderr);
    assert.equal(block(none.stdout, 'plan'), 'plan:   none — the quickfix route has no plan: the triage record is what was decided');
    assert.equal(block(none.stdout, 'decided'), null);
    assert.equal(block(none.stdout, 'disclose'), null);
    assert.equal(block(none.stdout, 'tests'), `tests:  none listed — ${issueMd} has no ## Tests; the tests axis judges by section 2 alone`);

    await writeFile(
      issueMd,
      '# ISSUE 4251: a fix\n\n## Verdict\nquickfix\n\n## Tests\n| Case | When | Asserts | Fails without the fix because |\n|---|---|---|---|\n| a | b | c | d |\n| e | f | g | h |\n',
    );
    const listed = await inQuick('self-review', 'target', '--issue', String(QUICK));
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(block(listed.stdout, 'tests'), `tests:  2 case(s) — ## Tests of ${issueMd}; a row is a test this pull request owes`);

    const json = JSON.parse((await inQuick('self-review', 'target', '--issue', String(QUICK), '--json')).stdout);
    assert.equal(json.plan, null);
    assert.equal(json.decided, null);
    assert.equal(json.disclose, null);
    assert.deepEqual(json.tests, { issue: issueMd, listed: true, cases: 2 });
  });
});

// A slice: the lines of Body must disclose that name it, or name none, and the
// tests of the tasks owning its files. The graph here departs from the plan's
// hypothesis of three, so a slice a line names is the plan's count, and the
// line says so.
describe('pdkit self-review target on a slice', () => {
  const SLICED = 4252;
  const API = 'packages/extension-api/src/api.ts';
  const EXEC = 'packages/main/src/exec.ts';
  let sliced;
  let slicedHome;
  let slicedTrees;
  let slicedPlan;

  const config = () => ({
    repo: { base_branch: 'main', package_manager: 'npm' },
    branches: { sliced: 'DESKTOP-{issue}/{index}-{slug}' },
    slicing: { layer_order: ['extension-api', 'main', 'ui', 'tests'], verify: { install: 'never' } },
    worktrees: { root: slicedTrees, copy_files: [] },
  });

  /** @param {...string} args */
  async function inSliced(...args) {
    try {
      const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], { cwd: sliced, env: { ...process.env, PDKIT_HOME: slicedHome }, encoding: 'utf8' });
      return { code: 0, stdout, stderr };
    } catch (error) {
      return { code: error.code ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
    }
  }

  before(async () => {
    sliced = await initRepo('pdkit-self-review-sliced-');
    slicedHome = await mkdtemp(join(tmpdir(), 'pdkit-self-review-sliced-home-'));
    slicedTrees = join(sliced, '..', `${basename(sliced)}-trees`);
    await writeFile(
      join(slicedHome, 'config.yaml'),
      [
        'repo:',
        '  fork: me/podman-desktop',
        '  base_branch: main',
        '  package_manager: npm',
        'branches:',
        "  sliced: 'DESKTOP-{issue}/{index}-{slug}'",
        'slicing:',
        '  layer_order: [extension-api, main, ui, tests]',
        '  verify:',
        '    install: never',
        'worktrees:',
        `  root: '${slicedTrees}'`,
        '  copy_files: []',
        '',
      ].join('\n'),
    );

    await seedWorkspace(sliced);
    await commitAll(sliced, 'chore: seed');
    await git(['checkout', '-b', `DESKTOP-${SLICED}/work`], sliced);
    await writeFiles(sliced, {
      [API]: '// SPDX-License-Identifier: Apache-2.0\nexport interface RunOptions { env?: string }\n',
      [EXEC]: '// SPDX-License-Identifier: Apache-2.0\nexport function exec() {}\nexport const EXEC_VERSION = 2;\n',
    });
    await commitAll(sliced, 'feat: change set');

    await transition(SLICED, 'triaged', { home: slicedHome });
    await transition(SLICED, 'planned', { home: slicedHome });
    for (let i = 0; i < 2; i += 1) assert.ok((await allocateRequirement(SLICED, { home: slicedHome })).ok);
    assert.ok((await freezeRequirements(SLICED, { home: slicedHome })).ok);
    slicedPlan = await decidedPlan(SLICED, { home: slicedHome, files: [API, EXEC], slices: 3 });

    const facts = await slice.facts({ issue: SLICED, repoRoot: sliced, home: slicedHome, config: config(), packageMap: packageMap(sliced) });
    const stored = await slice.set({
      issue: SLICED,
      proposal: {
        whyDeviates: 'two layers, so two slices rather than three',
        slices: [
          { slug: 'api', title: 'add RunOptions', files: [API], baseSlice: null },
          { slug: 'exec', title: 'name the version', files: [EXEC], baseSlice: null },
        ],
      },
      facts,
      config: config(),
      home: slicedHome,
    });
    assert.equal(stored.ok, true, JSON.stringify(stored.problems));
    await slice.verifyAll({ issue: SLICED, repoRoot: sliced, home: slicedHome, config: config(), packageMap: packageMap(sliced) });
    await auditReviewed(SLICED, { home: slicedHome });

    for (const [index, subject] of [[1, 'feat(extension-api): add RunOptions'], [2, 'feat(main): name the version']]) {
      for (const to of ['plan-approved', 'implemented', 'validated', 'audited', 'sliced', 'slices-approved']) {
        await transition(SLICED, to, { home: slicedHome, approvedBy: 'test' });
      }
      const made = await slice.materialize({ issue: SLICED, index, repoRoot: sliced, subject, home: slicedHome, config: config() });
      assert.equal(made.ok, true, made.error);
    }
  });

  after(async () => {
    await cleanup(sliced, slicedHome, slicedTrees);
  });

  test('quotes the lines that name the slice, or none, and counts the tests of the tasks owning its files', async () => {
    const second = await inSliced('self-review', 'target', '--issue', String(SLICED), '--slice', '2');
    assert.equal(second.code, 0, second.stderr);
    assert.equal(
      block(second.stdout, 'plan'),
      `plan:   ${slicedPlan} — requirements R1, R2, this pull request R2 (the slice graph); what it decided is quoted below, and a question it answers is not the person's to answer again`,
    );
    assert.equal(
      block(second.stdout, 'disclose'),
      [
        "disclose: 2 line(s) of ## Body must disclose for this pull request — Notes for reviewers says each (1 more for other slices); the cut departs from the plan's slice hypothesis, so the slice a line names is the plan's count:",
        '  - S2: a default pull now sends linux/<desktop arch> instead of leaving the platform to the engine',
        '  - the Build page is untouched',
      ].join('\n'),
    );
    assert.equal(block(second.stdout, 'tests'), `tests:  T2 1 case(s) — ## Tests of the task files beside ${slicedPlan}; a row is a test this pull request owes`);

    const json = JSON.parse((await inSliced('self-review', 'target', '--issue', String(SLICED), '--slice', '2', '--json')).stdout);
    assert.deepEqual(json.requirements, { plan: ['R1', 'R2'], pullRequest: ['R2'] });
    assert.deepEqual(json.disclose.lines, ['S2: a default pull now sends linux/<desktop arch> instead of leaving the platform to the engine', 'the Build page is untouched']);
    assert.equal(json.disclose.others, 1);

    const first = await inSliced('self-review', 'target', '--issue', String(SLICED), '--slice', '1');
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /^ {2}- S1: the pull spec stops asserting a platform it never chose$/m);
    assert.doesNotMatch(first.stdout, /- S2: /);
    assert.match(first.stdout, /^tests: {2}T1 1 case\(s\) — /m);
  });
});
