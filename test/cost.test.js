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

// Tests for lib/cost.js.
//
// The command exists to show "before" and "after" on one scale, so what is
// worth pinning is that the scale is honest: sums that are sums, a weighting
// that is the one documented, attribution that says where it stops, and a
// coverage figure that cannot be left out. What the source of calls gets wrong
// when it is read carelessly is pinned beside its reader, in
// test/opencode-sessions.test.js.
//
// And two things the move from Claude Code added: measuring starts at the
// newest snapshot taken from Claude Code's transcripts, so an issue with work
// before it is never printed as if its cost were known; and a comparison
// across the two sources says that their scales differ.
//
// Nothing here reads the database Open Code keeps for the user or ~/.claude.
// Fixtures are built in memory, and the tests that need files on disk write
// them to a temporary directory.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  ATTRIBUTION_WINDOW_MS,
  attributor,
  build,
  byModel,
  collect,
  compare,
  format,
  formatComparison,
  normalize,
  phaser,
  readSnapshot,
  tally,
  transitionBoundary,
  unattributedShare,
  unitsOf,
  writeSnapshot,
} from '../lib/cost.js';
import { append as appendJournal } from '../lib/journal.js';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-08-26T10:00:00Z');

/** @param {number} hours after T0 */
const at = (hours) => new Date(T0 + hours * HOUR).toISOString();

/** @param {object} over */
const call = (over = {}) => ({
  at: at(1),
  model: 'claude-sonnet-5',
  sessionId: 's1',
  agent: null,
  usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  ...over,
});

/** @param {Partial<import('../lib/opencode-sessions.js').Source>} over */
const sourceOf = (over = {}) => ({
  db: '/data/opencode/opencode.db',
  sessions: 1,
  subagentSessions: 0,
  steps: 0,
  unfinishedSteps: 0,
  forkCopies: 0,
  elsewhereSteps: 0,
  lastMessageInputSteps: 0,
  ...over,
});

/** @param {Partial<import('../lib/opencode-sessions.js').Scan>} over */
const scanOf = (over = {}) => ({
  calls: [],
  compactions: [],
  source: sourceOf(),
  skip: null,
  ...over,
});

/** @param {number} hours @param {number} issue @param {string} event */
const entry = (hours, issue, event) => ({ at: at(hours).replace(/\.\d{3}Z$/, 'Z'), issue, slice: null, event, detail: '' });

describe('the scale', () => {
  test('units are the documented weighting, and Opus is five times Sonnet', () => {
    const usage = { input: 1000, cacheRead: 10_000, cacheWrite: 800, output: 200 };
    // 1000 + 0.1·10000 + 1.25·800 + 5·200 = 1000 + 1000 + 1000 + 1000
    assert.equal(unitsOf(usage, 'claude-sonnet-5'), 4000);
    assert.equal(unitsOf(usage, 'claude-opus-5'), 20_000);
    assert.equal(unitsOf(usage, 'claude-opus-5-5'), 20_000);
  });

  test('sums, averages and the peak over a known set of calls', () => {
    const totals = tally([
      call({ model: 'claude-opus-5', sessionId: 'a', usage: { input: 10, cacheRead: 100, cacheWrite: 0, output: 1 } }),
      call({ model: 'claude-opus-5', sessionId: 'a', usage: { input: 0, cacheRead: 300, cacheWrite: 20, output: 2 } }),
      call({ sessionId: 'a', agent: 'x1', usage: { input: 5, cacheRead: 55, cacheWrite: 0, output: 4 } }),
      call({ sessionId: 'b', usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } }),
    ]);

    assert.equal(totals.calls, 4);
    assert.equal(totals.subagentCalls, 1);
    assert.equal(totals.cacheRead, 455);
    assert.equal(totals.output, 7);
    // contexts: 110, 320, 60, 0
    assert.equal(totals.avgContext, 122.5);
    assert.equal(totals.peakContext, 320);
    assert.equal(totals.opusShare, 0.5);
    // Parent sessions only; the subagent is an agent run, not a session.
    assert.equal(totals.sessions, 2);
    assert.equal(totals.agentRuns, 1);
    // (10 + 10 + 5)·5 + (30 + 25 + 10)·5 + (5 + 5.5 + 20) = 125 + 325 + 30.5
    assert.equal(totals.units, 480.5);
  });

  test('normalizing divides by what is known, and by nothing that is zero or unknown', () => {
    const per = normalize(1200, { tasks: 4, slices: 0, requirements: null, changedLines: 600, mergedPrs: 1, agentRuns: 3 });
    assert.equal(per.tasks, 300);
    assert.equal(per.slices, null);
    assert.equal(per.requirements, null);
    assert.equal(per.changedLines, 2);
    assert.equal(per.mergedPrs, 1200);
    assert.equal(per.agentRuns, 400);
  });
});

describe('attribution', () => {
  const issueOf = attributor([entry(0, 100, 'triaged'), entry(10, 200, 'triaged')]);

  test('a call inside the window after an entry belongs to that entry\'s issue', () => {
    assert.equal(issueOf(at(0)), 100);
    assert.equal(issueOf(at(5.9)), 100);
    assert.equal(issueOf(at(10.5)), 200);
  });

  test('a call further from the entry than the window belongs to nobody', () => {
    assert.equal(ATTRIBUTION_WINDOW_MS, 6 * HOUR);
    assert.equal(issueOf(at(6.1)), null);
  });

  test('a call before the first entry of all belongs to nobody', () => {
    assert.equal(issueOf(at(-1)), null);
  });

  test('entries without an issue do not claim calls', () => {
    const only = attributor([{ at: at(0), issue: null, event: 'denied' }]);
    assert.equal(only(at(1)), null);
  });

  test('the phase is the one the last transition before the call opened', () => {
    const phaseOf = phaser([entry(0, 1, 'worktree-create'), entry(1, 1, 'triaged'), entry(2, 1, 'plan-approved'), entry(3, 1, 'task-start')]);
    assert.equal(phaseOf(at(0.5)), 'triage');
    assert.equal(phaseOf(at(1.5)), 'plan');
    assert.equal(phaseOf(at(3.5)), 'exec');
  });

  test('the unattributed share is counted over every call in the window', () => {
    const report = build({
      scan: scanOf({
        calls: [call({ at: at(-2) }), call({ at: at(1) }), call({ at: at(2) }), call({ at: at(9) })],
      }),
      entries: [entry(0, 100, 'triaged')],
      records: {},
    });

    assert.equal(report.coverage.calls, 4);
    assert.equal(report.coverage.attributed, 2);
    assert.equal(report.coverage.unattributed, 2);
    assert.equal(report.coverage.unattributedShare, 0.5);
    assert.equal(unattributedShare(0, 0), null);
    assert.match(format(report), /50 % of 4 call\(s\) in the window mapped to an issue; 2 \(50 %/);
  });

  test('--since narrows the calls, not the journal that explains them', () => {
    const report = build({
      scan: scanOf({ calls: [call({ at: at(1) }), call({ at: at(3) })] }),
      entries: [entry(0, 100, 'triaged')],
      records: {},
      since: at(2),
    });
    assert.equal(report.coverage.calls, 1);
    assert.equal(report.coverage.attributed, 1);
  });
});

describe('the report', () => {
  const opus = { input: 0, cacheRead: 1000, cacheWrite: 0, output: 0 };
  const report = build({
    scan: scanOf({
      calls: [
        call({ at: at(0.5), model: 'claude-opus-5', usage: opus }),
        call({ at: at(1.5), model: 'claude-opus-5', usage: opus }),
        call({ at: at(1.6), model: 'claude-opus-5', usage: opus, agent: 'a1' }),
        call({ at: at(1.7), model: 'claude-opus-5', usage: opus }),
        call({ at: at(30.5), usage: opus }),
      ],
      compactions: [
        { at: at(1.55), sessionId: 's1', agent: null, model: 'claude-opus-5', usage: { input: 0, cacheRead: 0, cacheWrite: 1000, output: 100 } },
      ],
    }),
    entries: [entry(0, 100, 'worktree-create'), entry(1, 100, 'triaged'), entry(30, 300, 'quickfix')],
    records: {
      100: { route: 'standard', state: 'planned', tasks: 4, slices: 2, requirements: null, changedLines: null, mergedPrs: 0, unavailable: { requirements: 'no requirements allocated', changedLines: 'no open or merged pull request' } },
      300: { route: 'quickfix', state: 'quickfix', tasks: null, slices: null, requirements: null, changedLines: 10, mergedPrs: 1, unavailable: {} },
    },
  });
  const issue = report.issues.find((entry) => entry.issue === 100);

  test('splits an issue by phase, and the shares add up', () => {
    assert.deepEqual(
      issue.phases.map((phase) => [phase.phase, phase.calls]),
      [
        ['triage', 1],
        ['plan', 3],
      ],
    );
    assert.equal(issue.phases.reduce((sum, phase) => sum + phase.share, 0), 1);
    assert.equal(issue.totals.compactions, 1);
  });

  test('a compaction is counted, measured and printed apart, and never summed into the totals', () => {
    // Four Opus calls of 1000 cache-read: 4·100·5. The compaction, (1250 + 500)·5, is not in it.
    assert.equal(issue.totals.units, 2000);
    assert.equal(issue.totals.compactionUnits, 8750);
    assert.equal(report.coverage.compactions.units, 8750);

    const text = format({ ...report, issue: 100, issues: [issue] });
    assert.match(text, /compaction cost\s+8\.8 k units in 1 call\(s\) — measured, not in the totals/);
    assert.match(text, /compactions\s+1 in the window, 8\.8 k units — measured, not in the totals/);
  });

  test('agent runs come from subagent sessions, and the journal count stands beside them', () => {
    assert.equal(issue.denominators.agentRuns, 1);
    assert.equal(issue.denominators.agentDone, 0);
    assert.equal(issue.normalised.agentRuns, issue.totals.units);
  });

  test('an issue with no agent run says the denominator is unavailable rather than dividing by zero', () => {
    const quick = report.issues.find((entry) => entry.issue === 300);
    assert.equal(quick.normalised.agentRuns, null);
    assert.match(quick.denominators.unavailable.agentRuns, /no subagent session/);
  });

  test('a denominator that is not known is printed as unavailable, with the reason', () => {
    const text = format({ ...report, issue: 100, issues: [issue] });
    assert.match(text, /per requirement\s+unavailable: no requirements allocated/);
    assert.match(text, /per merged PR\s+unavailable/);
    assert.doesNotMatch(text, /Infinity|NaN/);
  });

  test('issues are grouped by route and never into one table', () => {
    assert.deepEqual(
      report.routes.map((group) => [group.route, group.issues]),
      [
        ['quickfix', [300]],
        ['standard', [100]],
      ],
    );
    assert.match(format(report), /routes\s+not comparable/);
  });

  test('prints the caveats, and recommends nothing', () => {
    const text = format(report);
    assert.match(text, /lockfiles and generated output included/);
    assert.match(text, /attribution\s+a call belongs to the issue of the nearest earlier journal entry within 6 h/);
    assert.doesNotMatch(text, /\b(should|recommend|reduce|too expensive|consider)\b/i);
  });

  test('prints what the source does not give, and how it was read', () => {
    const text = format(
      build({
        scan: scanOf({ calls: [call()], source: sourceOf({ forkCopies: 3, unfinishedSteps: 2, elsewhereSteps: 4, lastMessageInputSteps: 5 }) }),
        entries: [entry(0, 100, 'triaged')],
        records: {},
      }),
    );
    assert.match(text, /source\s+Open Code's session database at \/data\/opencode\/opencode\.db: one call per step with tokens, output with reasoning/);
    assert.match(text, /3 message\(s\) a fork copied not counted again; 2 step\(s\) without tokens, running or failed, not counted/);
    assert.match(text, /not counted\s+title and generate calls, and steps a revert removed: they are only in the session totals,\s+with no model and no time/);
    assert.match(text, /compactions\s+measured and printed apart, not in the totals/);
    assert.match(text, /a model with no "opus" in its name, of any provider, weighs as Sonnet/);
    assert.match(text, /elsewhere\s+4 step\(s\) of these sessions taken outside the clone and its worktrees, not counted/);
    assert.match(text, /claude-agent\s+5 step\(s\) carry the input and cache of their last request alone/);

    const quiet = format(build({ scan: scanOf({ calls: [call()] }), entries: [entry(0, 100, 'triaged')], records: {} }));
    assert.doesNotMatch(quiet, /^\s+(elsewhere|claude-agent)\s/m);
  });

  test('tokens by model, dearest first, in the issue block', () => {
    const models = byModel([
      call({ model: 'openai/gpt-6.1-sol', usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 10 } }),
      call({ model: 'claude-agent/opus#high', usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 1 } }),
      call({ model: 'openai/gpt-6.1-sol', usage: { input: 50, cacheRead: 200, cacheWrite: 0, output: 0 } }),
    ]);
    assert.deepEqual(models, [
      // 150 + 0.1·200 + 5·10, on the Sonnet scale: no "opus" in the name.
      { model: 'openai/gpt-6.1-sol', calls: 2, input: 150, cacheRead: 200, cacheWrite: 0, output: 10, units: 220 },
      { model: 'claude-agent/opus#high', calls: 1, input: 10, cacheRead: 0, cacheWrite: 0, output: 1, units: 75 },
    ]);

    assert.deepEqual(issue.models.map((row) => [row.model, row.calls]), [['claude-opus-5', 4]]);
    assert.match(format({ ...report, issue: 100, issues: [issue] }), /by model\s+calls\s+fresh\s+cache-read\s+cache-write\s+output\s+cost units\n\s+claude-opus-5\s+4\s/);
  });

  test('comparison puts only issues new since the snapshot on the "after" side', () => {
    const later = build({
      scan: scanOf({
        calls: [
          call({ at: at(0.5), model: 'claude-opus-5', usage: opus }),
          call({ at: at(50.5), model: 'claude-opus-5', usage: { input: 0, cacheRead: 500, cacheWrite: 0, output: 0 } }),
        ],
      }),
      entries: [entry(0, 100, 'triaged'), entry(50, 400, 'triaged')],
      records: {
        100: { route: 'standard', tasks: 4, slices: 2 },
        400: { route: 'standard', tasks: 4, slices: 1 },
      },
    });

    const result = compare(report, later);
    assert.deepEqual(result.issuesAfter, [400]);
    const perTask = result.routes.find((group) => group.route === 'standard').rows.find((row) => row.metric === 'per task');
    // before: 4 Opus calls of 1000 cache-read = 4·100·5 = 2000 units over 4 tasks
    // after: one of 500 = 250 units over 4 tasks
    assert.equal(perTask.before, 500);
    assert.equal(perTask.after, 62.5);
    assert.equal(perTask.delta, -0.875);
  });
});

describe('reading the calls', () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pdkit-cost-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('reads the calls through the reader it is given, and names that source', async () => {
    const home = join(dir, 'seam-home');
    await appendJournal({ at: at(0).replace(/\.\d{3}Z$/, 'Z'), issue: 100, event: 'triaged' }, { home });
    const asked = [];

    const report = await collect({
      db: '/somewhere/opencode.db',
      repoRoot: '/clone',
      config: { worktrees: { root: '../trees' } },
      home,
      sizeOf: async () => 0,
      read: async (source) => {
        asked.push(source);
        return scanOf({ calls: [call({ usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 1 } })], source: sourceOf({ db: source.db, steps: 1 }) });
      },
    });

    assert.deepEqual(asked, [{ db: '/somewhere/opencode.db', repoRoot: '/clone', config: { worktrees: { root: '../trees' } } }]);
    assert.equal(report.opencode.db, '/somewhere/opencode.db');
    assert.equal('transcripts' in report, false);
    assert.equal(report.issues[0].totals.units, 15);
  });

  test('a missing database is a skip with a reason, not an exception, and not zeros', async () => {
    const home = join(dir, 'home');
    const report = await collect({
      db: join(dir, 'does-not-exist.db'),
      repoRoot: dir,
      config: {},
      home,
      sizeOf: async () => {
        throw new Error('not reached');
      },
    });

    assert.ok(report.skip);
    assert.match(report.skip.reason, /no Open Code database at .*does-not-exist\.db/);
    assert.equal(report.coverage, null);
    assert.deepEqual(report.issues, []);
    assert.match(format(report), /skip: no Open Code database/);
  });

  test('a real database of the 2.3.0 schema, read end to end, prints figures that are not zero', async () => {
    const home = join(dir, 'db-home');
    const repo = join(dir, 'clone');
    await mkdir(repo, { recursive: true });
    const file = join(dir, 'opencode.db');

    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file);
    db.exec(await readFile(join(dirname(dirname(fileURLToPath(import.meta.url))), 'test', 'fixtures', 'opencode-schema-2.3.0.sql'), 'utf8'));
    db.prepare("insert into project (id, worktree, time_created, time_updated, sandboxes) values ('p', '/', 0, 0, '[]')").run();
    const session = db.prepare(
      "insert into session_v2 (id, project_id, parent_id, slug, directory, version, time_created, time_updated) values (?, 'p', ?, 's', ?, '2.3.0', 0, 0)",
    );
    session.run('top', null, repo);
    session.run('child', 'top', repo);
    const message = db.prepare("insert into session_message (id, session_id, type, seq, time_created, time_updated, data) values (?, ?, 'assistant', ?, ?, ?, ?)");
    const stepAt = (hours, model, tokens) => {
      const t = T0 + hours * HOUR;
      return [t, t, JSON.stringify({ time: { created: t, completed: t + 1000 }, model, tokens })];
    };
    message.run('m1', 'top', 1, ...stepAt(1, { providerID: 'claude-agent', id: 'opus', variant: 'high' }, { input: 100, output: 10, reasoning: 10, cache: { read: 1000, write: 0 } }));
    message.run('m2', 'child', 1, ...stepAt(2, { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'default' }, { input: 50, output: 5, reasoning: 0, cache: { read: 0, write: 0 } }));
    db.close();

    await appendJournal({ at: at(0).replace(/\.\d{3}Z$/, 'Z'), issue: 100, event: 'triaged' }, { home });
    const report = await collect({ db: file, repoRoot: repo, config: {}, home, issue: 100, sizeOf: async () => 0 });

    assert.equal(report.skip, null);
    const [entry100] = report.issues;
    assert.equal(entry100.totals.calls, 2);
    assert.equal(entry100.totals.subagentCalls, 1);
    assert.equal(entry100.denominators.agentRuns, 1);
    // (100 + 0.1·1000 + 5·20)·5 + (50 + 5·5) = 1500 + 75
    assert.equal(entry100.totals.units, 1575);
    assert.deepEqual(entry100.phases.map((phase) => [phase.phase, phase.calls]), [['plan', 2]]);
    assert.match(format(report), /API calls\s+2\s+\(1 in subagents\)/);
  });
});

// $PDKIT_HOME is shared with the Claude Code version, so the journal names work
// Open Code's database never saw. Printed as if the database held all of it,
// an issue begun under Claude Code would look as cheap as the part of it done
// since — the figure would be wider than what was measured.
describe('where measuring starts', () => {
  let home;
  const CC = '2026-08-26T12:00:00.000Z';

  before(async () => {
    home = await mkdtemp(join(tmpdir(), 'pdkit-cost-boundary-'));
    await mkdir(join(home, 'cost', 'planning'), { recursive: true });
    const snapshot = (name, body) => writeFile(join(home, 'cost', name), `${JSON.stringify(body)}\n`);
    await snapshot('2026-08-20.json', { generatedAt: '2026-08-20T09:00:00.000Z', transcripts: { dirs: [] }, issues: [], routes: [] });
    await snapshot('2026-08-26.json', { generatedAt: CC, transcripts: { dirs: [] }, issues: [], routes: [] });
    // Taken here, after the move: not where Claude Code stopped.
    await snapshot('2026-08-30.json', { generatedAt: '2026-08-30T09:00:00.000Z', opencode: { db: '/x' }, issues: [], routes: [] });
    await snapshot('planning/2026-08-29.json', { generatedAt: '2026-08-29T09:00:00.000Z', transcripts: { dirs: [] } });
  });

  after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test('is the newest snapshot read from Claude Code\'s transcripts', async () => {
    assert.deepEqual(await transitionBoundary({ home }), { at: CC, snapshot: '2026-08-26.json' });
    assert.equal(await transitionBoundary({ home: join(home, 'nothing-here') }), null);
  });

  test('a snapshot it cannot read stops the report rather than move the boundary', async () => {
    const broken = await mkdtemp(join(tmpdir(), 'pdkit-cost-broken-'));
    try {
      await mkdir(join(broken, 'cost'));
      await writeFile(join(broken, 'cost', '2026-08-26.json'), '{ not json');
      await assert.rejects(transitionBoundary({ home: broken }), /2026-08-26\.json is not a snapshot pdkit can read/);
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
  });

  // T0 + 2 h is the boundary. Issue 100 was triaged under Claude Code and
  // went on in Open Code; 300 began after the move; 400 was worked on only
  // before it.
  const boundary = { at: CC, snapshot: '2026-08-26.json' };
  const usage = { input: 0, cacheRead: 1000, cacheWrite: 0, output: 0 };
  const input = {
    scan: scanOf({
      calls: [
        call({ at: at(0.5), usage }),
        call({ at: at(1.5), usage }),
        call({ at: at(2.5), usage }),
        call({ at: at(3.5), usage }),
        call({ at: at(30.5), usage }),
      ],
    }),
    entries: [entry(-1, 400, 'triaged'), entry(0, 100, 'triaged'), entry(3, 100, 'planned'), entry(30, 300, 'quickfix')],
    records: {
      100: { route: 'standard', tasks: 4 },
      300: { route: 'quickfix', tasks: 1, changedLines: 10 },
      400: { route: 'standard', tasks: 2 },
    },
    boundary,
  };
  const report = build(input);
  const of = (number) => report.issues.find((entry) => entry.issue === number);

  test('a call before it is not counted, only counted up', () => {
    assert.equal(report.boundary.applies, true);
    assert.equal(report.boundary.callsBefore, 2);
    assert.equal(report.coverage.calls, 3);
    assert.equal(of(100).totals.calls, 2);
  });

  test('an issue with work before it is marked, divided by nothing, and kept out of the groups', () => {
    assert.equal(of(100).measuredSince, CC);
    assert.deepEqual(Object.values(of(100).normalised), [null, null, null, null, null, null]);
    assert.equal(of(300).measuredSince, null);
    assert.equal(of(300).normalised.tasks, 100);
    assert.deepEqual(report.routes.map((group) => [group.route, group.issues]), [['quickfix', [300]]]);
  });

  test('the issue block says it, and the ratios say why they are missing', () => {
    const text = format({ ...report, issue: 100, issues: [of(100)] });
    assert.match(text, /before 2026-08-26 12:00 UTC  outside Open Code data, not measured; what follows came after/);
    assert.match(text, /normalized \(cost units\)\n\s+unavailable: what it cost before 2026-08-26 12:00 UTC was not measured/);
    assert.match(
      text,
      /measured since\s+2026-08-26 12:00 UTC, the newest snapshot read from Claude Code's transcripts \(cost\/2026-08-26\.json\);\s+before it, outside Open Code data, not measured — 2 call\(s\) before it not counted/,
    );
    assert.doesNotMatch(text, /per task\s+\d/);
  });

  test('the whole report lists them apart, the ones with no call since included, and not as idle', () => {
    const text = format(report);
    assert.match(text, /measured only since 2026-08-26 12:00 UTC: before it outside Open Code data, not measured\n\n\s+issue\s+calls[^\n]*\n\s+100\s+2\s/);
    assert.match(text, /no attributed call since: 400/);
    assert.doesNotMatch(text, /no attributed calls: .*400/);
  });

  test('a window that opens after it needs no mark', () => {
    const later = build({ ...input, since: at(3) });
    assert.equal(later.boundary.applies, false);
    assert.equal(later.boundary.callsBefore, 0);
    assert.equal(later.issues.every((entry) => entry.measuredSince === null), true);
    assert.doesNotMatch(format(later), /measured since|outside Open Code data/);
  });

  test('without a snapshot from Claude Code there is no boundary to print', () => {
    const none = build({ ...input, boundary: null });
    assert.equal(none.boundary, null);
    assert.equal(none.coverage.calls, 5);
    assert.doesNotMatch(format(none), /outside Open Code data/);
  });

  // The day the move is made is the day both versions take a snapshot. Taken
  // here over Claude Code's, the second would erase where measuring starts.
  test("a snapshot taken the day of one from Claude Code's transcripts goes beside it, not over it", async () => {
    const day = await mkdtemp(join(tmpdir(), 'pdkit-cost-day-'));
    try {
      await mkdir(join(day, 'cost'));
      const theirs = `${JSON.stringify({ generatedAt: CC, transcripts: { dirs: [] }, issues: [], routes: [] })}\n`;
      await writeFile(join(day, 'cost', '2026-08-26.json'), theirs);

      const first = await writeSnapshot({ ...report, generatedAt: '2026-08-26T18:00:00.000Z' }, { home: day });
      assert.equal(first, join(day, 'cost', '2026-08-26.opencode.json'));
      assert.equal(await readFile(join(day, 'cost', '2026-08-26.json'), 'utf8'), theirs);
      assert.deepEqual(await transitionBoundary({ home: day }), { at: CC, snapshot: '2026-08-26.json' });

      // A second one that day replaces the first of its own kind, as before.
      const second = await writeSnapshot({ ...report, generatedAt: '2026-08-26T19:00:00.000Z' }, { home: day });
      assert.equal(second, first);
      assert.equal((await readSnapshot('2026-08-26.opencode', { home: day })).generatedAt, '2026-08-26T19:00:00.000Z');
      assert.equal((await readSnapshot('2026-08-26', { home: day })).generatedAt, CC);
      await assert.rejects(readSnapshot('2026-08-27', { home: day }), /there are: 2026-08-26, 2026-08-26\.opencode/);
      await assert.rejects(readSnapshot('2026-08-26.claude', { home: day }), /expected the date of a snapshot \(YYYY-MM-DD\), or YYYY-MM-DD\.opencode/);

      // A snapshot of this source that day is replaced as it always was.
      const ours = await mkdtemp(join(tmpdir(), 'pdkit-cost-ours-'));
      try {
        await mkdir(join(ours, 'cost'));
        await writeFile(join(ours, 'cost', '2026-08-26.json'), `${JSON.stringify({ generatedAt: CC, opencode: {} })}\n`);
        assert.equal(await writeSnapshot({ ...report, generatedAt: '2026-08-26T18:00:00.000Z' }, { home: ours }), join(ours, 'cost', '2026-08-26.json'));
      } finally {
        await rm(ours, { recursive: true, force: true });
      }

      // And a file that cannot be read is not replaced either: it may be theirs.
      await writeFile(join(day, 'cost', '2026-08-27.json'), '{ not json');
      assert.equal(await writeSnapshot({ ...report, generatedAt: '2026-08-27T09:00:00.000Z' }, { home: day }), join(day, 'cost', '2026-08-27.opencode.json'));
      assert.equal(await readFile(join(day, 'cost', '2026-08-27.json'), 'utf8'), '{ not json');
    } finally {
      await rm(day, { recursive: true, force: true });
    }
  });

  test('a snapshot keeps the shape of issues and routes the Claude Code version reads', async () => {
    const file = await writeSnapshot({ ...report, generatedAt: '2026-09-01T00:00:00.000Z' }, { home });
    const written = JSON.parse(await readFile(file, 'utf8'));
    assert.ok(written.opencode);
    for (const group of written.routes) {
      for (const key of ['route', 'issues', 'normalised', 'avgContext', 'sessionsPerIssue', 'opusShare', 'denominators']) assert.ok(key in group, key);
    }
    for (const entry of written.issues) assert.equal(typeof entry.issue, 'number');
    // And it does not move the boundary: it was not read from Claude Code's transcripts.
    assert.deepEqual(await transitionBoundary({ home }), { at: CC, snapshot: '2026-08-26.json' });
  });
});

describe('a comparison across sources', () => {
  const opus = { input: 0, cacheRead: 1000, cacheWrite: 0, output: 0 };
  const now = build({
    scan: scanOf({ calls: [call({ at: at(50.5), usage: opus })] }),
    entries: [entry(50, 400, 'triaged')],
    records: { 400: { route: 'standard', tasks: 4 } },
  });
  const claudeCode = {
    generatedAt: '2026-08-20T09:00:00.000Z',
    weights: now.weights,
    transcripts: { dirs: [] },
    coverage: { unattributedShare: 0.1 },
    issues: [{ issue: 100 }],
    routes: [{ route: 'standard', issues: [100], normalised: { tasks: 500 }, denominators: { tasks: 4, agentRuns: 0 }, avgContext: 1000, sessionsPerIssue: 1, opusShare: 1 }],
  };

  test('says the scales differ when the sources do, and still puts the figures side by side', () => {
    const result = compare(claudeCode, now);
    assert.equal(result.scales.sameSource, false);
    assert.equal(result.scales.sameWeights, true);
    const text = formatComparison(result);
    assert.match(
      text,
      /the scales differ:\n\s+calls before were read from Claude Code's transcripts, after from Open Code's session database;\n\s+each counts a call, its output and its compactions in its own way\n\s+the figures below stand side by side, not on one scale/,
    );
    assert.match(text, /per task\s+500\s+25/);
  });

  test('and when the weights do', () => {
    const text = formatComparison(compare({ ...now, weights: { ...now.weights, output: 4 } }, now));
    assert.match(text, /the scales differ:\n\s+weights before \{.*"output":4.*\}, after \{.*"output":5.*\}/);
  });

  test('and says nothing of the kind when both are the same', () => {
    const result = compare(now, now);
    assert.equal(result.scales.sameSource, true);
    assert.doesNotMatch(formatComparison(result), /scales differ/);
  });
});

// Sessions are picked by the directory they ran in. Run from another
// repository — this plugin's own checkout, say — the report read that one's
// sessions, attributed them to the home's issues by time alone, and showed
// planning with no calls at all. Refused there, both reports, and said why.
describe('run outside the configured clone', () => {
  const BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'pdkit');
  let root;
  let repo;

  /** @param {string[]} args */
  async function pdkit(args) {
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [BIN, ...args], {
        cwd: repo,
        env: { ...process.env, PDKIT_HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'claude') },
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  }

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'pdkit-cost-clone-'));
    repo = join(root, 'elsewhere');
    await mkdir(repo);
    await promisify(execFile)('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    await promisify(execFile)('git', ['remote', 'add', 'origin', 'https://github.com/someone/another-project.git'], { cwd: repo });
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('is refused, with which remote says so and the ways to name the clone', async () => {
    for (const args of [['cost'], ['cost', '--db', join(root, 'opencode.db')], ['cost', '--planning'], ['cost', '--planning', '--db', join(root, 'opencode.db')]]) {
      const out = await pdkit(args);

      assert.equal(out.code, 1);
      assert.match(out.stderr, /^pdkit cost: .*elsewhere is not the configured clone: remote "upstream" is missing \(expected podman-desktop\/podman-desktop\)/);
      assert.match(out.stderr, /Sessions are picked by the directory they ran in/);
      assert.match(out.stderr, /Run it inside the clone, pass --repo <clone>, or set repo\.path\.\n$/);
      assert.equal(out.stdout, '');
    }
  });

  test("Claude Code's --transcripts is gone from both reports, refused as any unknown flag", async () => {
    for (const args of [['cost'], ['cost', '--planning']]) {
      const out = await pdkit([...args, '--transcripts', join(root, 'claude', 'projects', 'x')]);
      assert.equal(out.code, 1);
      assert.match(out.stderr, /^pdkit cost: unknown flag --transcripts\n/);
      assert.doesNotMatch(out.stderr, /takes .*--transcripts/);
    }
  });
});

// Inside a clone pdkit takes for the configured one, end to end through the
// entry point, on a database of the 2.3.0 schema with no sessions in it.
describe('run inside the configured clone', () => {
  const BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'pdkit');
  let root;
  let repo;
  let db;

  /** @param {string[]} args */
  async function pdkit(args) {
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [BIN, ...args], {
        cwd: repo,
        env: { ...process.env, PDKIT_HOME: join(root, 'home') },
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  }

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'pdkit-cost-inside-'));
    repo = join(root, 'podman-desktop');
    await mkdir(repo);
    await promisify(execFile)('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    await promisify(execFile)('git', ['remote', 'add', 'upstream', 'https://github.com/podman-desktop/podman-desktop.git'], { cwd: repo });

    db = join(root, 'opencode.db');
    const { DatabaseSync } = await import('node:sqlite');
    const handle = new DatabaseSync(db);
    handle.exec(await readFile(join(dirname(dirname(fileURLToPath(import.meta.url))), 'test', 'fixtures', 'opencode-schema-2.3.0.sql'), 'utf8'));
    handle.close();
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("measures, and keeps the day's snapshot from Claude Code's transcripts when it takes its own", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await mkdir(join(root, 'home', 'cost'), { recursive: true });
    const theirs = join(root, 'home', 'cost', `${today}.json`);
    await writeFile(theirs, `${JSON.stringify({ generatedAt: new Date(Date.now() - 1000).toISOString(), transcripts: { dirs: [] }, issues: [], routes: [] })}\n`);

    const out = await pdkit(['cost', '--db', db, '--snapshot']);

    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /attribution\s+— of 0 call\(s\) in the window/);
    assert.match(out.stdout, new RegExp(`snapshot written to .*${today}\\.opencode\\.json`));
    assert.match(out.stderr, new RegExp(`marks where measuring starts, so it is kept; compare with this one as --compare ${today}\\.opencode\\n$`));
    assert.ok(JSON.parse(await readFile(theirs, 'utf8')).transcripts, 'the snapshot from Claude Code is still there');

    const compared = await pdkit(['cost', '--db', db, '--compare', today]);
    assert.equal(compared.code, 0, compared.stderr);
    assert.match(compared.stdout, /the scales differ:\n\s+calls before were read from Claude Code's transcripts, after from Open Code's session database/);
  });

  test("planning reads the same database from the same boundary, and keeps the day's planning snapshot from Claude Code's transcripts", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const taken = new Date(Date.now() - 1000).toISOString();
    await mkdir(join(root, 'home', 'cost', 'planning'), { recursive: true });
    await writeFile(join(root, 'home', 'cost', `${today}.json`), `${JSON.stringify({ generatedAt: taken, transcripts: { dirs: [] }, issues: [], routes: [] })}\n`);
    const theirs = join(root, 'home', 'cost', 'planning', `${today}.json`);
    const kept = `${JSON.stringify({ generatedAt: taken, transcripts: { dirs: [], missing: [], skip: null }, issues: [] })}\n`;
    await writeFile(theirs, kept);

    const out = await pdkit(['cost', '--planning', '--db', db, '--snapshot']);

    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /attribution {2}0 of 0 call\(s\) mapped to an issue; 0 to none/);
    assert.match(out.stdout, new RegExp(`measured {5}since .*\\(cost/${today}\\.json\\);`));
    assert.match(out.stdout, /source {7}Open Code's session database at .*opencode\.db, read as pdkit cost reads it/);
    assert.match(out.stdout, new RegExp(`snapshot written to .*planning.${today}\\.opencode\\.json`));
    assert.match(out.stderr, new RegExp(`holds the rounds measured before the move, so it is kept; this one is ${today}\\.opencode\\.json beside it\\n$`));
    assert.equal(await readFile(theirs, 'utf8'), kept);
    const ours = JSON.parse(await readFile(join(root, 'home', 'cost', 'planning', `${today}.opencode.json`), 'utf8'));
    assert.deepEqual([ours.opencode.db, 'transcripts' in ours, ours.boundary.snapshot], [db, false, `${today}.json`]);
  });
});
