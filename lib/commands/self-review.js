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

// `pdkit self-review`: what to review, and the record that it was reviewed.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import { readFile } from 'node:fs/promises';

import { resolveHome } from '../config.js';
import * as preflight from '../preflight/index.js';
import * as selfReview from '../self-review.js';
import { EXIT, issueFlag, printJson, repoContext } from './support.js';

export const flags = ['issue', 'slice', 'findings', 'body', 'reason'];

export const ACTIONS = {
  target,
  record,
  show,
  continue: continueRounds,
};

/**
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const action = args[0] ?? '';

  if (!Object.hasOwn(ACTIONS, action)) {
    process.stderr.write(`pdkit self-review: unknown action "${action}" (${Object.keys(ACTIONS).join(', ')})\n`);
    return EXIT.ERROR;
  }

  const issue = issueFlag(flags);
  if (!Number.isInteger(issue)) {
    process.stderr.write(`pdkit self-review ${action}: --issue <n> is required\n`);
    return EXIT.ERROR;
  }

  const slice = flags.slice === undefined ? undefined : Number.parseInt(String(flags.slice), 10);
  if (slice !== undefined && !Number.isInteger(slice)) {
    process.stderr.write(`pdkit self-review ${action}: --slice takes a number\n`);
    return EXIT.ERROR;
  }

  return ACTIONS[action]({ action, issue, slice }, flags);
}

/**
 * The base, ref and commit preflight will check, resolved the way preflight
 * resolves them. The review and the check have to agree on what was under
 * review, and the only way to be sure they do is to ask the same function.
 *
 * @param {{action: string, issue: number, slice?: number}} context
 * @param {Record<string, string|boolean>} flags
 */
async function resolveTarget(context, flags) {
  const repo = await repoContext(flags);
  if (!repo.root) return { ok: false, error: repo.problems.join('; ') };

  const prepared = await preflight.prepare({ issue: context.issue, slice: context.slice, repoRoot: repo.root });
  if (prepared.problem) return { ok: false, error: prepared.problem };
  if (prepared.headSha === null) return { ok: false, error: `${prepared.ref} does not resolve to a commit` };

  return {
    ok: true,
    base: prepared.base,
    ref: prepared.ref,
    sha: prepared.headSha,
    slice: prepared.slice,
    files: prepared.changedFiles,
    config: repo.config,
  };
}

/**
 * What the axes read: `git diff <base>...<ref>`, at this commit.
 *
 * Refused past the round limit, before the axes run: this is where a round
 * starts, and the refusal is cheapest here.
 *
 * @param {{action: string, issue: number, slice?: number}} context
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function target(context, flags) {
  const resolved = await resolveTarget(context, flags);
  if (!resolved.ok) {
    process.stderr.write(`pdkit self-review target: ${resolved.error}\n`);
    return EXIT.ERROR;
  }

  const counted = await selfReview.rounds({ issue: context.issue, slice: resolved.slice, config: resolved.config, home: resolveHome() });
  if (selfReview.pastLimit(counted, resolved.sha)) {
    process.stderr.write(`pdkit self-review target: ${selfReview.limitMessage({ issue: context.issue, slice: resolved.slice }, counted)}\n`);
    return EXIT.ERROR;
  }

  if (flags.json) printJson({ base: resolved.base, ref: resolved.ref, sha: resolved.sha, slice: resolved.slice, files: resolved.files });
  else {
    process.stdout.write(`diff:   git diff ${resolved.base}...${resolved.ref}\n`);
    process.stdout.write(`commit: ${resolved.sha}\n`);
    process.stdout.write(`files:  ${resolved.files.length}\n${resolved.files.map((file) => `  ${file}`).join('\n')}\n`);
  }
  return EXIT.OK;
}

/**
 * Record what the synthesis returned, against the commit preflight will check
 * and the body about to be published.
 *
 * The commit is resolved here, never passed in: a review recorded against a
 * sha somebody typed would prove whatever they typed.
 *
 * @param {{action: string, issue: number, slice?: number}} context
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function record(context, flags) {
  if (typeof flags.findings !== 'string' || typeof flags.body !== 'string') {
    process.stderr.write('pdkit self-review record: --findings <file.json> and --body <file> are required\n');
    return EXIT.ERROR;
  }

  let given;
  let body;
  try {
    given = JSON.parse(await readFile(flags.findings, 'utf8'));
    body = await readFile(flags.body, 'utf8');
  } catch (error) {
    process.stderr.write(`pdkit self-review record: ${error.message}\n`);
    return EXIT.ERROR;
  }

  const resolved = await resolveTarget(context, flags);
  if (!resolved.ok) {
    process.stderr.write(`pdkit self-review record: ${resolved.error}\n`);
    return EXIT.ERROR;
  }

  const result = await selfReview.record({
    issue: context.issue,
    slice: resolved.slice,
    sha: resolved.sha,
    body,
    axes: given?.axes,
    findings: given?.findings,
    config: resolved.config,
    home: resolveHome(),
  });

  if (!result.ok) {
    process.stderr.write(`pdkit self-review record: ${result.error}\n`);
    return EXIT.ERROR;
  }

  const nits = result.entry.findings.filter((finding) => finding.label === 'nit');
  if (flags.json) {
    printJson({ sha: resolved.sha, findings: result.entry.findings.length, unresolved: result.unresolved, nits: nits.length, rounds: result.rounds });
  } else {
    process.stdout.write(`recorded for ${resolved.sha.slice(0, 8)}: ${result.entry.findings.length} finding(s), ${result.unresolved.length} open\n`);
    for (const finding of result.unresolved) process.stdout.write(`  ${where(finding)}${finding.label}: ${finding.text}\n`);
    if (nits.length > 0) {
      process.stdout.write(`  ${nits.length} nit(s) left, which do not hold the push — \`pdkit self-review show\` lists them\n`);
    }
    if (result.unresolved.length > 0) {
      process.stdout.write('\nThe self-review preflight check stays red until a review of a later commit finds none of these.\n');
      process.stdout.write(roundLine({ issue: context.issue, slice: resolved.slice }, result.rounds));
    }
  }

  // Recording is a success whatever was found: the record is true either way,
  // and the check is where open findings stop the push.
  return EXIT.OK;
}

/**
 * @param {import('../self-review.js').Finding} finding
 * @returns {string}
 */
const where = (finding) => (finding.path ? `${finding.path}${finding.line ? `:${finding.line}` : ''} — ` : '');

/**
 * Where the count of rounds stands after a review that left something open.
 *
 * @param {{issue: number, slice?: number|null}} input
 * @param {import('../self-review.js').Rounds} state
 * @returns {string}
 */
function roundLine(input, state) {
  if (state.max <= 0) return `This is round ${state.rounds} with something open; review.self_review_rounds sets no limit.\n`;
  if (!state.blocked) return `This is round ${state.rounds} of ${state.max} with something open on this pull request.\n`;
  return `\nThat was the last round before a person decides: ${selfReview.limitMessage(input, state)}\n`;
}

/**
 * The recorded entry for this pull request.
 *
 * @param {{action: string, issue: number, slice?: number}} context
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function show(context, flags) {
  const entry = selfReview.entryFor(await selfReview.read(context.issue, { home: resolveHome() }), context.slice);

  if (entry === null) {
    if (flags.json) printJson(null);
    else process.stdout.write('no self-review recorded for this pull request\n');
    return EXIT.OK;
  }

  const open = selfReview.unresolved(entry);
  const counted = await selfReview.rounds({
    issue: context.issue,
    slice: context.slice,
    config: (await repoContext(flags)).config,
    home: resolveHome(),
  });

  if (flags.json) printJson({ ...entry, unresolved: open, rounds: counted });
  else {
    process.stdout.write(`${entry.sha.slice(0, 8)}, ${entry.recordedAt}: ${entry.findings.length} finding(s), ${open.length} open\n`);
    for (const finding of entry.findings) {
      process.stdout.write(`  [${stateOf(finding, open)}] ${finding.path ?? ''}${finding.line ? `:${finding.line}` : ''} ${finding.label}: ${finding.text}\n`);
    }
    const limit = counted.max > 0 ? ` of ${counted.max}` : ', no limit';
    process.stdout.write(`rounds with something open: ${counted.rounds}${limit}${counted.blocked ? ' — a review of another commit waits for a person' : ''}\n`);
  }
  return EXIT.OK;
}

/**
 * What a finding is to the push: open holds it; the rest were found and stay
 * in the record.
 *
 * @param {import('../self-review.js').Finding} finding
 * @param {import('../self-review.js').Finding[]} open
 * @returns {string}
 */
function stateOf(finding, open) {
  if (open.includes(finding)) return 'open';
  if (finding.label === 'question') return 'answered';
  return finding.preExisting ? 'pre-existing' : 'not blocking';
}

/**
 * Let the self-review of a pull request go past its round limit, with the
 * person's reason. Written by whoever decided — the skill stops and asks.
 *
 * @param {{action: string, issue: number, slice?: number}} context
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function continueRounds(context, flags) {
  const result = await selfReview.continueRounds({
    issue: context.issue,
    slice: context.slice,
    reason: typeof flags.reason === 'string' ? flags.reason : '',
    home: resolveHome(),
  });

  if (!result.ok) {
    process.stderr.write(`pdkit self-review continue: ${result.error}\n`);
    return EXIT.ERROR;
  }

  const which = Number.isInteger(context.slice) ? `slice ${context.slice} of issue ${context.issue}` : `issue ${context.issue}`;
  process.stdout.write(`the self-review of ${which} may run again; the count of rounds starts over\n`);
  return EXIT.OK;
}
