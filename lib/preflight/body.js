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

// The PR body, as the checks that read it see it: the skip of a check whose
// input is the body, before the body exists, and the body's sections by the
// template's own markers.
//
// A leaf: the checks under checks/ import it instead of index.js, the runner
// that loads them. index.js re-exports the skip.

/** @typedef {import('./index.js').CheckResult} CheckResult */

/** How every check ends its summary when it is the body it lacks. */
export const BODY_NOT_DRAFTED = 'the PR body is not drafted yet';

/**
 * The skip of a check that cannot judge until the PR body is drafted.
 *
 * One place for the phrase and the marker, so the two cannot drift apart: the
 * summary is `lead` followed by BODY_NOT_DRAFTED, and `waitingFor: 'body'` is
 * what `waitingForBody` counts. Keys come out in the order the checks wrote them
 * by hand, so --json is unchanged once the marker is dropped.
 *
 * @param {{id: string, blocking: boolean, lead?: string, remedy: string, output?: string}} input
 *   `lead` carries its own separator: `'the public API is touched; '`
 * @returns {CheckResult}
 */
export function skipForBody({ id, blocking, lead = '', ...rest }) {
  return { id, status: 'skip', blocking, summary: `${lead}${BODY_NOT_DRAFTED}`, ...rest, waitingFor: 'body' };
}

/**
 * The sections of a body, by the template's markers, in its order: what
 * `pr-body-size` measures, and what a check reading one section reads.
 *
 * Only the template's own markers bound a section. A body may put a bold line
 * of its own mid-paragraph, and treating that as a boundary would stop a
 * section half way through and report the rest as if it had been read — the
 * mistake steps-to-check made once, in the other direction.
 */
const SECTIONS = [
  { name: 'what', pattern: /^###[ \t]+What does this PR do\?[ \t]*$/m },
  { name: 'where to look', pattern: /^\*\*Where to look\*\*[ \t]*$/m },
  { name: 'not in this PR', pattern: /^\*\*Not in this PR\*\*[ \t]*$/m },
  { name: 'UI evidence', pattern: /^###[ \t]+Screenshot \/ video of UI[ \t]*$/m },
  { name: 'issue references', pattern: /^###[ \t]+What issues does this PR fix or reference\?[ \t]*$/m },
  { name: 'steps', pattern: /^###[ \t]+How to test this PR\?[ \t]*$/m },
  { name: 'notes for reviewers', pattern: /^\*\*Notes for reviewers\*\*[ \t]*$/m },
];

/**
 * Lines the template supplies and the author does not write.
 *
 * Upstream's test checkbox and the attribution footer sit after the last
 * section, so without this they would be read as `Notes for reviewers`: a
 * Notes nobody wrote would read as written, and a size check would bill the
 * author for text the renderer put there.
 */
const BOILERPLATE = /^(?:- \[[ xX]\] .*|<sub>.*|🤖 Generated with.*)$/gm;

/**
 * Each section a body has, with what the author wrote in it, trimmed.
 *
 * @param {string|null} body
 * @returns {Array<{name: string, text: string}>}
 */
export function sectionsOf(body) {
  const text = String(body ?? '').replace(BOILERPLATE, '');

  const marks = [];
  for (const section of SECTIONS) {
    const found = section.pattern.exec(text);
    if (found) marks.push({ name: section.name, start: found.index, end: found.index + found[0].length });
  }
  marks.sort((left, right) => left.start - right.start);

  return marks.map((mark, index) => ({
    name: mark.name,
    text: text.slice(mark.end, index + 1 < marks.length ? marks[index + 1].start : text.length).trim(),
  }));
}

/**
 * What the author wrote in one section, or null when the body has none.
 *
 * @param {string|null} body
 * @param {string} name  as SECTIONS names it: `notes for reviewers`, `UI evidence`, …
 * @returns {string|null}
 */
export function sectionOf(body, name) {
  return sectionsOf(body).find((section) => section.name === name)?.text ?? null;
}

/**
 * An image or a video the way GitHub writes one into a body: a markdown image,
 * an `<img>` or `<video>` tag, or the bare link of an uploaded file, which
 * GitHub renders as the file. One match per item: a tag's own link is part of
 * the tag. Global, so it is only ever used through `match` and `replace`.
 */
const MEDIA = /!\[[^\]]*\]\([^)]*\)|<img\b[^>]*>|<video\b[\s\S]*?<\/video>|<video\b[^>]*>|https:\/\/github\.com\/user-attachments\/assets\/[\w-]+/gi;

/**
 * The images and videos in a text, one entry each.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function mediaIn(text) {
  return String(text ?? '').match(MEDIA) ?? [];
}

/**
 * A text with its images and videos taken out: what a reader reads of it.
 *
 * @param {string} text
 * @returns {string}
 */
export function withoutMedia(text) {
  return String(text ?? '').replace(MEDIA, '');
}

/**
 * Whether what a section holds is the template's own answer for nothing to
 * say there: `n/a`, with or without its reason.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function saysNotApplicable(text) {
  return /^n\/a\b/i.test(String(text ?? '').trim());
}
