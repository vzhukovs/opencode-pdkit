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

// `pdkit self-review`: what to review, and the record that it was reviewed —
// for a pull request, or with `--audit` for the issue's whole branch, which
// `/pd:audit` reads once before it is cut.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import { readFile } from 'node:fs/promises';

import * as audit from '../audit.js';
import { resolveHome } from '../config.js';
import { keysMatching } from '../globs.js';
import * as preflight from '../preflight/index.js';
import * as selfReview from '../self-review.js';
import * as state from '../state.js';
import { EXIT, issueFlag, printJson, repoContext, requireIssueTree } from './support.js';

export const flags = ['issue', 'slice', 'audit', 'findings', 'body', 'reason'];

export const ACTIONS = {
  target,
  record,
  show,
  continue: continueRounds,
};

/**
 * The actions that read the branch, and so are held to where the audit's
 * review may run: from the audit's states, on the issue's own tree, before the
 * branch is cut. `show` and `continue` read and write only the record.
 */
const READS_THE_BRANCH = ['target', 'record'];

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

  if (flags.audit !== undefined && flags.audit !== true) {
    process.stderr.write(`pdkit self-review ${action}: --audit takes no value — it names the issue's whole branch, which the issue number already says\n`);
    return EXIT.ERROR;
  }
  const isAudit = flags.audit === true;
  if (isAudit && slice !== undefined) {
    process.stderr.write(
      `pdkit self-review ${action}: --audit and --slice name different things: the audit reads the whole branch before it is cut, the self-review of a pull request reads one slice\n`,
    );
    return EXIT.ERROR;
  }

  const context = { action, issue, slice, audit: isAudit };
  if (isAudit && READS_THE_BRANCH.includes(action) && !(await auditMayRead(context, flags))) return EXIT.ERROR;

  return ACTIONS[action](context, flags);
}

/**
 * Whether the audit's review may read the branch here: an issue the audit
 * runs on, in one of its states, from the issue's own tree. Says why not.
 *
 * @param {{action: string, issue: number}} context
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<boolean>}
 */
async function auditMayRead(context, flags) {
  const record = await state.read(context.issue);
  const refused = (reason) => {
    process.stderr.write(`pdkit self-review ${context.action}: ${reason}\n`);
    return false;
  };

  if (record.route === 'quickfix') {
    return refused(`issue ${context.issue} is on the quickfix route, which has no audit: its one review is the self-review of its pull request (/pd:pr step 5)`);
  }
  if (!state.AUDIT_REVIEW_ELIGIBLE.includes(record.state)) {
    return refused(`issue ${context.issue} is ${record.state}; the review of the whole branch is /pd:audit's, from ${state.AUDIT_REVIEW_ELIGIBLE.join(' or ')}`);
  }

  const repo = await repoContext(flags);
  if (!repo.root) return refused(repo.problems.join('; '));
  const held = await requireIssueTree({
    issue: context.issue,
    repo,
    command: `pdkit self-review ${context.action}`,
    words: ['self-review', context.action],
    flags,
  });
  return held.ok;
}

/**
 * The base, ref and commit preflight will check, resolved the way preflight
 * resolves them. The review and the check have to agree on what was under
 * review, and the only way to be sure they do is to ask the same function.
 *
 * @param {{action: string, issue: number, slice?: number, audit?: boolean}} context
 * @param {Record<string, string|boolean>} flags
 */
async function resolveTarget(context, flags) {
  const repo = await repoContext(flags);
  if (!repo.root) return { ok: false, error: repo.problems.join('; ') };

  const prepared = await preflight.prepare({ issue: context.issue, slice: context.slice, repoRoot: repo.root });
  // Checked before the problem prepare names for a branch that is none of the
  // graph's slices: under a graph, the audit's answer is not "pass --slice".
  if (context.audit && prepared.sliceGraph) {
    return {
      ok: false,
      error:
        `issue ${context.issue} is cut into slices already, and each pull request is reviewed on its own: ` +
        `pdkit self-review target --issue ${context.issue} --slice <i> (/pd:pr step 5)`,
    };
  }
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
 * This is where a round starts, and the journal says so: a session that runs
 * the axes and fixes without recording still runs rounds. Past the limit it is
 * refused before the axes run, where the refusal is cheapest.
 *
 * With `--audit` it is the whole branch, and there is no body yet: the axes get
 * the plan and the tests each task owes instead, which is what was decided
 * before any code.
 *
 * @param {{action: string, issue: number, slice?: number, audit?: boolean}} context
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function target(context, flags) {
  const resolved = await resolveTarget(context, flags);
  if (!resolved.ok) {
    process.stderr.write(`pdkit self-review target: ${resolved.error}\n`);
    return EXIT.ERROR;
  }

  const started = await selfReview.startRound({
    issue: context.issue,
    slice: resolved.slice,
    audit: context.audit,
    sha: resolved.sha,
    config: resolved.config,
    home: resolveHome(),
  });
  if (!started.ok) {
    process.stderr.write(`pdkit self-review target: ${started.error}\n`);
    return EXIT.ERROR;
  }

  const triage = await selfReview.triageRecord(context.issue, { home: resolveHome() });
  const inputs = context.audit ? await audit.reviewInputs(context.issue, { home: resolveHome() }) : null;
  const round = started.rounds.max > 0 ? `${started.rounds.rounds} of ${started.rounds.max}` : `${started.rounds.rounds}, no limit`;
  if (flags.json) {
    printJson({
      base: resolved.base,
      ref: resolved.ref,
      sha: resolved.sha,
      slice: resolved.slice,
      files: resolved.files,
      triage: triage.exists ? triage.path : null,
      ...(inputs ? { plan: inputs.plan.exists ? inputs.plan.path : null, tests: inputs.tests } : {}),
      rounds: started.rounds,
    });
  } else {
    const scope = context.audit ? 'this branch' : 'this pull request';
    process.stdout.write(`diff:   git diff ${resolved.base}...${resolved.ref}\n`);
    process.stdout.write(`commit: ${resolved.sha}\n`);
    process.stdout.write(`files:  ${resolved.files.length}\n${resolved.files.map((file) => `  ${file}`).join('\n')}\n`);
    process.stdout.write(
      triage.exists
        ? `triage: ${triage.path} — the scope ${scope} was cut to; the axes and the synthesis judge against it, not the issue on GitHub\n`
        : `triage: none recorded (${triage.path}) — the axes have the issue on GitHub alone\n`,
    );
    if (inputs) process.stdout.write(`${planLine(inputs)}\n${testsLine(inputs)}\n`);
    process.stdout.write(`round:  ${round} since the last clean review\n`);
  }
  return EXIT.OK;
}

/**
 * @param {Awaited<ReturnType<typeof audit.reviewInputs>>} inputs
 * @returns {string}
 */
function planLine(inputs) {
  return inputs.plan.exists
    ? `plan:   ${inputs.plan.path} — the requirements, each task's intent and the frozen interfaces: what was decided before any code`
    : `plan:   none (${inputs.plan.path}) — the axes have the triage record alone for what was decided`;
}

/**
 * The tests the branch owes, a count per task, and where the rows are.
 *
 * @param {Awaited<ReturnType<typeof audit.reviewInputs>>} inputs
 * @returns {string}
 */
function testsLine(inputs) {
  if (inputs.tests.predates) return 'tests:  none listed — the plan predates ## Tests; the tests axis judges by section 2 alone';
  if (inputs.tests.tasks.length === 0) return 'tests:  no task owns code';

  const counts = inputs.tests.tasks.map((task) => `${task.id} ${task.cases === 0 ? 'none' : `${task.cases} case(s)`}`).join(', ');
  const where = inputs.tests.tasks.some((task) => task.file) ? `## Tests of the task files beside ${inputs.plan.path}` : `the tasks' blocks in ${inputs.plan.path}`;
  return `tests:  ${counts} — ${where}; a row is a test the branch owes`;
}

/**
 * Record what the synthesis returned, against the commit preflight will check
 * and the body about to be published.
 *
 * The commit is resolved here, never passed in: a review recorded against a
 * sha somebody typed would prove whatever they typed.
 *
 * With `--audit` there is no body: the record is of the whole branch, and the
 * move to `audited` reads it.
 *
 * @param {{action: string, issue: number, slice?: number, audit?: boolean}} context
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function record(context, flags) {
  if (typeof flags.findings !== 'string' || (!context.audit && typeof flags.body !== 'string')) {
    process.stderr.write(`pdkit self-review record: --findings <file.json>${context.audit ? ' is' : ' and --body <file> are'} required\n`);
    return EXIT.ERROR;
  }

  let given;
  let body;
  try {
    given = JSON.parse(await readFile(flags.findings, 'utf8'));
    body = typeof flags.body === 'string' ? await readFile(flags.body, 'utf8') : undefined;
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
    audit: context.audit,
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
    const owner = await ownerOf(context.issue);
    process.stdout.write(`recorded for ${resolved.sha.slice(0, 8)}: ${result.entry.findings.length} finding(s), ${result.unresolved.length} open\n`);
    for (const finding of result.unresolved) process.stdout.write(`  ${where(finding)}${finding.label}: ${finding.text}${owner(finding)}\n`);
    if (nits.length > 0) {
      const held = context.audit ? 'the audit' : 'the push';
      process.stdout.write(`  ${nits.length} nit(s) left, which do not hold ${held} — \`pdkit self-review show${context.audit ? ' --audit' : ''}\` lists them\n`);
    }
    if (result.unresolved.length > 0) {
      process.stdout.write(
        context.audit
          ? '\nThe move to audited is refused while the branch stands on this commit: fix each in the task that owns its file (/pd:audit step 4).\n'
          : '\nThe self-review preflight check stays red until a review of a later commit finds none of these.\n',
      );
      process.stdout.write(roundLine({ issue: context.issue, slice: resolved.slice, audit: context.audit }, result.rounds));
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
 * Which task owns a finding's file, as the record's ownership map says, for
 * an issue that has one: the task a fix starts under, or none — a finding
 * about the plan, since no task may write the file. An issue with no map, the
 * quickfix route's, names none.
 *
 * @param {number} issue
 * @returns {Promise<(finding: import('../self-review.js').Finding) => string>}
 */
async function ownerOf(issue) {
  const owns = (await state.read(issue)).owns ?? {};
  if (Object.keys(owns).length === 0) return () => '';
  return (finding) => {
    if (!finding.path) return '';
    const owners = keysMatching(finding.path, owns);
    return owners.length > 0 ? ` → ${owners.join(', ')}` : ' → no live task owns it: a finding about the plan';
  };
}

/**
 * Where the count of rounds stands after a review that left something open.
 *
 * @param {{issue: number, slice?: number|null, audit?: boolean}} input
 * @param {import('../self-review.js').Rounds} state
 * @returns {string}
 */
function roundLine(input, state) {
  if (state.max <= 0) return `This was round ${state.rounds}; review.self_review_rounds sets no limit.\n`;
  if (!state.blocked) return `This was round ${state.rounds} of ${state.max} on this ${input.audit ? 'branch' : 'pull request'}.\n`;
  return `\nThat was the last round before a person decides: ${selfReview.limitMessage(input, state)}\n`;
}

/**
 * The recorded entry for this pull request, or with `--audit` for the branch.
 *
 * @param {{action: string, issue: number, slice?: number, audit?: boolean}} context
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function show(context, flags) {
  const entry = selfReview.entryFor(await selfReview.read(context.issue, { home: resolveHome() }), context.slice, context.audit);

  if (entry === null) {
    if (flags.json) printJson(null);
    else process.stdout.write(context.audit ? 'no review of the whole branch recorded for this issue\n' : 'no self-review recorded for this pull request\n');
    return EXIT.OK;
  }

  const open = selfReview.unresolved(entry);
  const counted = await selfReview.rounds({
    issue: context.issue,
    slice: context.slice,
    audit: context.audit,
    config: (await repoContext(flags)).config,
    home: resolveHome(),
  });

  if (flags.json) printJson({ ...entry, unresolved: open, rounds: counted });
  else {
    const owner = await ownerOf(context.issue);
    process.stdout.write(`${entry.sha.slice(0, 8)}, ${entry.recordedAt}: ${entry.findings.length} finding(s), ${open.length} open\n`);
    for (const finding of entry.findings) {
      const named = open.includes(finding) ? owner(finding) : '';
      process.stdout.write(
        `  [${stateOf(finding, open)}] ${finding.path ?? ''}${finding.line ? `:${finding.line}` : ''} ${finding.label}: ${finding.text}${named}\n`,
      );
    }
    const limit = counted.max > 0 ? ` of ${counted.max}` : ', no limit';
    process.stdout.write(`rounds since the last clean review: ${counted.rounds}${limit}${counted.blocked ? ' — a review of another commit waits for a person' : ''}\n`);
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
 * Let the self-review of a pull request, or with `--audit` the audit's review
 * of the branch, go past its round limit, with the person's reason. Written by
 * whoever decided — the skill stops and asks.
 *
 * @param {{action: string, issue: number, slice?: number, audit?: boolean}} context
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function continueRounds(context, flags) {
  const result = await selfReview.continueRounds({
    issue: context.issue,
    slice: context.slice,
    audit: context.audit,
    reason: typeof flags.reason === 'string' ? flags.reason : '',
    home: resolveHome(),
  });

  if (!result.ok) {
    process.stderr.write(`pdkit self-review continue: ${result.error}\n`);
    return EXIT.ERROR;
  }

  if (context.audit) {
    process.stdout.write(`the review of issue ${context.issue}'s whole branch may run again; the count of rounds starts over\n`);
    return EXIT.OK;
  }
  const which = Number.isInteger(context.slice) ? `slice ${context.slice} of issue ${context.issue}` : `issue ${context.issue}`;
  process.stdout.write(`the self-review of ${which} may run again; the count of rounds starts over\n`);
  return EXIT.OK;
}
