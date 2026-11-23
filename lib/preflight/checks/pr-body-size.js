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

// Preflight check: how much of a reviewer's time the body asks for
//
// On podman-desktop#19317 a reviewer wrote: "The PR description, is unnecessary
// long and verbose, IMHO we don't need that much verbosity, this makes it
// harder to review because of the content to read. We should focus on direct
// important info, the changes per file is not needed."
//
// Measured across the author's 30 pull requests upstream, the break is exactly
// where this plugin starts writing the body. Twenty-two written by hand ran
// 378-2551 characters, median around 1200. Eight written through /pd:pr ran
// 2069-14015. The complaint arrived on one of the SMALLER ones — 4082 — which
// is the part worth knowing: the reviewer's limit sits below this plugin's
// most modest result, so "shorter next time" was never going to be enough.
//
// The template already said "point at the part that carries the logic", and the
// 14015-character body was written under it. That is the repository's own
// lesson about rules that live only in prose, so the budget gets a check.
//
// It does not block, for the reason quickfix-size does not: a gate that stops a
// correct change over a long paragraph is a gate people learn to route around,
// and the cost of being wrong here is a reviewer reading two extra sentences.
//
// `How to test this PR?` is deliberately NOT counted and NOT included in the
// total. It is the one section a reviewer executes rather than reads, it was
// the explicit constraint on this work, and a number that silently counted it
// would push the one part worth expanding in the direction of the one thing
// this check exists to prevent. Its heading still bounds the sections around
// it — bounding is not measuring.

import { sectionsOf, skipForBody, withoutMedia } from '../body.js';

/** @type {string} */
export const id = 'pr-body-size';

/**
 * Never blocking, deliberately. See the note above.
 *
 * @type {boolean}
 */
export const blocking = false;

/** @type {boolean} */
export const needsBody = true;

/**
 * What each section may hold, in characters of what the author wrote, by the
 * name lib/preflight/body.js gives it.
 *
 * Budgets come from the bodies upstream merged without complaint rather than
 * from taste: #17472 is 2551 characters of which roughly 700 are steps, so the
 * 1800 these add up to is a real pull request's shape, not a target invented
 * here.
 *
 * `null` means bounded but not counted — the steps.
 *
 * @type {Record<string, number|null>}
 */
const BUDGETS = {
  what: 600,
  'where to look': 300,
  'not in this PR': 120,
  'UI evidence': 200,
  'issue references': 200,
  steps: null,
  'notes for reviewers': 400,
};

/** What the budgets add up to, steps excluded. */
export const BUDGET = Object.values(BUDGETS).reduce((total, budget) => total + (budget ?? 0), 0);

/**
 * Each section of a rendered body, with the length of what it holds.
 *
 * An image or a video is not counted, and the words around it are: a
 * screenshot goes in as the link GitHub writes for it, two of them outrun the
 * 200 characters of `Screenshot / video of UI` with nothing in them a reviewer
 * reads, and a warning every body showing its change gets is a warning nobody
 * reads either.
 *
 * @param {string} body
 * @returns {Array<{name: string, budget: number|null, chars: number}>}
 */
export function measure(body) {
  return sectionsOf(body).map((section) => ({
    name: section.name,
    budget: BUDGETS[section.name] ?? null,
    chars: withoutMedia(section.text).trim().length,
  }));
}

/**
 * @param {import('../index.js').PreflightContext} context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context) {
  if (context.prBody === null) {
    return skipForBody({
      id,
      blocking,
      remedy: 'draft the body, then run preflight again — this check has to read it',
    });
  }

  const measured = measure(context.prBody);
  const counted = measured.filter((section) => section.budget !== null);
  const total = counted.reduce((sum, section) => sum + section.chars, 0);
  const over = counted.filter((section) => section.chars > section.budget);

  const steps = measured.find((section) => section.budget === null);
  const stepsNote = `steps ${steps ? `${steps.chars} chars, ` : ''}not counted`;

  if (over.length === 0) {
    return {
      id,
      status: 'pass',
      blocking,
      summary: `${total} chars against a budget of ${BUDGET}, ${stepsNote}`,
    };
  }

  return {
    id,
    status: 'warn',
    blocking,
    summary: `${total} chars against a budget of ${BUDGET}, ${stepsNote} — ${over.length} section(s) over`,
    output: counted.map((section) => `${section.chars > section.budget ? '!' : ' '} ${section.name}  ${section.chars}/${section.budget}`).join('\n'),
    remedy:
      'cut what a reviewer will not act on: the reasoning trail belongs to the plan, the review history to the pull ' +
      'request conversation, and the requirement trace to the issue record — none of the three is published. ' +
      'The steps are not the place to save, and are not counted here',
  };
}
