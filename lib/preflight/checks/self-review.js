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

// Preflight check: self-review
//
// Upstream's review agent reads every pull request against the maintainer's
// rules, title and body first, then every changed file. /pd:pr runs the same
// reading on our side first: the four review axes and the synthesis, on the
// commit and the body about to be published. This check asks for proof that
// it ran on *this* commit and *this* body, and that nothing it found that
// upstream's agent rejects a pull request for — an `issue:`, a `question:`
// with no answer — is still open. A `nit:` does not hold the push; the summary
// counts what was left.
//
// It reads the body, because the review does: a body that changed after the
// review was read by nobody.

import { bodyDigest, entryFor, read, rounds, unresolved } from '../../self-review.js';
import { skipForBody } from '../body.js';

/** @type {string} */
export const id = 'self-review';

/** @type {boolean} */
export const blocking = true;

/** @type {boolean} */
export const needsBody = true;

/**
 * @param {import('../../self-review.js').Finding} finding
 */
const formatFinding = (finding) => {
  const where = finding.path ? `${finding.path}${finding.line ? `:${finding.line}` : ''} — ` : '';
  const source = finding.section === null ? '(outside the rule set)' : `(§${finding.section})`;
  return `${where}${finding.label}: ${finding.text} ${source}`;
};

/**
 * @param {import('../index.js').PreflightContext} context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context) {
  const record = `pdkit self-review record --issue ${context.issue}${Number.isInteger(context.slice) ? ` --slice ${context.slice}` : ''} --findings <f> --body <f>`;

  if (context.prBody === null) {
    return skipForBody({ id, blocking, remedy: `run the self-review on the drafted body (/pd:pr step 5), then ${record}` });
  }

  if (context.headSha === null) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: 'cannot tell which commit is under check, so no self-review can be matched to it',
      remedy: 'run preflight on a branch that resolves to a commit',
    };
  }

  const entry = entryFor(await read(context.issue, { home: context.home }), context.slice);

  if (entry === null) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: 'no self-review is recorded for this pull request',
      remedy: `run the four review axes and the synthesis on the branch and the body (/pd:pr step 5), then ${record}`,
    };
  }

  const head = context.headSha.slice(0, 8);
  if (entry.sha !== context.headSha) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: `the self-review read ${entry.sha.slice(0, 8)}, and the branch is at ${head}`,
      remedy: `review the commit being published, not an earlier one: run the axes again, then ${record}`,
    };
  }

  if (entry.bodyDigest !== bodyDigest(context.prBody)) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: 'the PR body changed after the self-review read it',
      remedy: `the body is part of what upstream's agent reviews (section 1): run the axes on this body, then ${record}`,
    };
  }

  const open = unresolved(entry);
  if (open.length > 0) {
    const counted = await rounds({ issue: context.issue, slice: context.slice, config: context.config, home: context.home });
    const slice = Number.isInteger(context.slice) ? ` --slice ${context.slice}` : '';
    return {
      id,
      status: 'fail',
      blocking,
      summary: `${open.length} self-review finding(s) still open on ${head}`,
      output: open.map(formatFinding).join('\n'),
      remedy: counted.blocked
        ? `the review ran on ${counted.rounds} commits in a row without a clean one, the limit (review.self_review_rounds): ` +
          'stop and ask the person what to do (/pd:pr step 5). Going on is theirs to say: ' +
          `pdkit self-review continue --issue ${context.issue}${slice} --reason "<what is different this time>"`
        : 'fix each `issue:` in the code and answer each `question:` in the pull request; a `nit:` does not hold the push. ' +
          `Then run the axes on the new commit and ${record}`,
    };
  }

  return { id, status: 'pass', blocking, summary: `four axes on ${head}${left(entry.findings)}` };
}

/**
 * What a review with nothing open still found, counted: the summary says what
 * was measured, and "nothing open" next to five nits would say less.
 *
 * @param {import('../../self-review.js').Finding[]} findings
 * @returns {string}
 */
function left(findings) {
  if (findings.length === 0) return ', nothing found';

  const nits = findings.filter((finding) => finding.label === 'nit');
  const preExisting = nits.filter((finding) => finding.preExisting).length;
  const answered = findings.filter((finding) => finding.label === 'question').length;

  const parts = [];
  if (nits.length > 0) parts.push(`${nits.length} nit(s) left${preExisting > 0 ? `, ${preExisting} of them pre-existing` : ''}`);
  if (answered > 0) parts.push(`${answered} answered question(s)`);
  return `: no issue, no unanswered question; ${parts.join(', ')}`;
}
