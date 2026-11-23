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

// Preflight check: a pull request that changes a component shows it
//
// Upstream's template asks for a screenshot or a video when a pull request
// changes UI, and the maintainer's review blocks without one. /pd:validate
// takes the screenshots; nothing carried them into the body. A sandbox slice
// that changed two components had a body promising its images "in the
// description", where there were none, and its review raised exactly that.
//
// Nothing in the plugin can upload an image to GitHub — there is no API for an
// attachment — so the person does, by dragging a file into a comment box, and
// the body carries the link GitHub writes. On the first pass this lists the
// components the pull request changes and the screenshots the validation took,
// with their files, so the body is written with them in front of it. On the
// second it holds `Screenshot / video of UI` to showing one, or to saying
// `n/a` and why: a placeholder left in, or a screenshot promised for later, is
// one the reviewer does not have.
//
// A component is a `.svelte` file this pull request changes. Whether a change
// to one is visible is not something a grep can say, so `n/a` beside a changed
// component is a warning, for the self-review to judge.

import { join } from 'node:path';

import { issueDir } from '../../config.js';
import { read } from '../../validation.js';
import { mediaIn, saysNotApplicable, sectionOf, skipForBody } from '../body.js';

/** @type {string} */
export const id = 'ui-evidence';

/** @type {boolean} */
export const blocking = true;

/** @type {boolean} */
export const needsBody = true;

/** A component: what renders. */
const COMPONENT = /\.svelte$/;

/** A validation artefact a body can show: an image or a video. */
const VISUAL = /\.(?:png|jpe?g|gif|webp|mp4|mov|webm)$/i;

/** The visible placeholder /pd:pr writes for a screenshot whose link has not come yet. */
const PLACEHOLDER = /\*\*\[SCREENSHOT\b/i;

/**
 * The screenshots the validation took: an image or a video attached to a step
 * that was not set aside, with the file it was kept as.
 *
 * @param {import('../index.js').PreflightContext} context
 * @returns {Promise<string[]>}
 */
async function screenshots(context) {
  if (context.route === 'quickfix') return [];
  const record = await read(context.issue, { home: context.home });
  return (record?.steps ?? [])
    .filter((step) => !step.superseded && step.evidence?.kind === 'artefact' && VISUAL.test(step.evidence.path))
    .map((step) => {
      const covers = step.requirements.length > 0 ? ` (${step.requirements.join(', ')})` : '';
      return `${step.id} ${step.title}${covers} — ${join(issueDir(context.home, context.issue), step.evidence.path)}`;
    });
}

/**
 * @param {import('../index.js').PreflightContext} context
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context) {
  const components = context.changedFiles.filter((file) => COMPONENT.test(file));
  if (components.length === 0) return { id, status: 'pass', blocking, summary: 'nothing to show: no component changed' };

  const changed = `${components.length} component(s) changed`;
  if (context.prBody === null) {
    const shots = await screenshots(context);
    return skipForBody({
      id,
      blocking,
      lead: `${changed}${shots.length > 0 ? `, ${shots.length} screenshot(s) in validation` : ''} — `,
      remedy:
        'show the change in Screenshot / video of UI: the person drags each screenshot into a comment box on GitHub ' +
        'and gives you the link it writes; if nothing visible changed, n/a and why. Then run preflight again',
      output: [...components, ...shots].join('\n'),
    });
  }

  const shown = sectionOf(context.prBody, 'UI evidence') ?? '';
  if (PLACEHOLDER.test(shown)) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: 'a screenshot placeholder is left in Screenshot / video of UI, and would be published as written',
      remedy: 'replace it with the link GitHub writes for the file, or delete it',
    };
  }

  const media = mediaIn(shown);
  if (media.length > 0) {
    return { id, status: 'pass', blocking, summary: `${changed}; Screenshot / video of UI shows ${media.length} image(s) or video(s)` };
  }

  if (saysNotApplicable(shown)) {
    return {
      id,
      status: 'warn',
      blocking,
      summary: `${changed}, and Screenshot / video of UI says n/a — the self-review judges whether nothing visible changed`,
      output: components.join('\n'),
    };
  }

  return {
    id,
    status: 'fail',
    blocking,
    summary: `${changed}, and Screenshot / video of UI shows nothing and says no n/a`,
    output: components.join('\n'),
    remedy:
      "a screenshot promised for later is one the reviewer does not have: link the validation's screenshots now " +
      '(the first pass lists them), or say n/a and why nothing visible changed',
  };
}
