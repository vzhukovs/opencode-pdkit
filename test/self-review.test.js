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


// Tests for lib/self-review.js and the `self-review` preflight check.
//
// The question every test here asks: can a review of something other than
// what is being published, or a review with an open finding, let the push
// through? The record ties a review to a commit and a body; the check refuses
// on any mismatch and on anything still open.
//
// And the second one: does the loop end? Open is what upstream's agent rejects
// a pull request for, so a review that leaves only nits is done, and a review
// that keeps finding something stops after a set number of commits until a
// person says why another one will differ.

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { append as appendJournal, read as readJournal } from '../lib/journal.js';
import { run as check } from '../lib/preflight/checks/self-review.js';
import * as selfReview from '../lib/self-review.js';

const BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'pdkit');
const exec = promisify(execFile);

const ISSUE = 7001;
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const THIRD = 'c'.repeat(40);
const FOURTH = 'd'.repeat(40);
const BODY = '### What does this PR do?\n\nFixes the thing.\n';
const AXES = [...selfReview.AXES];

let home;

beforeEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
  home = await mkdtemp(join(tmpdir(), 'pdkit-self-review-'));
});

after(async () => {
  await rm(home, { recursive: true, force: true });
});

/** The context the check reads, with the commit and body under check. */
const context = (overrides = {}) => ({ issue: ISSUE, slice: undefined, headSha: SHA, prBody: BODY, home, ...overrides });

const record = (overrides = {}) => selfReview.record({ issue: ISSUE, sha: SHA, body: BODY, axes: AXES, findings: [], home, ...overrides });

describe('the record', () => {
  test('refuses a review that did not run all four axes', async () => {
    const result = await record({ axes: ['architecture', 'tests'] });
    assert.equal(result.ok, false);
    assert.match(result.error, /api-compat, product/);
  });

  test('refuses a body nobody could have read, and a sha that is not one', async () => {
    assert.equal((await record({ body: '  ' })).ok, false);
    assert.equal((await record({ sha: 'HEAD' })).ok, false);
  });

  test('refuses a finding with no label, no text, or a section outside 1–12', async () => {
    assert.equal((await record({ findings: [{ label: 'blocker', text: 'x' }] })).ok, false);
    assert.equal((await record({ findings: [{ label: 'issue', text: '' }] })).ok, false);
    assert.equal((await record({ findings: [{ label: 'issue', text: 'x', section: 13 }] })).ok, false);
    assert.equal((await record({ findings: 'none' })).ok, false);
  });

  test('keeps one entry per pull request, the latest one', async () => {
    await record({ findings: [{ label: 'issue', text: 'first' }] });
    await record({ sha: OTHER });
    await record({ slice: 2, findings: [{ label: 'nit', text: 'sliced' }] });

    const stored = await selfReview.read(ISSUE, { home });
    assert.equal(selfReview.entryFor(stored, undefined).sha, OTHER);
    assert.equal(selfReview.entryFor(stored, undefined).findings.length, 0);
    assert.equal(selfReview.entryFor(stored, 2).findings[0].text, 'sliced');

    const raw = JSON.parse(await readFile(join(home, 'issues', String(ISSUE), 'self-review.json'), 'utf8'));
    assert.deepEqual(Object.keys(raw.entries).sort(), ['single', 'slice-2']);
  });

  test('what stays open: every issue and a question with no answer, what upstream rejects for', async () => {
    const result = await record({
      findings: [
        { label: 'issue', text: 'blocks', section: 2 },
        { label: 'issue', text: 'blocks even when old', preExisting: true },
        { label: 'nit', text: 'new code', section: 4 },
        { label: 'nit', text: 'old code', preExisting: true },
        { label: 'question', text: 'why?' },
        { label: 'question', text: 'answered', answer: 'Notes for reviewers says why' },
      ],
    });

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.unresolved.map((finding) => finding.text),
      ['blocks', 'blocks even when old', 'why?'],
    );
  });

  test('a nit on new code is not open, and the record keeps it as the review said it', async () => {
    const result = await record({ findings: [{ label: 'nit', text: 'name the helper after its role', path: 'a.ts', line: 3, section: 10 }] });

    assert.equal(result.ok, true);
    assert.deepEqual(result.unresolved, []);

    const entry = selfReview.entryFor(await selfReview.read(ISSUE, { home }), undefined);
    assert.deepEqual(
      entry.findings.map((finding) => [finding.label, finding.text, finding.preExisting]),
      [['nit', 'name the helper after its role', false]],
    );
  });

  test('the body digest ignores what GitHub does to line endings and trailing space', () => {
    assert.equal(selfReview.bodyDigest('a\r\nb\n\n'), selfReview.bodyDigest('a\nb'));
    assert.notEqual(selfReview.bodyDigest('a\nb'), selfReview.bodyDigest('a\nc'));
  });
});

describe('the self-review check', () => {
  test('waits for the body: the review reads it, so there is nothing to match before it exists', async () => {
    const result = await check(context({ prBody: null }));
    assert.equal(result.status, 'skip');
    assert.equal(result.waitingFor, 'body');
  });

  test('fails when no review was recorded', async () => {
    const result = await check(context());
    assert.equal(result.status, 'fail');
    assert.equal(result.blocking, true);
    assert.match(result.summary, /no self-review is recorded/);
  });

  test('fails when the review read another commit', async () => {
    await record({ sha: OTHER });
    const result = await check(context());
    assert.equal(result.status, 'fail');
    assert.match(result.summary, /read bbbbbbbb, and the branch is at aaaaaaaa/);
  });

  test('fails when the body changed after the review', async () => {
    await record();
    const result = await check(context({ prBody: `${BODY}\nOne more line.\n` }));
    assert.equal(result.status, 'fail');
    assert.match(result.summary, /body changed/);
  });

  test('fails on an open finding and lists it with its section', async () => {
    await record({ findings: [{ label: 'issue', text: 'vi.spyOn on the class under test', path: 'a.spec.ts', line: 12, section: 2 }] });
    const result = await check(context());
    assert.equal(result.status, 'fail');
    assert.match(result.output, /a\.spec\.ts:12 — issue: vi\.spyOn on the class under test \(§2\)/);
  });

  test('reads the entry of the slice under check, not another one', async () => {
    await record({ slice: 1 });
    assert.equal((await check(context({ slice: 2 }))).status, 'fail');
    assert.equal((await check(context({ slice: 1 }))).status, 'pass');
  });

  test('passes a clean review of this commit and this body', async () => {
    await record({ findings: [{ label: 'nit', text: 'old', preExisting: true }] });
    const result = await check(context({ prBody: BODY.replace(/\n/g, '\r\n') }));
    assert.equal(result.status, 'pass');
    assert.match(result.summary, /no issue, no unanswered question; 1 nit\(s\) left, 1 of them pre-existing/);
  });

  test('passes a review that left only nits on new code, and counts them rather than calling it clean', async () => {
    await record({
      findings: [
        { label: 'nit', text: 'test title reads awkwardly', path: 'a.spec.ts', line: 9, section: 2 },
        { label: 'nit', text: 'readonly array', path: 'a.ts', line: 3 },
        { label: 'question', text: 'intended?', answer: 'yes, Notes for reviewers says why' },
      ],
    });
    const result = await check(context());

    assert.equal(result.status, 'pass');
    assert.match(result.summary, /no issue, no unanswered question; 2 nit\(s\) left, 1 answered question\(s\)/);
    assert.doesNotMatch(result.summary, /nothing found/);
  });

  test('names nothing found only when nothing was', async () => {
    await record();
    const result = await check(context());
    assert.equal(result.status, 'pass');
    assert.match(result.summary, /four axes on aaaaaaaa, nothing found/);
  });
});

describe('rounds of the self-review', () => {
  /** A review of `sha` that left one issue open. */
  const open = (sha, overrides = {}) => record({ sha, findings: [{ label: 'issue', text: `missing test on ${sha.slice(0, 4)}` }], ...overrides });

  test('counts the commits a review left something open on, and stops a review of the next one at three', async () => {
    assert.equal(selfReview.DEFAULT_ROUNDS, 3);
    await open(SHA);
    await open(OTHER);
    const third = await open(THIRD);

    assert.equal(third.ok, true);
    assert.equal(third.rounds.rounds, 3);
    assert.equal(third.rounds.blocked, true);

    const fourth = await open(FOURTH);
    assert.equal(fourth.ok, false);
    assert.match(fourth.error, /3 commits/);
    assert.match(fourth.error, /stop and ask/i);
    assert.match(fourth.error, /pdkit self-review continue --issue 7001 --reason "/);

    const stored = selfReview.entryFor(await selfReview.read(ISSUE, { home }), undefined);
    assert.equal(stored.sha, THIRD, 'a refused round writes nothing');
  });

  test('the same commit again is not another round: an answer or a new body is recorded at the limit', async () => {
    await open(SHA);
    await open(OTHER);
    await open(THIRD);

    const answered = await record({ sha: THIRD, body: `${BODY}\nNotes: why it holds.\n`, findings: [{ label: 'question', text: 'intended?', answer: 'yes' }] });
    assert.equal(answered.ok, true);
    assert.deepEqual(answered.unresolved, []);
  });

  test('a review that leaves nothing open starts the count over', async () => {
    await open(SHA);
    await open(OTHER);
    await record({ sha: THIRD, findings: [{ label: 'nit', text: 'only a nit' }] });

    const status = await selfReview.rounds({ issue: ISSUE, home });
    assert.equal(status.rounds, 0);
    assert.equal(status.blocked, false);
    assert.equal((await open(FOURTH)).ok, true);
  });

  test('a person starts it over with a sentence, and only with one', async () => {
    await open(SHA);
    await open(OTHER);
    await open(THIRD);

    assert.equal((await selfReview.continueRounds({ issue: ISSUE, reason: '  ', home })).ok, false);
    assert.equal((await open(FOURTH)).ok, false);

    const allowed = await selfReview.continueRounds({ issue: ISSUE, reason: 'the two missing tests are the last of the issue', home });
    assert.equal(allowed.ok, true);
    assert.equal((await open(FOURTH)).ok, true);

    const entry = (await readJournal({ issue: ISSUE, event: selfReview.EVENTS.continued }, { home })).at(-1);
    assert.equal(entry.detail, 'the two missing tests are the last of the issue');
  });

  test('starting the issue over starts the count over', async () => {
    await open(SHA);
    await open(OTHER);
    await open(THIRD);
    await appendJournal({ issue: ISSUE, event: 'reset', detail: 'archived' }, { home });

    assert.equal((await open(FOURTH)).ok, true);
  });

  test('each pull request of the issue counts its own', async () => {
    await open(SHA, { slice: 1 });
    await open(OTHER, { slice: 1 });
    await open(THIRD, { slice: 1 });

    assert.equal((await open(FOURTH, { slice: 1 })).ok, false);
    assert.equal((await open(FOURTH, { slice: 2 })).ok, true);
    assert.equal((await open(FOURTH)).ok, true);
  });

  test('the limit is configured, and zero switches it off', async () => {
    const one = { review: { self_review_rounds: 1 } };
    await open(SHA, { config: one });
    assert.equal((await open(OTHER, { config: one })).ok, false);

    const off = { review: { self_review_rounds: 0 } };
    assert.equal((await open(OTHER, { config: off })).ok, true);
    assert.equal((await open(THIRD, { config: off })).ok, true);
    assert.equal(selfReview.roundLimit(off), 0);
    assert.equal(selfReview.roundLimit({}), 3);
  });

  test('a round starts where the axes start: three commits targeted and never recorded stop the fourth', async () => {
    const start = (sha) => selfReview.startRound({ issue: ISSUE, sha, home });

    assert.equal((await start(SHA)).ok, true);
    assert.equal((await start(OTHER)).ok, true);
    const third = await start(THIRD);
    assert.equal(third.ok, true);
    assert.equal(third.rounds.rounds, 3);
    assert.equal(third.rounds.blocked, true);

    const fourth = await start(FOURTH);
    assert.equal(fourth.ok, false);
    assert.match(fourth.error, /stop and ask/i);
    assert.equal((await open(FOURTH)).ok, false, 'nor can the fourth be recorded');

    const entries = await readJournal({ issue: ISSUE, event: selfReview.EVENTS.started }, { home });
    assert.deepEqual(
      entries.map((entry) => entry.detail),
      ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'],
      'a refused start writes nothing',
    );
  });

  test('starting the same commit again is the same round, and its record closes it', async () => {
    const start = (sha) => selfReview.startRound({ issue: ISSUE, sha, home });
    await start(SHA);
    await start(SHA);
    await open(SHA);
    await start(OTHER);
    await start(THIRD);

    assert.equal((await selfReview.rounds({ issue: ISSUE, home })).rounds, 3);
    assert.equal((await start(THIRD)).ok, true, 'the commit at the limit can be read again');
    assert.equal((await start(FOURTH)).ok, false);
  });

  test('a clean record after started rounds starts the count over', async () => {
    const start = (sha) => selfReview.startRound({ issue: ISSUE, sha, home });
    await start(SHA);
    await start(OTHER);
    await start(THIRD);
    await record({ sha: THIRD, findings: [{ label: 'nit', text: 'left' }] });

    assert.equal((await selfReview.rounds({ issue: ISSUE, home })).rounds, 0);
    assert.equal((await start(FOURTH)).ok, true);
  });

  test('the check says to stop and ask once the limit is reached, not to run the axes again', async () => {
    await open(OTHER);
    await open(THIRD);
    await open(SHA);

    const result = await check(context());
    assert.equal(result.status, 'fail');
    assert.match(result.remedy, /stop and ask/i);
    assert.match(result.remedy, /pdkit self-review continue --issue 7001 --reason "/);
  });

  test('below the limit the check sends the axes round again', async () => {
    await open(SHA);

    const result = await check(context());
    assert.equal(result.status, 'fail');
    assert.match(result.remedy, /run the axes on the new commit/);
    assert.doesNotMatch(result.remedy, /stop and ask/i);
  });
});

describe('pdkit self-review, end to end', () => {
  /**
   * @param {...string} args
   * @returns {Promise<{code: number, stdout: string, stderr: string}>}
   */
  async function pdkit(...args) {
    try {
      const { stdout, stderr } = await exec(process.execPath, [BIN, 'self-review', ...args], {
        cwd: home,
        env: { ...process.env, PDKIT_HOME: home },
        encoding: 'utf8',
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      return { code: error.code ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
    }
  }

  const open = (sha) => record({ sha, findings: [{ label: 'issue', text: 'missing test' }, { label: 'nit', text: 'title' }] });

  test('show says how many rounds left something open, and that the next one waits', async () => {
    await open(SHA);
    await open(OTHER);
    await open(THIRD);

    const shown = await pdkit('show', '--issue', String(ISSUE));
    assert.equal(shown.code, 0);
    assert.match(shown.stdout, /\[open\] {2}issue: missing test/);
    assert.match(shown.stdout, /\[not blocking\] {2}nit: title/);
    assert.match(shown.stdout, /rounds since the last clean review: 3 of 3 — a review of another commit waits for a person/);
  });

  test('continue takes a sentence, writes it to the journal and starts the count over', async () => {
    await open(SHA);
    await open(OTHER);
    await open(THIRD);

    const bare = await pdkit('continue', '--issue', String(ISSUE));
    assert.equal(bare.code, 1);
    assert.match(bare.stderr, /--reason "<what is different this time>" is required/);

    const said = await pdkit('continue', '--issue', String(ISSUE), '--reason', 'one test left, and it is the last');
    assert.equal(said.code, 0);
    assert.match(said.stdout, /may run again; the count of rounds starts over/);

    const status = await selfReview.rounds({ issue: ISSUE, home });
    assert.equal(status.rounds, 0);
    assert.equal(status.blocked, false);
  });
});

// The audit's review: the four axes read the whole branch once, before it is
// cut into pull requests. There is no body yet, so none is asked for, and its
// rounds are its own — a review of the branch never counts against a pull
// request's limit, and a pull request's rounds never stop the audit.
describe('the review of the whole branch, in the audit', () => {
  const reviewed = (overrides = {}) => selfReview.record({ issue: ISSUE, audit: true, sha: SHA, axes: AXES, findings: [], home, ...overrides });

  test('is recorded with no body, under its own key', async () => {
    const result = await reviewed({ findings: [{ label: 'issue', text: 'logic in the component', path: 'a.svelte', line: 4, section: 3 }] });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.unresolved.length, 1);

    const stored = await selfReview.read(ISSUE, { home });
    const entry = selfReview.entryFor(stored, undefined, true);
    assert.equal(entry.sha, SHA);
    assert.equal(entry.bodyDigest, null);
    assert.equal(selfReview.entryFor(stored, undefined), null, 'the audit is not the single pull request');

    const raw = JSON.parse(await readFile(join(home, 'issues', String(ISSUE), 'self-review.json'), 'utf8'));
    assert.deepEqual(Object.keys(raw.entries), ['audit']);
  });

  test('refuses a body, which the self-review of each pull request reads instead', async () => {
    const result = await reviewed({ body: BODY });
    assert.equal(result.ok, false);
    assert.match(result.error, /reads no body/);
  });

  test('a pull request still needs its body', async () => {
    const result = await selfReview.record({ issue: ISSUE, sha: SHA, axes: AXES, findings: [], home });
    assert.equal(result.ok, false);
    assert.match(result.error, /the PR body is empty/);
  });

  test('still needs all four axes', async () => {
    const result = await reviewed({ axes: ['architecture'] });
    assert.equal(result.ok, false);
    assert.match(result.error, /axes not run: api-compat, tests, product/);
  });

  test('writes its own events to the journal', async () => {
    await selfReview.startRound({ issue: ISSUE, audit: true, sha: SHA, home });
    await reviewed({ findings: [{ label: 'issue', text: 'x' }] });
    await selfReview.continueRounds({ issue: ISSUE, audit: true, reason: 'the plan was amended', home });

    const entries = await readJournal({ issue: ISSUE }, { home });
    assert.deepEqual(
      entries.map((entry) => [entry.event, entry.slice, entry.detail]),
      [
        [selfReview.AUDIT_EVENTS.started, null, SHA.slice(0, 8)],
        [selfReview.AUDIT_EVENTS.recorded, null, `${SHA.slice(0, 8)}: 1 finding(s), 1 unresolved`],
        [selfReview.AUDIT_EVENTS.continued, null, 'the plan was amended'],
      ],
    );
    assert.deepEqual(Object.values(selfReview.AUDIT_EVENTS), ['audit-review-target', 'audit-review', 'audit-review-continued']);
  });

  test('counts its rounds apart from the pull requests, both ways', async () => {
    for (const sha of [SHA, OTHER, THIRD]) await selfReview.startRound({ issue: ISSUE, audit: true, sha, home });

    const branch = await selfReview.rounds({ issue: ISSUE, audit: true, home });
    assert.deepEqual([branch.rounds, branch.blocked], [3, true]);
    const single = await selfReview.rounds({ issue: ISSUE, home });
    assert.deepEqual([single.rounds, single.blocked], [0, false], 'the audit does not stop the pull request');

    for (const sha of [SHA, OTHER, THIRD]) await selfReview.startRound({ issue: ISSUE, sha, home });
    await selfReview.continueRounds({ issue: ISSUE, audit: true, reason: 'amended', home });
    assert.equal((await selfReview.rounds({ issue: ISSUE, audit: true, home })).rounds, 0);
    assert.equal((await selfReview.rounds({ issue: ISSUE, home })).rounds, 3, 'a sentence for the audit does not start the pull request over');
  });

  test('stops at the limit, and says how to go on with --audit', async () => {
    for (const sha of [SHA, OTHER, THIRD]) await reviewed({ sha, findings: [{ label: 'issue', text: 'x' }] });

    const refused = await selfReview.startRound({ issue: ISSUE, audit: true, sha: FOURTH, home });
    assert.equal(refused.ok, false);
    assert.match(refused.error, new RegExp(`pdkit self-review continue --issue ${ISSUE} --audit --reason "`));

    const recorded = await reviewed({ sha: FOURTH });
    assert.equal(recorded.ok, false, 'a record of a fourth commit is refused as well');

    assert.equal((await reviewed({ sha: THIRD, findings: [{ label: 'question', text: 'q', answer: 'plan.md:12 decides it' }] })).ok, true, 'the same commit again is the same round');
  });

  test('a file written before it existed reads as it did', async () => {
    await record({ findings: [{ label: 'nit', text: 'old' }] });

    const stored = await selfReview.read(ISSUE, { home });
    assert.equal(selfReview.entryFor(stored, undefined, true), null);
    assert.equal(selfReview.entryFor(stored, undefined).findings[0].text, 'old');
  });

  test('is not what the self-review check of a pull request reads', async () => {
    await reviewed();

    const result = await check(context());
    assert.equal(result.status, 'fail');
    assert.match(result.summary, /no self-review is recorded for this pull request/);
  });
});
