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

// What an issue cost, in tokens, normalized by how much work it was.
//
// A figure for one issue answers nothing on its own. An issue with fourteen
// tasks and two slices is supposed to be dearer than a one-task fix, and the
// point of measuring is to tell a cycle that got cheaper from a cycle that was
// smaller. So every total here travels with its denominators — tasks, slices,
// requirements, changed lines, merged pull requests, agent runs — and the
// comparison is made on the ratios.
//
// Three sources, all of which already exist:
//
//   - The calls Open Code made, step by step, each with its usage, read from
//     its session database by lib/opencode-sessions.js. This is what was
//     actually paid for. collect() takes the reader as an argument, so
//     everything after the reading is tested without a database.
//   - The journal, whose timestamps decide which issue a call belongs to, and
//     whose state transitions decide which phase.
//   - The issue's records — route, tasks, slices, requirements, pull requests.
//     Read through the modules that own them, never directly.
//
// Like lib/stats.js, this reports and recommends nothing. "This cycle cost 41 M
// units per task" is a measurement; "so split the session" is a decision about
// how to work, and it is taken by somebody looking at the numbers, not by the
// command that printed them. The exit code is zero for the same reason.
//
// What it deliberately does not claim, and prints so a reader cannot miss it:
//
//   - Attribution is approximate. A call belongs to the issue of the nearest
//     earlier journal entry within ATTRIBUTION_WINDOW_MS, and a call with no
//     such entry belongs to nobody. The unattributed share is always printed:
//     a metric quiet about its own coverage is the thing the rest of this
//     plugin is written against.
//   - Changed lines are additions + deletions from the pull request's diff,
//     lockfiles and generated output included — the caveat lib/stats.js makes
//     about `quickfix.max_changed_lines`.
//   - Routes are not comparable. A quickfix and a multi-slice standard cycle
//     differ in kind, not in size, and no normalization fixes that.
//   - Before the move from Claude Code, nothing is measured. $PDKIT_HOME is
//     shared with the Claude Code version of this plugin, so the journal holds
//     work this source never saw. The newest snapshot taken from Claude Code's
//     transcripts marks where measuring starts: a call before it is not
//     counted, and an issue with work before it is printed with that line and
//     no figure per unit of work, since part of its cost is not the cost of
//     the issue. Not measured is not zero.
//   - Title and `generate` calls, and steps a revert removed, are only in the
//     session totals Open Code keeps, with no model and no time. They are not
//     counted.
//   - A compaction's tokens are measured and printed, but kept out of the
//     totals: Claude Code's transcripts never carried them, and the totals
//     stay on the scale the earlier snapshots were taken on.
//   - The weights are Anthropic's list-price ratios. A model of any other
//     provider weighs as Sonnet, and the tokens of each model are printed
//     beside the units, for whoever wants to price them otherwise.

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { issueDir, paths, resolveHome } from './config.js';
import * as gh from './gh.js';
import * as journal from './journal.js';
import * as pr from './pr.js';
import * as slice from './slice.js';
import * as state from './state.js';
import * as sessions from './opencode-sessions.js';

/**
 * Weights of one token of each kind, relative to one fresh input token.
 *
 * These are ratios of list prices within one model family — cache reads at a
 * tenth of input, cache writes (five-minute TTL) at a quarter more, output at
 * five times — and they have held across the Sonnet and Opus price lists. They
 * are NOT dollars and NOT a share of a Pro or Max limit, whose accounting is
 * not published. What they are is a stable scale: "three times cheaper" means
 * the same thing in two measurements taken months apart, which a dollar figure
 * does not once the price list moves.
 */
export const TOKEN_WEIGHTS = Object.freeze({ input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 });

/**
 * How much dearer an Opus token is than the same token on Sonnet: the ratio of
 * their list prices. Every model that is not Opus is weighted as Sonnet, Haiku
 * included — which overstates a Haiku call, and so errs against any "after"
 * that moved work there rather than in its favor.
 */
export const OPUS_MULTIPLIER = 5;

/**
 * Dollars per cost unit: one unit is one fresh Sonnet input token, listed at
 * $3 per million. Printed beside the units for orientation only. Comparisons
 * are made in units, so a price change is not mistaken for an improvement.
 */
export const USD_PER_UNIT = 3 / 1_000_000;

/**
 * How long after a journal entry a call is still taken to be about that
 * entry's issue. Six hours, as in the original analysis: long enough to cover
 * a working session between two recorded events, short enough that tomorrow
 * morning's unrelated session is not charged to yesterday's issue.
 */
export const ATTRIBUTION_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * Which phase an issue is in once a journal event of this name is recorded.
 *
 * The events are the state machine's transitions (lib/state.js). Calls before
 * an issue's first transition are its triage — but only those after its first
 * journal entry of any kind, since a call is attributed to an issue only once
 * the journal has named it.
 */
export const PHASE_AFTER = Object.freeze({
  triaged: 'plan',
  quickfix: 'quickfix',
  answered: 'answer',
  planned: 'plan-review',
  'plan-approved': 'exec',
  implemented: 'validate',
  validated: 'audit',
  audited: 'slice',
  sliced: 'slice',
  'slices-approved': 'slice',
  'preflight-green': 'pr',
  'pr-open': 'pr-sync',
  'review-in-progress': 'pr-sync',
  merged: 'after-merge',
  resolved: 'after-close',
  abandoned: 'after-close',
});

/** Phases in workflow order, for printing. */
export const PHASES = [
  'triage',
  'plan',
  'quickfix',
  'answer',
  'plan-review',
  'exec',
  'validate',
  'audit',
  'slice',
  'pr',
  'pr-sync',
  'after-merge',
  'after-close',
];

/** Whatever the issue route is called when the record does not say. */
const NO_ROUTE = 'unknown';

/**
 * The key a report names its source of calls under. A snapshot taken from
 * Claude Code's transcripts has the other one, with the directories it read;
 * the newest of those is where measuring here starts.
 */
export const SOURCE = 'opencode';
const CLAUDE_CODE_SOURCE = 'transcripts';

/** Each source as a sentence names it. */
const SOURCE_NAMES = Object.freeze({
  [SOURCE]: "Open Code's session database",
  [CLAUDE_CODE_SOURCE]: "Claude Code's transcripts",
});

/**
 * The four counters of one call, or of a sum of calls.
 *
 * @typedef {object} Usage
 * @property {number} input       fresh input tokens
 * @property {number} cacheRead
 * @property {number} cacheWrite
 * @property {number} output
 */

/**
 * One API call, as read from the source.
 *
 * @typedef {object} Call
 * @property {string} at            ISO timestamp
 * @property {string} model
 * @property {string|null} sessionId the top-level session
 * @property {string|null} agent     the subagent run's id, null for the top-level session
 * @property {Usage} usage
 */

/**
 * @param {string} model
 * @returns {boolean}
 */
export function isOpus(model) {
  return /opus/i.test(String(model ?? ''));
}

/**
 * Cost units of one call: the weighted token sum, times OPUS_MULTIPLIER on
 * Opus.
 *
 * @param {Usage} usage
 * @param {string} model
 * @returns {number}
 */
export function unitsOf(usage, model) {
  const weighted =
    usage.input * TOKEN_WEIGHTS.input +
    usage.cacheRead * TOKEN_WEIGHTS.cacheRead +
    usage.cacheWrite * TOKEN_WEIGHTS.cacheWrite +
    usage.output * TOKEN_WEIGHTS.output;
  return isOpus(model) ? weighted * OPUS_MULTIPLIER : weighted;
}

/**
 * The context a call was sent: everything that went in, cached or not.
 *
 * @param {Usage} usage
 * @returns {number}
 */
export function contextOf(usage) {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

/**
 * A lookup from an instant to the journal entry that explains it: the nearest
 * entry at or before it, if that is within the window.
 *
 * @param {Array<{at: string, issue: number|null}>} entries
 * @param {number} [windowMs]
 * @returns {(at: string) => number|null}
 */
export function attributor(entries, windowMs = ATTRIBUTION_WINDOW_MS) {
  const marks = entries
    .filter((entry) => entry.issue != null)
    .map((entry) => ({ t: Date.parse(entry.at), issue: entry.issue }))
    .filter((mark) => Number.isFinite(mark.t))
    .sort((left, right) => left.t - right.t);

  return (at) => {
    const t = Date.parse(at);
    let low = 0;
    let high = marks.length - 1;
    let best = null;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (marks[middle].t <= t) {
        best = marks[middle];
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return best && t - best.t <= windowMs ? best.issue : null;
  };
}

/**
 * A lookup from an instant to the phase one issue was in.
 *
 * @param {Array<{at: string, event: string}>} entries this issue's journal
 * @returns {(at: string) => string}
 */
export function phaser(entries) {
  const transitions = entries
    .filter((entry) => entry.event in PHASE_AFTER)
    .map((entry) => ({ t: Date.parse(entry.at), phase: PHASE_AFTER[entry.event] }))
    .sort((left, right) => left.t - right.t);

  return (at) => {
    const t = Date.parse(at);
    let phase = 'triage';
    for (const transition of transitions) {
      if (transition.t > t) break;
      phase = transition.phase;
    }
    return phase;
  };
}

/**
 * Sums over a set of calls.
 *
 * @typedef {object} Totals
 * @property {number} calls
 * @property {number} subagentCalls
 * @property {number} input
 * @property {number} cacheRead
 * @property {number} cacheWrite
 * @property {number} output
 * @property {number} units
 * @property {number} usd
 * @property {number|null} avgContext
 * @property {number|null} peakContext
 * @property {number} sessions        distinct parent sessions
 * @property {number} agentRuns       distinct subagent runs (child sessions)
 * @property {number|null} opusShare  of calls
 */

/**
 * @param {Call[]} calls
 * @returns {Totals}
 */
export function tally(calls) {
  const totals = {
    calls: calls.length,
    subagentCalls: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    units: 0,
    usd: 0,
    avgContext: null,
    peakContext: null,
    sessions: 0,
    agentRuns: 0,
    opusShare: null,
  };

  const sessions = new Set();
  const agents = new Set();
  let opus = 0;
  let context = 0;

  for (const call of calls) {
    totals.input += call.usage.input;
    totals.cacheRead += call.usage.cacheRead;
    totals.cacheWrite += call.usage.cacheWrite;
    totals.output += call.usage.output;
    totals.units += unitsOf(call.usage, call.model);

    const sent = contextOf(call.usage);
    context += sent;
    if (totals.peakContext === null || sent > totals.peakContext) totals.peakContext = sent;

    if (isOpus(call.model)) opus += 1;
    if (call.agent) {
      totals.subagentCalls += 1;
      agents.add(call.agent);
    } else if (call.sessionId) {
      sessions.add(call.sessionId);
    }
  }

  totals.usd = totals.units * USD_PER_UNIT;
  totals.sessions = sessions.size;
  totals.agentRuns = agents.size;
  if (calls.length > 0) {
    totals.avgContext = context / calls.length;
    totals.opusShare = opus / calls.length;
  }

  return totals;
}

/**
 * Tokens and units by model, dearest first.
 *
 * @param {Call[]} calls
 * @returns {Array<{model: string, calls: number, input: number, cacheRead: number, cacheWrite: number, output: number, units: number}>}
 */
export function byModel(calls) {
  /** @type {Map<string, {model: string, calls: number, input: number, cacheRead: number, cacheWrite: number, output: number, units: number}>} */
  const models = new Map();
  for (const call of calls) {
    if (!models.has(call.model)) {
      models.set(call.model, { model: call.model, calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, units: 0 });
    }
    const row = models.get(call.model);
    row.calls += 1;
    row.input += call.usage.input;
    row.cacheRead += call.usage.cacheRead;
    row.cacheWrite += call.usage.cacheWrite;
    row.output += call.usage.output;
    row.units += unitsOf(call.usage, call.model);
  }
  return [...models.values()].sort((left, right) => right.units - left.units || left.model.localeCompare(right.model));
}

/**
 * The units of a set of compactions, which carry a model and a usage as calls
 * do but are never summed with them.
 *
 * @param {Array<{model: string, usage: Usage}>} compactions
 * @returns {number}
 */
function compactionUnits(compactions) {
  return compactions.reduce((sum, mark) => sum + unitsOf(mark.usage, mark.model), 0);
}

/**
 * The size of the work, by every measure there is.
 *
 * Each is null when it cannot be known — a pull request that was never
 * registered, a diff gh could not fetch — and `unavailable` says why. Null is
 * not zero: an issue with no recorded slices did not have zero slices, and a
 * division by it is not a measurement.
 *
 * @typedef {object} Denominators
 * @property {number|null} tasks
 * @property {number|null} slices
 * @property {number|null} requirements
 * @property {number|null} changedLines   additions + deletions over its pull requests
 * @property {number|null} mergedPrs
 * @property {number|null} agentRuns      subagent runs (child sessions) attributed to the issue
 * @property {number} agentDone            `agent-done` entries in the journal
 * @property {Record<string, string>} unavailable
 */

/** The denominators, in the order they are printed. */
export const DENOMINATORS = ['tasks', 'slices', 'requirements', 'changedLines', 'mergedPrs', 'agentRuns'];

/** How each denominator reads after "per". */
const PER = {
  tasks: 'task',
  slices: 'slice',
  requirements: 'requirement',
  changedLines: 'changed line',
  mergedPrs: 'merged PR',
  agentRuns: 'agent run',
};

/**
 * Units per unit of work, for every denominator that is known and not zero.
 *
 * @param {number} units
 * @param {Partial<Denominators>} denominators
 * @returns {Record<string, number|null>}
 */
export function normalize(units, denominators) {
  /** @type {Record<string, number|null>} */
  const out = {};
  for (const key of DENOMINATORS) {
    const by = denominators[key];
    out[key] = Number.isFinite(by) && by > 0 ? units / by : null;
  }
  return out;
}

/**
 * The share of calls nothing explained.
 *
 * @param {number} unattributed
 * @param {number} total
 * @returns {number|null}
 */
export function unattributedShare(unattributed, total) {
  return total > 0 ? unattributed / total : null;
}

/**
 * Everything one issue cost, and how big it was.
 *
 * @typedef {object} IssueCost
 * @property {number} issue
 * @property {string} route
 * @property {string} state
 * @property {Totals & {compactions: number, compactionUnits: number}} totals
 * @property {Array<{phase: string, calls: number, units: number, usd: number, share: number|null}>} phases
 * @property {ReturnType<typeof byModel>} models
 * @property {string|null} measuredSince  the boundary, when the issue has work before it that was not measured
 * @property {Denominators} denominators
 * @property {Record<string, number|null>} normalised
 */

/**
 * Attribute calls and assemble the report. Pure: every source has already been
 * read, which is what lets the arithmetic be tested without a database.
 *
 * Measuring starts at the boundary, when there is one and the window opens
 * before it: a call before it is not counted, only counted up, and an issue
 * the journal shows at work before it is marked with it.
 *
 * @param {object} input
 * @param {import('./opencode-sessions.js').Scan} input.scan
 * @param {Array<{at: string, issue: number|null, event: string}>} input.entries   the whole journal
 * @param {Record<number, Omit<Denominators, 'agentRuns'|'agentDone'> & {route?: string|null, state?: string}>} input.records
 * @param {number|null} [input.issue]    only this issue
 * @param {string|null} [input.since]    only calls at or after this ISO instant
 * @param {Boundary|null} [input.boundary]  where measuring starts; see transitionBoundary
 * @param {string} [input.generatedAt]
 * @param {number} [input.windowMs]
 * @returns {Report}
 */
export function build(input) {
  const windowMs = input.windowMs ?? ATTRIBUTION_WINDOW_MS;
  const since = input.since ?? null;
  const scanned = input.scan;
  const boundary = input.boundary ?? null;
  const cut = boundary && (since === null || Date.parse(since) < Date.parse(boundary.at)) ? Date.parse(boundary.at) : null;

  const report = {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    since,
    issue: input.issue ?? null,
    attributionWindowHours: windowMs / 3_600_000,
    weights: { ...TOKEN_WEIGHTS, opusMultiplier: OPUS_MULTIPLIER, usdPerUnit: USD_PER_UNIT },
    [SOURCE]: { ...scanned.source },
    boundary: boundary ? { at: boundary.at, snapshot: boundary.snapshot, applies: cut !== null, callsBefore: 0 } : null,
    skip: null,
    coverage: null,
    issues: [],
    routes: [],
  };

  if (scanned.skip) {
    report.skip = { ...scanned.skip };
    return report;
  }

  const issueOf = attributor(input.entries, windowMs);
  const inWindow = (at) => since === null || at >= since;
  const measured = (at) => cut === null || Date.parse(at) >= cut;

  /** @type {Map<number, Call[]>} */
  const byIssue = new Map();
  const unattributed = [];
  let total = 0;

  for (const call of scanned.calls) {
    if (!inWindow(call.at)) continue;
    if (!measured(call.at)) {
      report.boundary.callsBefore += 1;
      continue;
    }
    total += 1;
    const issue = issueOf(call.at);
    if (issue === null) {
      unattributed.push(call);
      continue;
    }
    if (!byIssue.has(issue)) byIssue.set(issue, []);
    byIssue.get(issue).push(call);
  }

  const compactions = scanned.compactions.filter((mark) => inWindow(mark.at) && measured(mark.at));

  report.coverage = {
    calls: total,
    attributed: total - unattributed.length,
    unattributed: unattributed.length,
    unattributedShare: unattributedShare(unattributed.length, total),
    unattributedTotals: tally(unattributed),
    compactions: { calls: compactions.length, units: compactionUnits(compactions) },
  };

  // Every issue the journal names, so one with no calls in the window still
  // appears — as zero, which for an issue the journal knows is a fact.
  const journaled = [...new Set(input.entries.map((entry) => entry.issue).filter((issue) => issue != null))].sort(
    (left, right) => left - right,
  );
  const wanted = input.issue == null ? journaled : [input.issue];

  for (const issue of wanted) {
    const own = input.entries.filter((entry) => entry.issue === issue);
    const calls = byIssue.get(issue) ?? [];
    const phaseOf = phaser(own);
    const totals = tally(calls);
    const record = input.records[issue] ?? {};
    const partial = cut !== null && own.some((entry) => Date.parse(entry.at) < cut);

    const compacted = compactions.filter((mark) => issueOf(mark.at) === issue);

    /** @type {Map<string, Call[]>} */
    const phases = new Map();
    for (const call of calls) {
      const phase = phaseOf(call.at);
      if (!phases.has(phase)) phases.set(phase, []);
      phases.get(phase).push(call);
    }

    const denominators = {
      tasks: record.tasks ?? null,
      slices: record.slices ?? null,
      requirements: record.requirements ?? null,
      changedLines: record.changedLines ?? null,
      mergedPrs: record.mergedPrs ?? null,
      agentRuns: totals.agentRuns,
      agentDone: own.filter((entry) => entry.event === 'agent-done').length,
      unavailable: { ...(record.unavailable ?? {}) },
    };
    if (denominators.agentRuns === 0) {
      denominators.unavailable.agentRuns = 'no subagent session was attributed to this issue';
    }

    report.issues.push({
      issue,
      route: record.route ?? NO_ROUTE,
      state: record.state ?? 'unknown',
      totals: { ...totals, compactions: compacted.length, compactionUnits: compactionUnits(compacted) },
      phases: PHASES.filter((phase) => phases.has(phase)).map((phase) => {
        const part = tally(phases.get(phase));
        return {
          phase,
          calls: part.calls,
          units: part.units,
          usd: part.usd,
          share: totals.units > 0 ? part.units / totals.units : null,
        };
      }),
      models: byModel(calls),
      measuredSince: partial ? boundary.at : null,
      denominators,
      // Part of an issue's cost over all of its work is not a cost per unit
      // of work: every ratio of an issue measured only in part is unknown.
      normalised: normalize(totals.units, partial ? {} : denominators),
    });
  }

  report.routes = routes(report.issues);
  return report;
}

/**
 * Issues grouped by route, with the group's totals normalized by the group's
 * summed denominators.
 *
 * Summed, not averaged per issue: the mean of fourteen per-task ratios gives a
 * one-task issue the same say as a fourteen-task one, which is the distortion
 * normalizing was meant to remove. A denominator unknown for any issue in the
 * group is unknown for the group — a sum with a hole in it is not a total.
 * For the same reason an issue measured only since the boundary is in no
 * group: its cost has a hole in it.
 *
 * @param {IssueCost[]} issues
 * @returns {Array<{route: string, issues: number[], units: number, usd: number, calls: number, avgContext: number|null, sessionsPerIssue: number|null, opusShare: number|null, denominators: Record<string, number|null>, normalised: Record<string, number|null>}>}
 */
export function routes(issues) {
  /** @type {Map<string, IssueCost[]>} */
  const groups = new Map();
  for (const entry of issues) {
    if (entry.totals.calls === 0 || entry.measuredSince) continue;
    if (!groups.has(entry.route)) groups.set(entry.route, []);
    groups.get(entry.route).push(entry);
  }

  return [...groups.keys()].sort().map((route) => {
    const members = groups.get(route);
    const sum = (pick) => members.reduce((acc, entry) => acc + pick(entry), 0);

    const calls = sum((entry) => entry.totals.calls);
    const units = sum((entry) => entry.totals.units);
    const context = sum((entry) => (entry.totals.avgContext ?? 0) * entry.totals.calls);
    const opus = sum((entry) => (entry.totals.opusShare ?? 0) * entry.totals.calls);

    /** @type {Record<string, number|null>} */
    const denominators = {};
    for (const key of DENOMINATORS) {
      const values = members.map((entry) => entry.denominators[key]);
      denominators[key] = values.every((value) => Number.isFinite(value)) ? values.reduce((a, b) => a + b, 0) : null;
    }

    return {
      route,
      issues: members.map((entry) => entry.issue),
      calls,
      units,
      usd: units * USD_PER_UNIT,
      avgContext: calls > 0 ? context / calls : null,
      peakContext: Math.max(...members.map((entry) => entry.totals.peakContext ?? 0)),
      sessionsPerIssue: sum((entry) => entry.totals.sessions) / members.length,
      opusShare: calls > 0 ? opus / calls : null,
      denominators,
      normalised: normalize(units, denominators),
    };
  });
}

/**
 * Tasks an issue planned: the task files the plan was cut into. The record's
 * own counter is not used — older records carry it unset.
 *
 * @param {string} home
 * @param {number} issue
 * @returns {Promise<number|null>}
 */
async function countTasks(home, issue) {
  try {
    return (await readdir(join(issueDir(home, issue), 'tasks'))).filter((name) => /^T\d+\.md$/.test(name)).length;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * The denominators of one issue, from the modules that own each record.
 *
 * @param {number} issue
 * @param {{home: string, config: object, sizeOf: (number: number) => Promise<number>}} options
 * @returns {Promise<object>}
 */
async function recordOf(issue, options) {
  const { home } = options;
  /** @type {Record<string, string>} */
  const unavailable = {};

  const record = await state.read(issue, { home });
  const tasks = await countTasks(home, issue);
  if (tasks === null) unavailable.tasks = 'no tasks/ directory';

  const graph = await slice.read(issue, { home });
  const slices = graph ? graph.slices.length : null;
  if (slices === null) unavailable.slices = 'no slice graph';

  const requirements = record.requirements?.ids?.length ?? 0;

  const book = await pr.read(issue, { home });
  const prs = book?.prs ?? [];
  const mergedPrs = book ? prs.filter((entry) => entry.state === 'merged').length : null;
  if (mergedPrs === null) unavailable.mergedPrs = 'no pull request registered';

  // The diff of every pull request that stands: merged or open. A closed one
  // was replaced, and its lines are in its successor.
  let changedLines = null;
  const standing = prs.filter((entry) => entry.state !== 'closed' && !entry.supersededBy);
  if (standing.length === 0) {
    unavailable.changedLines = 'no open or merged pull request';
  } else {
    try {
      const sizes = await Promise.all(standing.map((entry) => options.sizeOf(entry.number)));
      changedLines = sizes.reduce((a, b) => a + b, 0);
    } catch (error) {
      unavailable.changedLines = `diff size not fetched: ${error.message}`;
    }
  }

  return {
    route: record.route ?? null,
    state: record.state,
    tasks,
    slices,
    requirements: requirements > 0 ? requirements : null,
    mergedPrs,
    changedLines,
    unavailable: requirements > 0 ? unavailable : { ...unavailable, requirements: 'no requirements allocated' },
  };
}

/**
 * Additions + deletions of one pull request, from GitHub.
 *
 * @param {object} config
 * @returns {(number: number) => Promise<number>}
 */
function githubSize(config) {
  return async (number) => {
    const pull = await gh.pullRequest(number, { config, fields: 'additions,deletions' });
    return (pull.additions ?? 0) + (pull.deletions ?? 0);
  };
}

/**
 * The full report.
 *
 * @typedef {ReturnType<typeof build>} Report
 */

/**
 * Where measuring starts: the instant, and the snapshot file it comes from.
 *
 * @typedef {{at: string, snapshot: string}} Boundary
 */

/**
 * Where measuring starts: when the newest snapshot read from Claude Code's
 * transcripts was taken.
 *
 * $PDKIT_HOME is the one the Claude Code version of this plugin wrote, and the
 * snapshot taken there before the move is the last thing that measured what
 * this source cannot see. The first step in Open Code's database is not the
 * boundary: sessions there can be older than the move (trials, other
 * projects in the same clone), and work in Claude Code can be newer than
 * them.
 *
 * @param {{home?: string}} [options]
 * @returns {Promise<Boundary|null>} null when no snapshot was read from Claude Code's transcripts
 */
export async function transitionBoundary(options = {}) {
  const dir = snapshotDir(options.home ?? resolveHome());
  let names;
  try {
    names = (await readdir(dir)).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  /** @type {Boundary|null} */
  let newest = null;
  for (const name of names) {
    const file = join(dir, name);
    let snapshot;
    try {
      snapshot = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      // Skipping it could move the boundary back past work that was measured
      // only there, and every figure after it would be wider than measured.
      throw new Error(
        `${file} is not a snapshot pdkit can read (${error.message}); measuring starts at the newest one ` +
          "taken from Claude Code's transcripts, and with this one unread that cannot be placed",
      );
    }
    if (!snapshot || typeof snapshot !== 'object' || !snapshot[CLAUDE_CODE_SOURCE]) continue;
    if (!Number.isFinite(Date.parse(snapshot.generatedAt))) {
      throw new Error(`${file} names no time it was taken (generatedAt), so it cannot mark where measuring starts`);
    }
    if (newest === null || Date.parse(snapshot.generatedAt) > Date.parse(newest.at)) {
      newest = { at: snapshot.generatedAt, snapshot: name };
    }
  }
  return newest;
}

/**
 * Read the sources and build the report.
 *
 * @param {object} input
 * @param {string|null} [input.db]                  Open Code's database; where Open Code keeps it by default
 * @param {string} input.repoRoot                   the clone, whose sessions are read
 * @param {object} input.config
 * @param {string} [input.home]
 * @param {number|null} [input.issue]
 * @param {string|null} [input.since]              ISO instant
 * @param {(number: number) => Promise<number>} [input.sizeOf]  a pull request's changed lines; GitHub by default
 * @param {(source: {db: string|null, repoRoot: string, config: object}) => Promise<import('./opencode-sessions.js').Scan>} [input.read]
 *   the calls; Open Code's session database by default
 * @returns {Promise<Report>}
 */
export async function collect(input) {
  const home = input.home ?? resolveHome();
  const boundary = await transitionBoundary({ home });
  const db = input.db === undefined ? sessions.databasePath() : input.db;
  const scanned = await (input.read ?? sessions.read)({ db, repoRoot: input.repoRoot, config: input.config });
  const entries = await journal.read({}, { home });

  const wanted =
    input.issue != null
      ? [input.issue]
      : [...new Set(entries.map((entry) => entry.issue).filter((issue) => issue != null))];

  /** @type {Record<number, object>} */
  const records = {};
  const options = { home, config: input.config, sizeOf: input.sizeOf ?? githubSize(input.config) };
  if (!scanned.skip) {
    for (const issue of wanted) records[issue] = await recordOf(issue, options);
  }

  return build({ scan: scanned, entries, records, issue: input.issue ?? null, since: input.since ?? null, boundary });
}

/**
 * Where snapshots are kept.
 *
 * @param {string} home
 * @returns {string}
 */
export function snapshotDir(home) {
  return join(paths(home).home, 'cost');
}

/**
 * Write the report as `$PDKIT_HOME/cost/<date>.json`, the date being the day
 * it was generated. A second snapshot on the same day replaces the first: a
 * baseline is a day's state, not a run's.
 *
 * Except one taken from Claude Code's transcripts, which is never replaced:
 * the newest of those is where measuring starts (transitionBoundary), and the
 * day it was taken is the day the move is made, when a snapshot here is the
 * likeliest. On that day this one is `<date>.opencode.json` beside it. So is
 * it beside a file that cannot be read, which may be one.
 *
 * @param {Report} report
 * @param {{home?: string}} [options]
 * @returns {Promise<string>} the path written
 */
export async function writeSnapshot(report, options = {}) {
  return writeSnapshotIn(snapshotDir(options.home ?? resolveHome()), report);
}

/**
 * Write a report as `<dir>/<date>.json`, as writeSnapshot does: over the
 * day's earlier one, unless that one was taken from Claude Code's transcripts
 * or cannot be read — then beside it, as `<date>.opencode.json`. The planning
 * report writes its own snapshots through this too, in a directory of their
 * own.
 *
 * @param {string} dir
 * @param {{generatedAt: string}} report
 * @returns {Promise<string>} the path written
 */
export async function writeSnapshotIn(dir, report) {
  await mkdir(dir, { recursive: true });
  const day = report.generatedAt.slice(0, 10);
  let file = join(dir, `${day}.json`);

  let present = null;
  try {
    present = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (present !== null) {
    let kept = true;
    try {
      kept = Boolean(JSON.parse(present)?.[CLAUDE_CODE_SOURCE]);
    } catch {
      // Not readable: not ours to replace.
    }
    if (kept) file = join(dir, `${day}.${SOURCE}.json`);
  }

  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

/**
 * Read a snapshot back: `<date>.json`, or, named `<date>.opencode`, the one
 * written beside a snapshot taken from Claude Code's transcripts that day.
 *
 * @param {string} date YYYY-MM-DD, or YYYY-MM-DD.opencode
 * @param {{home?: string}} [options]
 * @returns {Promise<Report>}
 */
export async function readSnapshot(date, options = {}) {
  const dir = snapshotDir(options.home ?? resolveHome());
  if (!new RegExp(`^\\d{4}-\\d{2}-\\d{2}(\\.${SOURCE})?$`).test(String(date))) {
    throw new Error(
      `--compare ${date}: expected the date of a snapshot (YYYY-MM-DD), or YYYY-MM-DD.${SOURCE} for the one taken ` +
        "beside a snapshot from Claude Code's transcripts that day",
    );
  }

  const file = join(dir, `${date}.json`);
  try {
    await stat(file);
  } catch {
    let taken = [];
    try {
      taken = (await readdir(dir)).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).sort();
    } catch {
      // No directory: no snapshots, which the message already says.
    }
    throw new Error(
      `no snapshot for ${date} in ${dir}` +
        (taken.length > 0 ? `; there are: ${taken.join(', ')}` : '; take one with pdkit cost --snapshot'),
    );
  }

  return JSON.parse(await readFile(file, 'utf8'));
}

/** What a comparison puts side by side, per route. */
const COMPARED = [
  ...DENOMINATORS.map((key) => ({ key: `per ${PER[key]}`, pick: (group) => group.normalised[key], kind: 'units' })),
  { key: 'avg context', pick: (group) => group.avgContext, kind: 'tokens' },
  { key: 'sessions per issue', pick: (group) => group.sessionsPerIssue, kind: 'count' },
  { key: 'opus share', pick: (group) => group.opusShare, kind: 'share' },
  {
    key: 'agent runs per task',
    pick: (group) =>
      Number.isFinite(group.denominators.tasks) && group.denominators.tasks > 0
        ? group.denominators.agentRuns / group.denominators.tasks
        : null,
    kind: 'count',
  },
];

/**
 * Which source a report read its calls from, and with which weights.
 *
 * @param {object} report
 * @returns {{source: string|null, weights: object|null}}
 */
function scaleOf(report) {
  const source = Object.keys(SOURCE_NAMES).find((key) => report?.[key] && typeof report[key] === 'object') ?? null;
  return { source, weights: report?.weights ?? null };
}

/**
 * Whether two weightings are the same, key by key.
 *
 * @param {object|null} left
 * @param {object|null} right
 * @returns {boolean}
 */
function sameWeights(left, right) {
  if (!left || !right) return false;
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])];
  return keys.every((key) => left[key] === right[key]);
}

/**
 * Put a snapshot beside the issues that came after it.
 *
 * "After" is the issues the snapshot did not contain. An issue it did contain
 * that has accrued more since is still the "before" way of working, and
 * mixing it into the "after" side would dilute exactly the change being
 * measured. Grouped by route, because routes are not comparable with each
 * other.
 *
 * Two reports read from different sources, or weighted differently, are not
 * on one scale: Claude Code's transcripts and Open Code's database count a
 * call, its output and its compactions each in their own way. The comparison
 * still puts them side by side — the move between them is what it is for —
 * and says that they are.
 *
 * @param {Report} before
 * @param {Report} now
 * @returns {{before: string, after: string, scales: {before: ReturnType<typeof scaleOf>, after: ReturnType<typeof scaleOf>, sameSource: boolean, sameWeights: boolean}, issuesBefore: number[], issuesAfter: number[], routes: Array<{route: string, rows: Array<{metric: string, kind: string, before: number|null, after: number|null, delta: number|null}>}>, unattributed: {before: number|null, after: number|null}}}
 */
export function compare(before, now) {
  const known = new Set(before.issues.map((entry) => entry.issue));
  const fresh = now.issues.filter((entry) => !known.has(entry.issue));
  const afterRoutes = routes(fresh);

  const names = [...new Set([...before.routes.map((group) => group.route), ...afterRoutes.map((group) => group.route)])].sort();
  const was = scaleOf(before);
  const is = scaleOf(now);

  return {
    before: before.generatedAt,
    after: now.generatedAt,
    scales: {
      before: was,
      after: is,
      sameSource: was.source !== null && was.source === is.source,
      sameWeights: sameWeights(was.weights, is.weights),
    },
    issuesBefore: before.routes.flatMap((group) => group.issues),
    issuesAfter: afterRoutes.flatMap((group) => group.issues),
    unattributed: {
      before: before.coverage?.unattributedShare ?? null,
      after: now.coverage?.unattributedShare ?? null,
    },
    routes: names.map((route) => {
      const left = before.routes.find((group) => group.route === route) ?? null;
      const right = afterRoutes.find((group) => group.route === route) ?? null;
      return {
        route,
        rows: COMPARED.map((metric) => {
          const was = left ? metric.pick(left) : null;
          const is = right ? metric.pick(right) : null;
          let delta = null;
          if (Number.isFinite(was) && Number.isFinite(is)) {
            // Shares move in points; everything else in percent of what it was.
            if (metric.kind === 'share') delta = is - was;
            else if (was !== 0) delta = (is - was) / was;
          }
          return { metric: metric.key, kind: metric.kind, before: was, after: is, delta };
        }),
      };
    }),
  };
}

/**
 * 573 M, 8.8 M, 491 k, 312.
 *
 * @param {number|null} value
 * @returns {string}
 */
export function human(value) {
  if (!Number.isFinite(value)) return '—';
  const size = Math.abs(value);
  if (size >= 1e9) return `${(value / 1e9).toFixed(2)} G`;
  if (size >= 1e8) return `${Math.round(value / 1e6)} M`;
  if (size >= 1e6) return `${(value / 1e6).toFixed(1)} M`;
  if (size >= 1e5) return `${Math.round(value / 1e3)} k`;
  if (size >= 1e3) return `${(value / 1e3).toFixed(1)} k`;
  if (size >= 10 || value === Math.round(value)) return String(Math.round(value));
  return value.toFixed(2);
}

/**
 * @param {number|null} share
 * @returns {string}
 */
function percent(share) {
  return Number.isFinite(share) ? `${Math.round(share * 100)} %` : '—';
}

/**
 * @param {number} usd
 * @returns {string}
 */
function dollars(usd) {
  return usd >= 10 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`;
}

/**
 * An instant as the report prints it: `2026-11-13 14:37 UTC`.
 *
 * @param {string} at ISO
 * @returns {string}
 */
function instant(at) {
  const t = new Date(at);
  return Number.isFinite(t.getTime()) ? `${t.toISOString().slice(0, 10)} ${t.toISOString().slice(11, 16)} UTC` : String(at);
}

/** The caveats every report carries. */
function caveats(report) {
  const source = report[SOURCE] ?? {};
  const lines = [
    `attribution    a call belongs to the issue of the nearest earlier journal entry within ` +
      `${report.attributionWindowHours} h; calls before an issue's first entry are not its triage`,
    'changed lines  additions + deletions of the pull requests, lockfiles and generated output included',
    'routes         not comparable with each other in any normalization; read each group on its own',
    'units          input + 0.1 cache-read + 1.25 cache-write + 5 output, x5 on Opus — Anthropic list-price ratios;',
    '               a model with no "opus" in its name, of any provider, weighs as Sonnet; not dollars and not',
    '               a plan limit; dollars are beside them for orientation only',
    `source         ${SOURCE_NAMES[SOURCE]} at ${source.db}: one call per step with tokens, output with reasoning;`,
    `               subagents are child sessions; ${source.forkCopies} message(s) a fork copied not counted again; ` +
      `${source.unfinishedSteps} step(s) without tokens, running or failed, not counted`,
    'not counted    title and generate calls, and steps a revert removed: they are only in the session totals,',
    '               with no model and no time',
    "compactions    measured and printed apart, not in the totals: Claude Code's transcripts never carried them",
  ];
  if (source.elsewhereSteps > 0) {
    lines.push(`elsewhere      ${source.elsewhereSteps} step(s) of these sessions taken outside the clone and its worktrees, not counted`);
  }
  if (source.lastMessageInputSteps > 0) {
    lines.push(
      `claude-agent   ${source.lastMessageInputSteps} step(s) carry the input and cache of their last request alone; ` +
        'a step of several requests reads low',
    );
  }
  if (report.since) {
    lines.push('window         denominators describe whole issues; the window may hold only part of their cost');
  }
  return lines.map((line) => `  ${line}`);
}

/**
 * Where measuring starts, when it starts after the window opens.
 *
 * @param {Report} report
 * @returns {string[]}
 */
function boundaryLines(report) {
  const b = report.boundary;
  if (!b?.applies) return [];
  return [
    `  measured since     ${instant(b.at)}, the newest snapshot read from Claude Code's transcripts (cost/${b.snapshot});`,
    `                     before it, outside Open Code data, not measured — ${b.callsBefore} call(s) before it not counted`,
  ];
}

/**
 * @param {IssueCost} entry
 * @returns {string[]}
 */
function issueBlock(entry) {
  const d = entry.denominators;
  const size = [
    entry.route,
    d.tasks === null ? null : `${d.tasks} task(s)`,
    d.slices === null ? null : `${d.slices} slice(s)`,
    d.requirements === null ? null : `${d.requirements} requirement(s)`,
  ]
    .filter(Boolean)
    .join(', ');

  const t = entry.totals;
  const lines = [`issue ${entry.issue}  (${size}; ${entry.state})`, ''];
  if (entry.measuredSince) {
    lines.push(`  before ${instant(entry.measuredSince)}  outside Open Code data, not measured; what follows came after`, '');
  }

  if (t.calls === 0) {
    lines.push('  no call was attributed to this issue in the window', '');
    return lines;
  }

  lines.push(
    `  API calls          ${t.calls}   (${t.subagentCalls} in subagents)`,
    `  input              ${human(t.cacheRead)} cache-read, ${human(t.cacheWrite)} cache-write, ${human(t.input)} fresh`,
    `  output             ${human(t.output)}`,
    `  cost units         ${human(t.units)}   (${dollars(t.usd)} at list price, for orientation)`,
    `  avg context        ${human(t.avgContext)}        peak ${human(t.peakContext)}`,
    `  sessions           ${t.sessions}            compactions ${t.compactions}`,
  );
  if (t.compactions > 0) {
    lines.push(`  compaction cost    ${human(t.compactionUnits)} units in ${t.compactions} call(s) — measured, not in the totals`);
  }
  lines.push(
    `  opus share         ${percent(t.opusShare)}`,
    `  agent runs         ${d.agentRuns}            (subagent sessions; journal agent-done: ${d.agentDone})`,
    '',
    '  by phase            calls   cost units    share',
  );

  for (const phase of entry.phases) {
    lines.push(
      `    ${phase.phase.padEnd(14)} ${String(phase.calls).padStart(7)}   ${human(phase.units).padStart(10)}   ${percent(phase.share).padStart(6)}`,
    );
  }

  lines.push('', `  ${'by model'.padEnd(34)} calls        fresh   cache-read  cache-write       output   cost units`);
  for (const row of entry.models) {
    lines.push(
      `    ${row.model.padEnd(32)} ${String(row.calls).padStart(5)} ${human(row.input).padStart(12)} ${human(row.cacheRead).padStart(12)} ` +
        `${human(row.cacheWrite).padStart(12)} ${human(row.output).padStart(12)} ${human(row.units).padStart(12)}`,
    );
  }

  lines.push('', '  normalized (cost units)');
  if (entry.measuredSince) {
    lines.push(`    unavailable: what it cost before ${instant(entry.measuredSince)} was not measured`, '');
    return lines;
  }
  for (const key of DENOMINATORS) {
    const value = entry.normalised[key];
    const label = `per ${PER[key]}`.padEnd(18);
    if (value === null) {
      lines.push(`    ${label} unavailable: ${d.unavailable[key] ?? `${PER[key]} count is zero`}`);
    } else {
      lines.push(`    ${label} ${human(value).padStart(10)}   (${dollars(value * USD_PER_UNIT)})`);
    }
  }

  lines.push('');
  return lines;
}

/**
 * @param {Report} report
 * @returns {string}
 */
export function format(report) {
  const scope = report.issue == null ? 'every issue in the journal' : `issue ${report.issue}`;
  const window = report.since ? ` since ${report.since}` : '';
  const lines = [`cost: ${scope}${window}`, ''];

  if (report.skip) {
    lines.push(`  skip: ${report.skip.reason}`, '');
    return lines.join('\n');
  }

  const c = report.coverage;
  const coverage =
    `attribution        ${percent(c.calls > 0 ? c.attributed / c.calls : null)} of ${c.calls} call(s) in the window ` +
    `mapped to an issue; ${c.unattributed} (${percent(c.unattributedShare)}, ${human(c.unattributedTotals.units)} units) to none`;

  const compacted =
    c.compactions.calls > 0
      ? [`  compactions        ${c.compactions.calls} in the window, ${human(c.compactions.units)} units — measured, not in the totals`]
      : [];

  if (report.issue != null) {
    for (const entry of report.issues) lines.push(...issueBlock(entry));
    lines.push(`  ${coverage}`, ...compacted, ...boundaryLines(report), '');
  } else {
    lines.push(`  ${coverage}`, ...compacted, ...boundaryLines(report), '');
    for (const group of report.routes) {
      lines.push(`route ${group.route}: ${group.issues.length} issue(s)`, '');
      lines.push('  issue     calls   cache-read   output   avg ctx   cost units   opus   per task');
      for (const issue of group.issues) {
        const entry = report.issues.find((candidate) => candidate.issue === issue);
        const t = entry.totals;
        lines.push(
          `  ${String(issue).padEnd(8)} ${String(t.calls).padStart(6)}   ${human(t.cacheRead).padStart(10)}   ` +
            `${human(t.output).padStart(6)}   ${human(t.avgContext).padStart(7)}   ${human(t.units).padStart(10)}   ` +
            `${percent(t.opusShare).padStart(4)}   ${human(entry.normalised.tasks).padStart(8)}`,
        );
      }
      lines.push('', '  group, normalized (cost units)');
      for (const key of DENOMINATORS) {
        const value = group.normalised[key];
        lines.push(
          `    per ${PER[key].padEnd(14)} ${value === null ? 'unavailable for at least one issue in the group' : `${human(value).padStart(10)}   (${dollars(value * USD_PER_UNIT)})`}`,
        );
      }
      lines.push('');
    }
    const partial = report.issues.filter((entry) => entry.measuredSince);
    if (partial.length > 0) {
      lines.push(`measured only since ${instant(report.boundary.at)}: before it outside Open Code data, not measured`, '');
      const some = partial.filter((entry) => entry.totals.calls > 0);
      if (some.length > 0) {
        lines.push('  issue     calls   cache-read   output   avg ctx   cost units   opus');
        for (const entry of some) {
          const t = entry.totals;
          lines.push(
            `  ${String(entry.issue).padEnd(8)} ${String(t.calls).padStart(6)}   ${human(t.cacheRead).padStart(10)}   ` +
              `${human(t.output).padStart(6)}   ${human(t.avgContext).padStart(7)}   ${human(t.units).padStart(10)}   ` +
              `${percent(t.opusShare).padStart(4)}`,
          );
        }
      }
      const none = partial.filter((entry) => entry.totals.calls === 0).map((entry) => entry.issue);
      if (none.length > 0) lines.push(`  no attributed call since: ${none.join(', ')}`);
      lines.push('');
    }
    const idle = report.issues.filter((entry) => entry.totals.calls === 0 && !entry.measuredSince).map((entry) => entry.issue);
    if (idle.length > 0) lines.push(`  no attributed calls: ${idle.join(', ')}`, '');
  }

  lines.push('  caveats', ...caveats(report).map((line) => `  ${line}`), '');
  return lines.join('\n');
}

/**
 * @param {ReturnType<typeof compare>} comparison
 * @returns {string}
 */
export function formatComparison(comparison) {
  const lines = [
    `cost: snapshot ${comparison.before.slice(0, 10)} against issues journaled since`,
    `  before: ${comparison.issuesBefore.join(', ') || 'none'}`,
    `  after:  ${comparison.issuesAfter.join(', ') || 'none'}`,
    '',
  ];

  const scales = comparison.scales;
  if (scales && (!scales.sameSource || !scales.sameWeights)) {
    const named = (source) => SOURCE_NAMES[source] ?? 'a source this version does not name';
    lines.push('  the scales differ:');
    if (!scales.sameSource) {
      lines.push(
        `    calls before were read from ${named(scales.before.source)}, after from ${named(scales.after.source)};`,
        '    each counts a call, its output and its compactions in its own way',
      );
    }
    if (!scales.sameWeights) {
      lines.push(`    weights before ${JSON.stringify(scales.before.weights)}, after ${JSON.stringify(scales.after.weights)}`);
    }
    lines.push('    the figures below stand side by side, not on one scale', '');
  }

  if (comparison.issuesAfter.length === 0) {
    lines.push('  no issue with attributed calls has appeared since the snapshot; there is no "after" yet', '');
  }

  const render = (value, kind) => {
    if (!Number.isFinite(value)) return '—';
    if (kind === 'share') return percent(value);
    return human(value);
  };

  for (const group of comparison.routes) {
    lines.push(`route ${group.route}`, '                          before        after      delta');
    for (const row of group.rows) {
      let delta = '';
      if (row.delta !== null) {
        delta =
          row.kind === 'share'
            ? `${row.delta >= 0 ? '+' : '−'}${Math.abs(Math.round(row.delta * 100))} pp`
            : `${row.delta >= 0 ? '+' : '−'}${Math.abs(Math.round(row.delta * 100))} %`;
      }
      lines.push(
        `  ${row.metric.padEnd(22)} ${render(row.before, row.kind).padStart(8)}   ${render(row.after, row.kind).padStart(10)}   ${delta.padStart(8)}`,
      );
    }
    lines.push('');
  }

  lines.push(
    `  unattributed share     ${percent(comparison.unattributed.before).padStart(8)}   ${percent(comparison.unattributed.after).padStart(10)}`,
    '',
    '  per-unit figures are cost units. "After" is only the issues the snapshot did',
    '  not contain; issues in both are the earlier way of working and stay "before".',
    '',
  );

  return lines.join('\n');
}
