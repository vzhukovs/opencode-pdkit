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

// Preflight check: what the plan decided the body must disclose
//
// A plan's `## Body must disclose` names, a line per item and slice, what a
// pull request body has to tell its reviewer because the plan decided it: a
// behavior that changes without being asked for, a duplication kept on
// purpose, a decision the person made. A reviewer who is not told asks, and
// the person answers on the pull request what was settled before any code —
// the second slice of a sandbox issue had its review ask about the platform a
// default pull sends, which its plan had decided and said the body must say.
//
// On the first pass this lists the lines, so the body is written with them in
// front of it. On the second it holds the body to having said something where
// they belong, `Notes for reviewers`. Whether the notes say each line, a grep
// cannot tell: the plan and the body say the same thing in different words,
// and the self-review judges it. The summary says exactly that much.

import { disclosures } from '../../review-inputs.js';
import { saysNotApplicable, sectionOf, skipForBody } from '../body.js';

/** @type {string} */
export const id = 'body-must-disclose';

/** @type {boolean} */
export const blocking = true;

/** @type {boolean} */
export const needsBody = true;

/**
 * @param {import('../index.js').PreflightContext} context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context) {
  if (context.route === 'quickfix') return { id, status: 'skip', blocking, summary: 'the quickfix route has no plan' };

  const owed = await disclosures(context.issue, { home: context.home, slice: context.slice });
  if (!owed.plan.exists) return { id, status: 'skip', blocking, summary: 'no plan.md: nothing the plan decided for the body' };
  if (owed.predates) return { id, status: 'skip', blocking, summary: 'the plan predates ## Body must disclose' };

  if (owed.lines.length === 0) {
    const others = owed.others > 0 ? `; ${owed.others} line(s) name other slices` : '';
    return { id, status: 'pass', blocking, summary: `the plan names nothing for this pull request to disclose${others}` };
  }

  const output = owed.lines.map((line) => `- ${line}`).join('\n');
  if (context.prBody === null) {
    return skipForBody({
      id,
      blocking,
      lead: `${owed.lines.length} line(s) of the plan's Body must disclose name this pull request — `,
      remedy: "say each in Notes for reviewers, in a sentence of the reviewer's words, then run preflight again",
      output,
    });
  }

  const notes = sectionOf(context.prBody, 'notes for reviewers') ?? '';
  if (notes === '' || saysNotApplicable(notes)) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: `the plan asks this body to disclose ${owed.lines.length} thing(s), and Notes for reviewers ${notes === '' ? 'is empty' : 'says n/a'}`,
      output,
      remedy:
        'say each there: what changes without being asked for, what is duplicated on purpose, what the person decided. ' +
        'A reviewer who is not told asks, and the person answers on the pull request what the plan settled',
    };
  }

  return {
    id,
    status: 'pass',
    blocking,
    summary: `${owed.lines.length} line(s) of the plan's Body must disclose; Notes for reviewers is written — whether it says each is the self-review's to judge`,
    output,
  };
}
