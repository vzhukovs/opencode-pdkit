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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { read as readJournal } from '../lib/journal.js';
import { EVENTS } from '../lib/self-review.js';
import { adopt } from '../lib/state.js';
import { cleanup, commitAll, git, initRepo, writeFiles } from './helpers/repo-fixture.js';

const exec = promisify(execFile);
const BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'pdkit');
const ISSUE = 4244;

let home;
let repo;
let tree;

/** @returns {Promise<{code: number, stdout: string, stderr: string}>} */
async function pdkit(...args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], {
      cwd: tree,
      env: { ...process.env, PDKIT_HOME: home },
      encoding: 'utf8',
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

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
