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

// A review of the whole branch, recorded, for suites that walk an issue
// through `audited` and are not about the audit.
//
// The move stopped being free, as `plan-approved` and `preflight-green` did
// before it: it reads the audit's review of the branch from the self-review
// record, and refuses without one. A fixture standing past it records one
// through lib/self-review.js, the way the audit does, rather than writing the
// file by hand, which would keep passing after the shape changed.
//
// Outside `test/*.test.js`, so the runner does not collect it as a suite.

import { AXES, record } from '../../lib/self-review.js';

/** The commit a fixture's review read. A clean review is read wherever the branch stands, so any will do. */
export const REVIEWED = 'e'.repeat(40);

/**
 * Record a clean review of the issue's whole branch.
 *
 * @param {number} issue
 * @param {{home: string, sha?: string}} options
 */
export async function auditReviewed(issue, options) {
  const result = await record({ issue, audit: true, sha: options.sha ?? REVIEWED, axes: [...AXES], findings: [], home: options.home });
  if (!result.ok) throw new Error(`auditReviewed: ${result.error}`);
  return result;
}
