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

// Tests for lib/planning.js.
//
// The report exists to put a number on each review round and each revision,
// where the cost report had one figure for all of them, and to say "unknown"
// where nothing recorded the line between them. So what is pinned here is the
// cut: which window a call falls in, that a round with no plan-reviewed entry
// is never divided by a guess, that an earlier cycle's calls and rounds stay
// out, and that a cost nobody could read is "unknown" rather than zero.
//
// And what the move from Claude Code added: the calls are Open Code's, read
// as the cost report reads them, and measuring starts at the cost report's
// boundary. A round that took place in Claude Code is "outside", never a
// round without calls, and the day's planning snapshot taken there is kept.
//
// Nothing here reads the database Open Code keeps for the user. Calls are
// built in memory in the shape lib/opencode-sessions.js returns, and the
// tests that read from disk build a database of Open Code's schema in a
// temporary directory (test/helpers/opencode-db.js).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { issueDir } from '../lib/config.js';
import { append } from '../lib/journal.js';
import { NONE, OUTSIDE, UNKNOWN, build, closer, collect, format, issueReport, plannedIssues, writeSnapshot } from '../lib/planning.js';
import { database } from './helpers/opencode-db.js';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-11-12T10:00:00Z');
const ISSUE = 100;

/** @param {number} hours after T0 */
const at = (hours) => new Date(T0 + hours * HOUR).toISOString();

/**
 * A call as lib/opencode-sessions.js returns one, on a model that weighs as
 * Sonnet, whose cost in units is its fresh input.
 *
 * @param {number} hours
 * @param {number} input
 */
const call = (hours, input) => ({ at: at(hours), model: 'anthropic/claude-sonnet-5-5', sessionId: 'ses_1', agent: null, usage: { input, cacheRead: 0, cacheWrite: 0, output: 0 } });

/** @param {number} hours @param {string} event @param {string} [detail] */
const entry = (hours, event, detail = '') => ({ at: at(hours).replace(/\.\d{3}Z$/, 'Z'), issue: ISSUE, slice: null, event, detail });

const AFTER = { amendments: 1, stops: 0, failedTasks: [{ taskId: 'T2', failed: 2 }], audit: { count: 3, reason: null } };

/** A round as plan-review.js summarizes a file. */
const file = (round, name, items = { A: 1, B: 1, C: 0 }) => ({
  file: name,
  round,
  mode: /** @type {const} */ ('unknown'),
  items,
  decisions: { accepted: 1, rejected: 1, undecided: 0, unread: 0, missing: 0 },
});

/** @param {import('../lib/planning.js').Part|string} value */
const unitsOf = (value) => (typeof value === 'string' ? value : value.units);

/** What a read of Open Code's database found, as lib/opencode-sessions.js returns it. */
const scanOf = (calls, over = {}) => ({
  calls,
  compactions: [],
  source: {
    db: '/data/opencode/opencode.db',
    sessions: 1,
    subagentSessions: 0,
    steps: calls.length,
    unfinishedSteps: 0,
    forkCopies: 0,
    elsewhereSteps: 0,
    lastMessageInputSteps: 0,
  },
  skip: null,
  ...over,
});

/** Where measuring starts: the newest snapshot taken from Claude Code's transcripts. */
const BOUNDARY = { at: at(0), snapshot: '2026-11-12.json' };

describe('the window a call falls in', () => {
  test('the first boundary at or after the instant closes it, and nothing does after the last', () => {
    const close = closer([
      { at: at(2), kind: 'review', round: 1, detail: '' },
      { at: at(3), kind: 'revision', round: 1, detail: '' },
    ]);
    assert.equal(close(at(1))?.kind, 'review');
    assert.equal(close(at(2))?.kind, 'review', 'a call at the instant of the entry is before it was written');
    assert.equal(close(at(2.5))?.kind, 'revision');
    assert.equal(close(at(3.5)), null);
  });
});

describe('one issue, rounds recorded', () => {
  // An earlier cycle planned and revised a round 1; the reset ends it. In the
  // current one, round 1 is reviewed and revised, round 2 reviewed and approved.
  const report = issueReport({
    issue: ISSUE,
    calls: [call(-8.5, 7), call(0.7, 100), call(1.5, 200), call(2.5, 300), call(3.5, 400), call(4.5, 500), call(5.5, 600)],
    entries: [
      entry(-10, 'triaged'),
      entry(-9, 'planned'),
      entry(-8, 'plan-revised', 'round-1 applied to plan.md'),
      entry(0, 'reset', 'was planned'),
      entry(0.5, 'triaged'),
      entry(1, 'planned'),
      entry(2, 'plan-reviewed', 'round-1 mode=full A=2 B=1 C=0'),
      entry(3, 'plan-revised', 'round-1 applied to plan.md'),
      entry(4, 'plan-reviewed', 'round-2 mode=delta A=0 B=1 C=1'),
      entry(5, 'plan-approved'),
    ],
    record: { state: 'plan-approved', reviews: [file(1, 'plan-review.r1.md'), file(2, 'plan-review.md')], after: AFTER },
  });

  test('each review and each revision is its own window', () => {
    assert.deepEqual(
      report.rounds.map((round) => [round.round, unitsOf(round.review), unitsOf(round.revision)]),
      [
        [1, 200, 300],
        [2, 400, NONE],
      ],
    );
  });

  test('the first plan, the whole phase after it, and what came after the last entry', () => {
    assert.equal(unitsOf(report.totals.firstPlan), 100);
    assert.equal(unitsOf(report.totals.afterFirstPlan), 200 + 300 + 400 + 500);
    assert.equal(unitsOf(report.totals.tail), 500);
    assert.equal(unitsOf(report.totals.unsplit), 0);
  });

  test("an earlier cycle's calls and rounds are not this cycle's", () => {
    assert.deepEqual(report.cycle, { start: entry(0, 'reset').at, earlier: 1 });
    assert.deepEqual(report.unrecorded, []);
  });

  test('mode and items come from the journal entry when the round has one', () => {
    assert.deepEqual(
      report.rounds.map((round) => [round.mode, round.items, round.countedFrom, round.decisions?.rejected]),
      [
        ['full', { A: 2, B: 1, C: 0 }, 'journal', 1],
        ['delta', { A: 0, B: 1, C: 1 }, 'journal', 1],
      ],
    );
  });

  test('after approval, the counts as read', () => {
    assert.deepEqual(report.after, { at: entry(5, 'plan-approved').at, ...AFTER });
  });

  test('with no boundary, nothing is outside', () => {
    assert.deepEqual([report.outside, report.measuredSince], [[], null]);
  });
});

describe('rounds without a plan-reviewed entry', () => {
  // Every issue planned before the entry existed: plan-revised alone.
  const old = issueReport({
    issue: ISSUE,
    calls: [call(1.5, 10), call(2.5, 20), call(3.5, 40)],
    entries: [
      entry(1, 'planned'),
      entry(2, 'plan-revised', 'round-1 applied to plan.md'),
      entry(3, 'plan-revised', 'round-2 applied to plan.md'),
      entry(4, 'plan-approved'),
    ],
    record: { state: 'plan-approved', reviews: [file(1, 'plan-review.r1.md'), file(2, 'plan-review.r2.md'), file(3, 'plan-review.md')], after: AFTER },
  });

  test('the rounds are read from the files, and their cost is unknown, not divided', () => {
    assert.deepEqual(
      old.rounds.map((round) => [round.round, round.countedFrom, round.review, round.revision]),
      [
        [1, 'file', UNKNOWN, UNKNOWN],
        [2, 'file', UNKNOWN, UNKNOWN],
        [3, 'file', UNKNOWN, NONE],
      ],
    );
    assert.deepEqual(old.unrecorded, [1, 2, 3]);
  });

  test('what plan-revised alone closes is one sum, and the totals still add up', () => {
    assert.equal(unitsOf(old.totals.unsplit), 30);
    assert.equal(unitsOf(old.totals.tail), 40);
    assert.equal(unitsOf(old.totals.afterFirstPlan), 70);
  });

  test('a round recorded after the entry existed is split, the ones before it are not', () => {
    const mixed = issueReport({
      issue: ISSUE,
      calls: [call(1.5, 10), call(2.5, 20), call(3.5, 40), call(4.5, 80)],
      entries: [
        entry(1, 'planned'),
        entry(2, 'plan-revised', 'round-1 applied to plan.md'),
        entry(3, 'plan-reviewed', 'round-2 mode=full A=1 B=0 C=0'),
        entry(4, 'plan-revised', 'round-2 applied to plan.md'),
        entry(5, 'plan-approved'),
      ],
      record: { state: 'plan-approved', reviews: [file(1, 'plan-review.r1.md'), file(2, 'plan-review.md')], after: AFTER },
    });
    assert.deepEqual(
      mixed.rounds.map((round) => [round.round, unitsOf(round.review), unitsOf(round.revision)]),
      [
        [1, UNKNOWN, UNKNOWN],
        [2, 20, 40],
      ],
    );
    assert.equal(unitsOf(mixed.totals.unsplit), 10);
    assert.equal(unitsOf(mixed.totals.tail), 80);
  });
});

describe('what cannot be known is said', () => {
  test('with nothing read, every cost is unknown and the counts stay', () => {
    const blind = issueReport({
      issue: ISSUE,
      calls: null,
      entries: [entry(1, 'planned'), entry(2, 'plan-reviewed', 'round-1 mode=full A=3 B=0 C=0'), entry(3, 'plan-approved')],
      record: { state: 'plan-approved', reviews: [], after: AFTER },
    });
    assert.deepEqual([blind.totals.firstPlan, blind.totals.afterFirstPlan, blind.rounds[0].review], [UNKNOWN, UNKNOWN, UNKNOWN]);
    assert.deepEqual(blind.rounds[0].items, { A: 3, B: 0, C: 0 });
  });

  test('a plan not approved has no after-approval counts, and the window after the last entry stays open', () => {
    const open = issueReport({
      issue: ISSUE,
      calls: [call(1.5, 10), call(2.5, 20)],
      entries: [entry(1, 'planned'), entry(2, 'plan-reviewed', 'round-1 mode=full A=1 B=0 C=0')],
      record: { state: 'planned', reviews: [], after: AFTER },
    });
    assert.equal(open.after, null);
    assert.equal(unitsOf(open.rounds[0].revision), NONE);
    assert.equal(unitsOf(open.totals.tail), 20);
  });

  test('an issue reset after its plan, and not planned since, has no plan in its cycle', () => {
    const entries = [entry(1, 'planned'), entry(2, 'reset'), entry(3, 'triaged'), { ...entry(1, 'planned'), issue: 200 }];
    assert.deepEqual(plannedIssues(entries), [200]);
  });
});

describe('where measuring starts', () => {
  // Approved in Claude Code, measured there: at the move it was already in
  // exec. Its rounds are outside, never rounds with no calls.
  const approvedBefore = issueReport({
    issue: ISSUE,
    calls: [call(1, 50)],
    entries: [
      entry(-10, 'triaged'),
      entry(-9, 'planned'),
      entry(-8, 'plan-reviewed', 'round-1 mode=full A=2 B=1 C=0'),
      entry(-7, 'plan-revised', 'round-1 applied to plan.md'),
      entry(-6, 'plan-reviewed', 'round-2 mode=delta A=0 B=1 C=1'),
      entry(-5, 'plan-approved'),
    ],
    record: { state: 'plan-approved', reviews: [file(1, 'plan-review.r1.md'), file(2, 'plan-review.r2.md'), file(3, 'plan-review.md')], after: AFTER },
    boundary: BOUNDARY.at,
  });

  test('a plan approved before the move: every round and every window is outside, not zero', () => {
    assert.deepEqual(
      approvedBefore.rounds.map((round) => [round.round, round.review, round.revision]),
      [
        [1, OUTSIDE, OUTSIDE],
        [2, OUTSIDE, NONE],
        // Only its file says it was there, and the approval that it came before the move.
        [3, OUTSIDE, NONE],
      ],
    );
    assert.deepEqual(
      [approvedBefore.totals.firstPlan, approvedBefore.totals.afterFirstPlan, approvedBefore.totals.tail],
      [OUTSIDE, OUTSIDE, OUTSIDE],
    );
    assert.equal(unitsOf(approvedBefore.totals.unsplit), 0, 'no window was closed by plan-revised alone');
    assert.deepEqual([approvedBefore.outside, approvedBefore.measuredSince], [[1, 2, 3], BOUNDARY.at]);
  });

  test('what was recorded stays: the counts of each round, and after approval', () => {
    assert.deepEqual(
      approvedBefore.rounds.map((round) => [round.mode, round.items, round.countedFrom]),
      [
        ['full', { A: 2, B: 1, C: 0 }, 'journal'],
        ['delta', { A: 0, B: 1, C: 1 }, 'journal'],
        ['unknown', { A: 1, B: 1, C: 0 }, 'file'],
      ],
    );
    assert.deepEqual(approvedBefore.unrecorded, [3]);
    assert.deepEqual(approvedBefore.after, { at: entry(-5, 'plan-approved').at, ...AFTER });
  });

  test('a plan that crossed the move: a window that opened before it is outside, one that opened after is measured', () => {
    const crossed = issueReport({
      issue: ISSUE,
      // build() drops the calls before the boundary; what is left after it.
      calls: [call(0.5, 100), call(1.5, 200), call(2.5, 300), call(3.5, 400)],
      entries: [
        entry(-3, 'triaged'),
        entry(-2, 'planned'),
        entry(-1.5, 'plan-reviewed', 'round-1 mode=full A=1 B=0 C=0'),
        entry(-1, 'plan-revised', 'round-1 applied to plan.md'),
        entry(1, 'plan-reviewed', 'round-2 mode=delta A=0 B=1 C=0'),
        entry(2, 'plan-revised', 'round-2 applied to plan.md'),
        entry(3, 'plan-reviewed', 'round-3 mode=delta A=0 B=0 C=0'),
        entry(4, 'plan-approved'),
      ],
      record: { state: 'plan-approved', reviews: [], after: AFTER },
      boundary: BOUNDARY.at,
    });
    assert.deepEqual(
      crossed.rounds.map((round) => [round.round, unitsOf(round.review), unitsOf(round.revision)]),
      [
        [1, OUTSIDE, OUTSIDE],
        // Its review began in Claude Code: the 100 after the move is part of it, not its cost.
        [2, OUTSIDE, 200],
        [3, 300, NONE],
      ],
    );
    assert.deepEqual([crossed.totals.firstPlan, crossed.totals.afterFirstPlan, unitsOf(crossed.totals.tail)], [OUTSIDE, OUTSIDE, 400]);
    assert.deepEqual(crossed.outside, [1, 2]);
  });

  test('a window that opens at the boundary is measured', () => {
    const at0 = issueReport({
      issue: ISSUE,
      calls: [call(0.5, 10), call(1.5, 20)],
      entries: [entry(-2, 'planned'), entry(-1, 'plan-reviewed', 'round-1 mode=full A=1 B=0 C=0'), entry(0, 'plan-revised', 'round-1 applied to plan.md'), entry(1, 'plan-reviewed', 'round-2 mode=delta A=0 B=0 C=0')],
      record: { state: 'planned', reviews: [], after: AFTER },
      boundary: entry(0, 'x').at,
    });
    assert.deepEqual(
      at0.rounds.map((round) => [round.round, unitsOf(round.review), unitsOf(round.revision)]),
      [
        [1, OUTSIDE, OUTSIDE],
        [2, 10, NONE],
      ],
    );
    assert.equal(unitsOf(at0.totals.tail), 20);
  });

  test('a round known only from plan-revised, before the move, is outside; still unrecorded', () => {
    const old = issueReport({
      issue: ISSUE,
      calls: [],
      entries: [entry(-5, 'planned'), entry(-4, 'plan-revised', 'round-1 applied to plan.md'), entry(-3, 'plan-revised', 'round-2 applied to plan.md'), entry(-2, 'plan-approved')],
      record: { state: 'plan-approved', reviews: [file(1, 'plan-review.r1.md'), file(2, 'plan-review.r2.md'), file(3, 'plan-review.md')], after: AFTER },
      boundary: BOUNDARY.at,
    });
    assert.deepEqual(
      old.rounds.map((round) => [round.round, round.review, round.revision]),
      [
        [1, OUTSIDE, OUTSIDE],
        [2, OUTSIDE, OUTSIDE],
        [3, OUTSIDE, NONE],
      ],
    );
    assert.deepEqual([old.totals.unsplit, old.totals.tail], [OUTSIDE, OUTSIDE]);
    assert.deepEqual(old.unrecorded, [1, 2, 3]);
  });

  test('a round known only from its file, with no approval to place it, stays unknown', () => {
    const open = issueReport({
      issue: ISSUE,
      calls: [call(1, 10)],
      entries: [entry(-2, 'planned'), entry(-1, 'plan-reviewed', 'round-1 mode=full A=1 B=0 C=0')],
      record: { state: 'planned', reviews: [file(2, 'plan-review.md')], after: AFTER },
      boundary: BOUNDARY.at,
    });
    assert.deepEqual(
      open.rounds.map((round) => [round.round, round.review, round.revision]),
      [
        [1, OUTSIDE, NONE],
        [2, UNKNOWN, NONE],
      ],
    );
    assert.equal(open.totals.tail, OUTSIDE);
    assert.deepEqual([open.outside, open.unrecorded], [[1], [2]]);
  });

  test('a plan wholly after the move is measured, and nothing is outside', () => {
    const fresh = issueReport({
      issue: ISSUE,
      calls: [call(1.5, 10), call(2.5, 20), call(3.5, 40)],
      entries: [entry(1, 'triaged'), entry(2, 'planned'), entry(3, 'plan-reviewed', 'round-1 mode=full A=1 B=0 C=0'), entry(4, 'plan-approved')],
      record: { state: 'plan-approved', reviews: [], after: AFTER },
      boundary: BOUNDARY.at,
    });
    assert.deepEqual([unitsOf(fresh.totals.firstPlan), unitsOf(fresh.rounds[0].review), unitsOf(fresh.totals.tail)], [10, 20, 40]);
    assert.deepEqual([fresh.outside, fresh.measuredSince], [[], null]);
  });

  test('with nothing read, unknown comes first: a skip is not a boundary', () => {
    const blind = issueReport({
      issue: ISSUE,
      calls: null,
      entries: [entry(-2, 'planned'), entry(-1, 'plan-reviewed', 'round-1 mode=full A=1 B=0 C=0')],
      record: { state: 'planned', reviews: [], after: AFTER },
      boundary: BOUNDARY.at,
    });
    assert.deepEqual([blind.rounds[0].review, blind.totals.afterFirstPlan, blind.measuredSince], [UNKNOWN, UNKNOWN, null]);
  });
});

describe('the report', () => {
  const entries = [entry(1, 'planned'), entry(2, 'plan-reviewed', 'round-1 mode=full A=1 B=0 C=0')];
  const report = build({ scan: scanOf([call(1.5, 10), call(30, 5)]), entries, records: { [ISSUE]: { state: 'planned', reviews: [], after: AFTER } }, issue: ISSUE });

  test('calls are attributed as the cost report does, and the unattributed ones are counted', () => {
    assert.equal(unitsOf(report.issues[0].rounds[0].review), 10);
    assert.deepEqual([report.coverage?.attributed, report.coverage?.unattributed], [1, 1]);
  });

  test("names its source as the cost report does, and Claude Code's no more", () => {
    assert.equal(report.opencode.db, '/data/opencode/opencode.db');
    assert.equal('transcripts' in report, false);
    assert.deepEqual([report.skip, report.boundary], [null, null]);
  });

  test('prints each round with its numbers, the caveats, and no verdict', () => {
    const text = format(report);
    assert.match(text, /r1\s+full\s+1\s+0\s+0/);
    assert.match(text, /caveats/);
    assert.match(text, /source\s+Open Code's session database at \/data\/opencode\/opencode\.db, read as pdkit cost reads it/);
    assert.match(text, /not counted\s+title and generate calls, steps a revert removed, and compactions/);
    assert.match(text, /not approved in this cycle/);
    assert.doesNotMatch(text, /measured\s+since|outside/);
    assert.doesNotMatch(text, /\b(?:good|bad|should|recommend)/i);
  });

  test('every cost is unknown when nothing was read, and the skip says why', () => {
    const blind = build({ scan: scanOf([], { skip: { reason: 'no Open Code database at /nowhere/opencode.db' } }), entries, records: {}, issue: ISSUE });
    assert.equal(blind.issues[0].rounds[0].review, UNKNOWN);
    assert.equal(blind.coverage, null);
    assert.match(format(blind), /^ {2}skip: no Open Code database at \/nowhere\/opencode\.db; every cost below is unknown$/m);
  });

  describe('with a boundary', () => {
    const before = [
      entry(-10, 'triaged'),
      entry(-9, 'planned'),
      entry(-8, 'plan-reviewed', 'round-1 mode=full A=2 B=1 C=0'),
      entry(-3, 'plan-revised', 'round-1 applied to plan.md'),
      entry(0.25, 'plan-reviewed', 'round-2 mode=delta A=0 B=1 C=1'),
      entry(1, 'plan-revised', 'round-2 applied to plan.md'),
      entry(2, 'plan-approved'),
    ];
    const records = { [ISSUE]: { state: 'plan-approved', reviews: [], after: AFTER } };
    // One call in Claude Code's time (in a trial session, say) and three after.
    const crossed = build({ scan: scanOf([call(-0.5, 7), call(0.1, 3), call(0.5, 30), call(1.5, 5)]), entries: before, records, issue: ISSUE, boundary: BOUNDARY });

    test('a call before it is not counted, only counted up', () => {
      assert.deepEqual(crossed.boundary, { ...BOUNDARY, callsBefore: 1 });
      assert.deepEqual([crossed.coverage?.calls, crossed.coverage?.attributed], [3, 3]);
    });

    test('the rounds before it read outside, with the boundary and what it is, and not as rounds without calls', () => {
      const text = format(crossed);
      assert.match(text, /^ {2}before 2026-11-12 10:00 UTC {2}outside Open Code data, not measured: a cost that began before it reads "outside"$/m);
      assert.match(text, /^ {2}r1\s+full\s+2\s+1\s+0\s+—\s+—\s+—\s+outside\s+outside\s+journal$/m);
      // Round 2's review began in Claude Code and ended after the move; its revision came after.
      assert.match(text, /^ {2}r2\s+delta\s+0\s+1\s+1\s+—\s+—\s+—\s+outside\s+30\s+journal$/m);
      assert.match(text, /^ {2}round\(s\) 1–2 began before 2026-11-12 10:00 UTC: outside Open Code data, not measured$/m);
      assert.match(text, /^ {2}first plan\s+outside\s+triaged → planned/m);
      assert.match(
        text,
        /^ {2}measured {5}since 2026-11-12 10:00 UTC, the newest snapshot read from Claude Code's transcripts \(cost\/2026-11-12\.json\);\n {15}before it, outside Open Code data, not measured — 1 call\(s\) before it not counted$/m,
      );
      assert.match(text, /outside {6}a cost whose window opened before 2026-11-12 10:00 UTC/);
      assert.doesNotMatch(text, /\b(?:good|bad|should|recommend)/i);
    });

    test('every issue: outside in the table, and the legend says what it means', () => {
      const all = build({
        scan: scanOf([call(1.5, 5)]),
        entries: [...before, { ...entry(3, 'planned'), issue: 200 }, { ...entry(4, 'plan-reviewed', 'round-1 mode=full A=1 B=0 C=0'), issue: 200 }],
        records: { ...records, 200: { state: 'planned', reviews: [], after: AFTER } },
        boundary: BOUNDARY,
      });
      const text = format(all);
      assert.match(text, /^ {2}100\s+plan-approved\s+2\s+2\s+outside\s+outside\s/m);
      assert.match(text, /^ {2}200\s+planned\s+1\s+1\s+—\s+—\s/m);
      assert.match(text, /^ {2}outside in a cost: it began before 2026-11-12 10:00 UTC, outside Open Code data, not measured\.$/m);
    });
  });
});

describe('read from disk', () => {
  let root;
  let home;
  let repo;
  let db;

  /** A step of Open Code, ended at the given hour, whose units are its input. */
  const step = (hours, input) => ({
    time: { created: T0 + hours * HOUR - 1000, completed: T0 + hours * HOUR },
    agent: 'build',
    model: { id: 'claude-sonnet-5-5', providerID: 'anthropic' },
    finish: 'stop',
    cost: 0,
    tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  });

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'pdkit-planning-'));
    home = join(root, 'home');
    repo = join(root, 'clone');
    await mkdir(repo, { recursive: true });
    await mkdir(join(root, 'elsewhere'), { recursive: true });

    const dir = issueDir(home, ISSUE);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'plan-review.r1.md'),
      '# PLAN REVIEW: DESKTOP-100 — round 1\n\n## A — must change\n### A1. x\n### A2. y\n## B — worth discussing\n## C — cannot judge\n- **C1.** z\n\n## Operator decisions (round 1)\n- A1: accepted\n- A2: rejected — no\n- C1: no decision\n',
    );
    await writeFile(join(dir, 'plan-review.md'), '# PLAN REVIEW: DESKTOP-100 — round 2\n\nMode: delta — only T3 changed\n\n## A — must change\n## B — worth discussing\n### B1. w\n## C — cannot judge\n');
    await writeFile(join(dir, 'audit.md'), '## Findings\n- [Q1] a.ts:1 — R1 — x\n- [Q4] b.ts:2 — T1 — nit: y\n');
    for (const [hours, event, detail] of [
      [1, 'planned', ''],
      [2, 'plan-revised', 'round-1 applied to plan.md'],
      [3, 'plan-reviewed', 'round-2 mode=delta A=0 B=1 C=0'],
      [4, 'plan-approved', ''],
    ]) {
      await append({ at: at(Number(hours)).replace(/\.\d{3}Z$/, 'Z'), issue: ISSUE, event: String(event), detail: String(detail) }, { home });
    }

    db = join(root, 'opencode.db');
    await database(db, {
      sessions: [
        { id: 'ses_top', directory: repo, created: T0 },
        // A subagent the review ran: its own session, under the top-level one.
        { id: 'ses_child', parent: 'ses_top', directory: repo, created: T0 + 2.5 * HOUR },
        // Another project, at the same time: not this clone's.
        { id: 'ses_other', directory: join(root, 'elsewhere'), created: T0 },
      ],
      messages: [
        { id: 'm1', session: 'ses_top', type: 'assistant', seq: 1, data: step(1.5, 10) },
        { id: 'm2', session: 'ses_top', type: 'assistant', seq: 2, data: step(2.5, 20) },
        { id: 'm3', session: 'ses_top', type: 'assistant', seq: 3, data: step(3.5, 40) },
        { id: 'm4', session: 'ses_child', type: 'assistant', seq: 1, data: step(2.6, 5) },
        { id: 'm5', session: 'ses_other', type: 'assistant', seq: 1, data: step(2.5, 9999) },
      ],
    });
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("the journal, the review files, audit.md and Open Code's sessions of the clone, each through its owner", async () => {
    const report = await collect({ db, repoRoot: repo, config: {}, home, issue: ISSUE });
    const [issue] = report.issues;
    assert.deepEqual(
      issue.rounds.map((round) => [round.round, round.mode, round.items, round.decisions?.accepted ?? null, unitsOf(round.review)]),
      [
        [1, 'unknown', { A: 2, B: 0, C: 1 }, 1, UNKNOWN],
        [2, 'delta', { A: 0, B: 1, C: 0 }, null, 25],
      ],
    );
    assert.equal(/** @type {import('../lib/planning.js').Part} */ (issue.rounds[1].review).subagentCalls, 1);
    assert.equal(unitsOf(issue.totals.unsplit), 10);
    assert.equal(issue.after?.audit.count, 2);
    assert.deepEqual([issue.after?.amendments, issue.after?.stops, issue.after?.failedTasks], [0, 0, []]);
    assert.deepEqual([report.opencode.db, report.opencode.subagentSessions, report.opencode.elsewhereSteps, report.boundary], [db, 1, 0, null]);
  });

  test("measures from the newest snapshot taken from Claude Code's transcripts", async () => {
    const cc = join(home, 'cost', '2026-11-12.json');
    await mkdir(join(home, 'cost'), { recursive: true });
    await writeFile(cc, `${JSON.stringify({ generatedAt: at(2), transcripts: { dirs: [] }, issues: [], routes: [] })}\n`);
    try {
      const report = await collect({ db, repoRoot: repo, config: {}, home, issue: ISSUE });
      const [issue] = report.issues;
      assert.deepEqual(report.boundary, { at: at(2), snapshot: '2026-11-12.json', callsBefore: 1 });
      assert.deepEqual(
        issue.rounds.map((round) => [round.round, unitsOf(round.review), unitsOf(round.revision)]),
        [
          [1, OUTSIDE, OUTSIDE],
          [2, 25, NONE],
        ],
      );
      assert.equal(issue.totals.unsplit, OUTSIDE);
    } finally {
      await rm(cc);
    }
  });

  test('reads the calls through the reader it is given', async () => {
    const asked = [];
    const report = await collect({
      db: '/somewhere/opencode.db',
      repoRoot: '/clone',
      config: { worktrees: { root: '../trees' } },
      home,
      issue: ISSUE,
      read: async (source) => {
        asked.push(source);
        return scanOf([call(3.5, 40)], { source: { ...scanOf([]).source, db: source.db } });
      },
    });
    assert.deepEqual(asked, [{ db: '/somewhere/opencode.db', repoRoot: '/clone', config: { worktrees: { root: '../trees' } } }]);
    assert.equal(report.opencode.db, '/somewhere/opencode.db');
    assert.equal(unitsOf(report.issues[0].totals.tail), 40);
  });
});

describe('the snapshot', () => {
  let home;

  before(async () => {
    home = await mkdtemp(join(tmpdir(), 'pdkit-planning-snapshot-'));
  });

  after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  /** @param {string} generatedAt */
  const reportAt = (generatedAt) => build({ scan: scanOf([]), entries: [], records: {}, generatedAt });

  test("goes beside the day's planning snapshot from Claude Code's transcripts, never over it", async () => {
    const dir = join(home, 'cost', 'planning');
    await mkdir(dir, { recursive: true });
    const theirs = `${JSON.stringify({ generatedAt: '2026-11-17T09:00:00.000Z', transcripts: { dirs: [], missing: [], skip: null }, issues: [] })}\n`;
    await writeFile(join(dir, '2026-11-17.json'), theirs);

    const first = await writeSnapshot(reportAt('2026-11-17T15:00:00.000Z'), { home });
    assert.equal(first, join(dir, '2026-11-17.opencode.json'));
    assert.equal(await readFile(join(dir, '2026-11-17.json'), 'utf8'), theirs);

    // The day's second one from Open Code replaces its own, still beside theirs.
    const second = await writeSnapshot(reportAt('2026-11-17T16:00:00.000Z'), { home });
    assert.equal(second, first);
    assert.equal(JSON.parse(await readFile(second, 'utf8')).generatedAt, '2026-11-17T16:00:00.000Z');
    assert.equal(await readFile(join(dir, '2026-11-17.json'), 'utf8'), theirs);
  });

  test('on any other day, a second one replaces the first, as before', async () => {
    const first = await writeSnapshot(reportAt('2026-11-18T09:00:00.000Z'), { home });
    const second = await writeSnapshot(reportAt('2026-11-18T10:00:00.000Z'), { home });
    assert.equal(first, join(home, 'cost', 'planning', '2026-11-18.json'));
    assert.equal(second, first);
    const written = JSON.parse(await readFile(second, 'utf8'));
    assert.equal(written.generatedAt, '2026-11-18T10:00:00.000Z');
    assert.equal('opencode' in written, true);
  });
});
