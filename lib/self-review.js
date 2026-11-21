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

// The self-review record: what the four review axes found on our own pull
// request, for which commit and which body.
//
// INVARIANT: this module is the only writer of
// $PDKIT_HOME/issues/<n>/self-review.json.
//
// Upstream's review agent reads every pull request against the maintainer's
// rules. The self-review is the same reading done by us first, and this
// record is how the `self-review` preflight check knows it happened on what is
// about to be published: the commit and the body are part of the entry, so a
// review of an earlier commit or an earlier body proves nothing about this one.
//
// It holds facts. Which findings are still open is derived from the labels by
// `unresolved`, the way validation derives a step's status from its evidence.
// There is no input through which "the review is clean" can be typed.
//
// The rounds are counted too, from the journal: a round starts when
// `self-review target` hands the axes a commit, and a review that keeps
// finding something to fix on each new commit stops after
// `review.self_review_rounds` of them; the next round waits for a sentence
// from a person — the mechanism lib/attempts.js gives a task that keeps
// failing.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { get, issueDir, resolveHome } from './config.js';
import { append as appendJournal, read as readJournal, sinceLastReset } from './journal.js';

/**
 * The four axes of /pd:review-pr. All four, because upstream's agent walks
 * every section of the rules, and an axis left out is a section nobody read.
 */
export const AXES = ['architecture', 'api-compat', 'tests', 'product'];

/** Semantic Code Reviews labels, as upstream's procedure uses them. */
export const LABELS = ['issue', 'nit', 'question'];

/**
 * One finding, as the synthesis returned it.
 *
 * @typedef {object} Finding
 * @property {'issue'|'nit'|'question'} label
 * @property {string} text
 * @property {string|null} path
 * @property {number|null} line
 * @property {number|null} section       of maintainer-rules.md; null when outside the rule set
 * @property {boolean} preExisting       the violation was in the file before this branch
 * @property {string|null} answer        for a question: how the pull request answers it
 */

/**
 * @typedef {object} Entry
 * @property {string} sha                the commit the axes read
 * @property {string} bodyDigest         sha256 of the normalized PR body they read
 * @property {string[]} axes
 * @property {Finding[]} findings
 * @property {string} recordedAt
 */

/**
 * @param {string} home
 * @param {number} issue
 */
const recordPath = (home, issue) => join(issueDir(home, issue), 'self-review.json');

/**
 * Which pull request of the issue an entry is for.
 *
 * @param {number|null|undefined} slice
 */
export const keyOf = (slice) => (Number.isInteger(slice) ? `slice-${slice}` : 'single');

/**
 * The digest of a PR body, insensitive to what GitHub does to line endings
 * and trailing whitespace on the way in and out.
 *
 * @param {string} body
 * @returns {string}
 */
export function bodyDigest(body) {
  const normalized = body.replace(/\r\n/g, '\n').trim();
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * The findings that still stand between this pull request and publishing:
 * what upstream's agent rejects a pull request for, and nothing stricter.
 *
 * - every `issue:`: upstream's verdict table rejects on one;
 * - every `question:` with no answer. A question is a rule the reviewer
 *   suspects; the pull request has to say why it holds.
 *
 * A `nit:` is not here, on new code or old. Upstream's agent accepts a pull
 * request with nits, and a gate stricter than the reviewer it imitates did not
 * converge: fresh axes found nits in every round, many of them on the code
 * written to answer the round before, so "fix every nit and review again" had
 * no last round. The nit stays in the record, the check counts it, and the
 * person sees it before the push.
 *
 * @param {Entry} entry
 * @returns {Finding[]}
 */
export function unresolved(entry) {
  return entry.findings.filter((finding) => finding.label === 'issue' || (finding.label === 'question' && !finding.answer));
}

/** Journal events this module writes. */
export const EVENTS = {
  started: 'self-review-target',
  recorded: 'self-review',
  continued: 'self-review-continued',
};

/**
 * How many commits in a row a review may leave something open on before the
 * next round waits for a person, when the configuration says nothing.
 *
 * Three, as `exec.max_attempts`. A first round with findings is ordinary, a
 * second is a hint, and a third that still finds something to fix means the
 * loop is not converging: the axes read with fresh eyes every round, and the
 * code written to answer one round is what the next one finds fault with.
 */
export const DEFAULT_ROUNDS = 3;

/**
 * The configured limit. Zero or less switches it off.
 *
 * @param {object} [config]
 * @returns {number}
 */
export function roundLimit(config) {
  const configured = get(config ?? {}, 'review.self_review_rounds');
  return configured === undefined || configured === null ? DEFAULT_ROUNDS : Number(configured);
}

/**
 * What a `self-review` journal entry says, as `record` writes it. Parsed here,
 * next to the writer, so the convention is one module's and a test pins it.
 *
 * @param {string} detail
 * @returns {{commit: string, findings: number, open: number}|null}
 */
export function parseRecorded(detail) {
  const match = /^([0-9a-f]{8}): (\d+) finding\(s\), (\d+) unresolved$/.exec(String(detail ?? '').trim());
  return match ? { commit: match[1], findings: Number(match[2]), open: Number(match[3]) } : null;
}

/**
 * The commit a `self-review-target` entry started a round on, as `startRound`
 * writes it.
 *
 * @param {string} detail
 * @returns {string|null}
 */
export function parseStarted(detail) {
  const match = /^([0-9a-f]{8})$/.exec(String(detail ?? '').trim());
  return match ? match[1] : null;
}

/**
 * @typedef {object} Rounds
 * @property {number} rounds          commits a round started or left something open on, since the count restarted
 * @property {number} max             zero or less means no limit
 * @property {boolean} blocked        the limit is reached: a review of another commit waits for a person
 * @property {string[]} commits       those commits, short
 * @property {string|null} since      when the count restarted, if it did
 */

/**
 * How many commits in a row the self-review of one pull request has been run
 * on without a review that left nothing open.
 *
 * Counted from the journal rather than stored, as lib/attempts.js counts a
 * task's failures: the journal already says what happened, and a stored
 * counter would be a second source of truth. A round is a commit, not a
 * record — reading the same commit again, recording it again with an answer to
 * a question or after the review read a corrected body, is the same round. It
 * counts from `startRound`, which `self-review target` calls before the axes
 * run, as well as from a record: a session that reviews and fixes without ever
 * recording still runs rounds, and they cost the same. The count starts over
 * at a review that left nothing open, at a person's sentence
 * (`continueRounds`), and when the issue was started over (`pdkit reset`).
 *
 * @param {{issue: number, slice?: number|null, config?: object, home?: string}} input
 * @returns {Promise<Rounds>}
 */
export async function rounds(input) {
  const slice = Number.isInteger(input.slice) ? input.slice : null;
  const entries = sinceLastReset(await readJournal({ issue: input.issue }, { home: input.home }));
  const mine = entries.filter((entry) => entry.slice === slice && Object.values(EVENTS).includes(entry.event));

  /** @type {string[]} */
  const commits = [];
  let since = null;
  for (let i = mine.length - 1; i >= 0; i -= 1) {
    const entry = mine[i];
    const recorded = entry.event === EVENTS.recorded ? parseRecorded(entry.detail) : null;
    if (entry.event === EVENTS.continued || recorded?.open === 0) {
      since = entry.at;
      break;
    }
    const commit = recorded?.commit ?? (entry.event === EVENTS.started ? parseStarted(entry.detail) : null);
    if (commit && !commits.includes(commit)) commits.unshift(commit);
  }

  const max = roundLimit(input.config);
  return { rounds: commits.length, max, blocked: max > 0 && commits.length >= max, commits, since };
}

/**
 * Whether a review of `sha` is a round past the limit. The commits already
 * counted are not: answering a question on one of them is the same round.
 *
 * @param {Rounds} state
 * @param {string} sha
 * @returns {boolean}
 */
export function pastLimit(state, sha) {
  return state.blocked && !state.commits.includes(sha.slice(0, 8));
}

/**
 * The refusal at the limit, and the way past it.
 *
 * @param {{issue: number, slice?: number|null}} input
 * @param {Rounds} state
 * @returns {string}
 */
export function limitMessage(input, state) {
  const slice = Number.isInteger(input.slice) ? ` --slice ${input.slice}` : '';
  return (
    `the self-review ran on ${state.rounds} commits in a row (${state.commits.join(', ')}) without a clean review, one that leaves nothing open, ` +
    `and the limit is ${state.max} (review.self_review_rounds).\n` +
    '  Another round costs what the last one did, and the code written to answer a round is what the next one\n' +
    '  finds fault with. Stop and ask the person: show what is still open and how the diff grew since the first\n' +
    '  round, and let them decide whether to go on, to escalate a quickfix, or to stop here.\n' +
    `  When they decide to go on: pdkit self-review continue --issue ${input.issue}${slice} --reason "<what is different this time>"`
  );
}

/**
 * Start a round of the self-review on `sha`: what `self-review target` does
 * before it hands the axes the diff. Refused past the limit, before anything
 * is written, so the axes do not run on a commit nobody decided to review.
 *
 * @param {{issue: number, slice?: number|null, sha: string, config?: object, home?: string}} input
 * @returns {Promise<{ok: true, rounds: Rounds} | {ok: false, error: string, rounds: Rounds}>}
 */
export async function startRound(input) {
  const counted = { issue: input.issue, slice: input.slice, config: input.config, home: input.home };
  const before = await rounds(counted);
  if (pastLimit(before, input.sha)) return { ok: false, error: limitMessage(input, before), rounds: before };

  await appendJournal(
    { issue: input.issue, slice: Number.isInteger(input.slice) ? input.slice : null, event: EVENTS.started, detail: input.sha.slice(0, 8) },
    { home: input.home },
  );
  return { ok: true, rounds: await rounds(counted) };
}

/**
 * Let the self-review of a pull request go past its limit.
 *
 * The reason is required and has no default, for the reason `task unblock`
 * requires one: the count starts over at this line, and it is the only record
 * of why anyone expected the next round to find less.
 *
 * @param {{issue: number, slice?: number|null, reason: string, home?: string}} input
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
export async function continueRounds(input) {
  const reason = String(input.reason ?? '').trim();
  if (reason === '') {
    return {
      ok: false,
      error: '--reason "<what is different this time>" is required: the count starts over here, and this line is the only record of why',
    };
  }

  await appendJournal(
    { issue: input.issue, slice: Number.isInteger(input.slice) ? input.slice : null, event: EVENTS.continued, detail: reason },
    { home: input.home },
  );
  return { ok: true };
}

/**
 * Validate and normalize what the synthesis returned.
 *
 * @param {unknown} given
 * @returns {{ok: true, findings: Finding[]} | {ok: false, error: string}}
 */
export function parseFindings(given) {
  if (!Array.isArray(given)) return { ok: false, error: '`findings` must be a list (an empty one when nothing was found)' };

  const findings = [];
  for (const [index, raw] of given.entries()) {
    const at = `finding ${index + 1}`;
    if (raw === null || typeof raw !== 'object') return { ok: false, error: `${at} is not an object` };
    if (!LABELS.includes(raw.label)) return { ok: false, error: `${at}: label must be one of ${LABELS.join(', ')}` };
    if (typeof raw.text !== 'string' || raw.text.trim() === '') return { ok: false, error: `${at}: text is required` };

    const section = raw.section ?? null;
    if (section !== null && !(Number.isInteger(section) && section >= 1 && section <= 12)) {
      return { ok: false, error: `${at}: section is a number from 1 to 12, or null for a finding outside the rule set` };
    }

    const line = raw.line ?? null;
    if (line !== null && !(Number.isInteger(line) && line > 0)) return { ok: false, error: `${at}: line is a positive integer` };

    findings.push({
      label: raw.label,
      text: raw.text.trim(),
      path: typeof raw.path === 'string' && raw.path !== '' ? raw.path : null,
      line,
      section,
      preExisting: raw.preExisting === true,
      answer: typeof raw.answer === 'string' && raw.answer.trim() !== '' ? raw.answer.trim() : null,
    });
  }

  return { ok: true, findings };
}

/**
 * Read the record for an issue.
 *
 * @param {number} issue
 * @param {{home?: string}} [options]
 * @returns {Promise<{issue: number, entries: Record<string, Entry>}|null>} null when no self-review ran
 */
export async function read(issue, options = {}) {
  const home = options.home ?? resolveHome();

  let raw;
  try {
    raw = await readFile(recordPath(home, issue), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  try {
    const parsed = JSON.parse(raw);
    return { issue, entries: parsed.entries ?? {} };
  } catch (error) {
    throw new Error(`${recordPath(home, issue)}: the self-review record is not readable JSON`, { cause: error });
  }
}

/**
 * The entry for one pull request of the issue, or null.
 *
 * @param {{entries: Record<string, Entry>}|null} record
 * @param {number|null|undefined} slice
 * @returns {Entry|null}
 */
export function entryFor(record, slice) {
  return record?.entries[keyOf(slice)] ?? null;
}

/**
 * Record a self-review. Replaces the previous entry for the same pull request:
 * a review of an older commit says nothing about this one, so keeping it would
 * only give the check something stale to read.
 *
 * A review of a new commit past the round limit is refused, and nothing is
 * written: that round should not have run, and `self-review target` already
 * said so.
 *
 * @param {{issue: number, slice?: number|null, sha: string, body: string, axes: unknown, findings: unknown, config?: object, home?: string}} input
 * @returns {Promise<{ok: true, entry: Entry, unresolved: Finding[], rounds: Rounds} | {ok: false, error: string, rounds?: Rounds}>}
 */
export async function record(input) {
  const home = input.home ?? resolveHome();

  if (typeof input.sha !== 'string' || !/^[0-9a-f]{40}$/.test(input.sha)) return { ok: false, error: 'the commit under review is not a full sha' };
  if (typeof input.body !== 'string' || input.body.trim() === '') {
    return { ok: false, error: 'the PR body is empty: the self-review reads the title and body before the code, as upstream does' };
  }

  const axes = Array.isArray(input.axes) ? input.axes : [];
  const missing = AXES.filter((axis) => !axes.includes(axis));
  if (missing.length > 0) return { ok: false, error: `axes not run: ${missing.join(', ')}. All four read the diff, or the review is a partial one` };

  const parsed = parseFindings(input.findings);
  if (!parsed.ok) return parsed;

  const counted = { issue: input.issue, slice: input.slice, config: input.config, home };
  const before = await rounds(counted);
  if (pastLimit(before, input.sha)) return { ok: false, error: limitMessage(input, before), rounds: before };

  /** @type {Entry} */
  const entry = {
    sha: input.sha,
    bodyDigest: bodyDigest(input.body),
    axes: [...AXES],
    findings: parsed.findings,
    recordedAt: new Date().toISOString(),
  };

  const current = (await read(input.issue, { home })) ?? { issue: input.issue, entries: {} };
  const next = { issue: input.issue, entries: { ...current.entries, [keyOf(input.slice)]: entry } };

  const file = recordPath(home, input.issue);
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`);
  await rename(temporary, file);

  const open = unresolved(entry);
  await appendJournal(
    {
      issue: input.issue,
      slice: Number.isInteger(input.slice) ? input.slice : null,
      event: EVENTS.recorded,
      detail: `${input.sha.slice(0, 8)}: ${entry.findings.length} finding(s), ${open.length} unresolved`,
    },
    { home },
  );

  return { ok: true, entry, unresolved: open, rounds: await rounds(counted) };
}
