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

// What the review axes read besides the diff: what the plan decided, and the
// tests the change owes.
//
// `pdkit self-review target` hands the axes and the synthesis what they judge
// against, for a pull request and for the audit's review of the whole branch.
// The triage record says the scope. This says what was settled after it: the
// plan's Open decisions and e2e coverage — how planning answered the triage
// record's open questions, and what the person decided — the lines of `Body
// must disclose` a pull request has to say, and the `## Tests` each task with
// code owes, or on the quickfix route the `## Tests` of issue.md. The axes of a
// sandbox issue's second slice asked what its plan had settled, and the person
// answered on the pull request the same thing a second time.
//
// Facts, quoted and counted as written. Whether a question is answered by a
// decision, and whether a test asserts what its row says, is for the axes and
// the synthesis to judge.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { casesIn, codeIn, disclosuresFor, parsePlan, parseTask, testsIn } from './artefacts.js';
import { issueDir, resolveHome } from './config.js';
import { matchesAny } from './globs.js';
import { taskFiles } from './plan-approval.js';
import { read as readState } from './state.js';

/**
 * The tests one live task with code owes, as its plan lists them.
 *
 * @typedef {object} TestsOwed
 * @property {string} id
 * @property {number} cases          rows of its `## Tests`
 * @property {string|null} file      the task file they are in; null while the task has none and its block in plan.md lists them
 */

/**
 * The lines of `Body must disclose` a pull request owes, or that the plan has
 * none to give: `predates` for a plan written before the sections that answer
 * the review, which wrote what a body must say, if anything, in its prose.
 *
 * @typedef {object} Disclosed
 * @property {boolean} predates
 * @property {string[]} lines
 * @property {number} others   lines that name other slices
 */

/**
 * @typedef {object} ReviewInputs
 * @property {{path: string, exists: boolean, requirements: string[]}} plan   the requirements as its `- Requirements:` line states them
 * @property {{openDecisions: string, e2eCoverage: string}|null} decided   as the plan wrote them; null with no plan
 * @property {Disclosed|null} disclose   null with no plan
 * @property {{predates: boolean, tasks: TestsOwed[]}} tests
 * @property {{path: string, listed: boolean, cases: number}} issueTests   the `## Tests` of issue.md, which the quickfix route writes
 */

/**
 * The issue's plan, read, or null when there is none.
 *
 * @param {string} home
 * @param {number} issue
 */
async function planOf(home, issue) {
  const path = join(issueDir(home, issue), 'plan.md');
  const text = await readFile(path, 'utf8').catch(() => null);
  return { path, plan: text === null ? null : parsePlan(text) };
}

/**
 * What a plan says a pull request's body must disclose: for a slice, the lines
 * that name it or name none; for a single pull request, every line.
 *
 * @param {import('./artefacts.js').Plan} plan
 * @param {number|null|undefined} slice
 * @returns {Disclosed}
 */
function disclosedBy(plan, slice) {
  if ((plan.answers ?? []).length === 0) return { predates: true, lines: [], others: 0 };
  return { predates: false, ...disclosuresFor(plan.bodyMustDisclose, slice) };
}

/**
 * The lines of the plan's `Body must disclose` a pull request owes: what the
 * `body-must-disclose` preflight check holds a body to.
 *
 * @param {number} issue
 * @param {{home?: string, slice?: number|null}} [options]
 * @returns {Promise<{plan: {path: string, exists: boolean}} & Disclosed>}
 */
export async function disclosures(issue, options = {}) {
  const { path, plan } = await planOf(options.home ?? resolveHome(), issue);
  if (plan === null) return { plan: { path, exists: false }, predates: false, lines: [], others: 0 };
  return { plan: { path, exists: true }, ...disclosedBy(plan, options.slice) };
}

/**
 * What the review axes read besides the diff: the plan's decisions and the
 * lines a body must disclose, the tests each live task with code owes — the
 * `## Tests` of its task file, or of its block in plan.md while it has no file,
 * as `plan check` reads them — and the `## Tests` of issue.md.
 *
 * `files` narrows the tests to a pull request: the tasks owning one of its
 * files. Without it, the whole branch's, for the audit. `slice` narrows the
 * lines to disclose to that slice's. A plan written before the sections that
 * answer the review, one with none of them, has neither tests nor lines to
 * give; `predates` says so, rather than letting its tasks read as owing
 * nothing.
 *
 * @param {number} issue
 * @param {{home?: string, slice?: number|null, files?: string[]|null}} [options]
 * @returns {Promise<ReviewInputs>}
 */
export async function reviewInputs(issue, options = {}) {
  const home = options.home ?? resolveHome();
  const issueMd = join(issueDir(home, issue), 'issue.md');
  const listed = testsIn((await readFile(issueMd, 'utf8').catch(() => null)) ?? '');
  const issueTests = { path: issueMd, listed: listed.listed, cases: listed.cases.length };

  const { path, plan } = await planOf(home, issue);
  if (plan === null) {
    return { plan: { path, exists: false, requirements: [] }, decided: null, disclose: null, tests: { predates: true, tasks: [] }, issueTests };
  }

  const record = await readState(issue, { home });
  const files = await taskFiles(issueDir(home, issue), parseTask);
  const touched = options.files ?? null;

  /** @type {TestsOwed[]} */
  const tasks = [];
  for (const task of plan.tasks) {
    const file = files[task.id];
    if (record.withdrawn?.[task.id] || file?.withdrawn || task.replacedBy) continue;
    const owns = file?.owns ?? task.owns;
    if (codeIn(owns).source.length === 0) continue;
    if (touched !== null && !touched.some((changed) => matchesAny(changed, owns))) continue;
    tasks.push({
      id: task.id,
      cases: (file ? file.tests : casesIn(task.tests)).length,
      file: file ? join(issueDir(home, issue), 'tasks', `${task.id}.md`) : null,
    });
  }

  return {
    plan: { path, exists: true, requirements: plan.requirements },
    decided: { openDecisions: plan.openDecisions, e2eCoverage: plan.e2eCoverage },
    disclose: disclosedBy(plan, options.slice),
    tests: { predates: (plan.answers ?? []).length === 0, tasks },
    issueTests,
  };
}
