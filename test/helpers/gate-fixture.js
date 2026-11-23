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

// The world the push gate decides in, for suites that run it through the hook
// process rather than by importing dispatch.js: a clone of podman-desktop (as
// far as lib/hooks/scope.js can tell), a repository that is not, and an issue
// walked to the one state a consent token is issued from.
//
// Outside `test/*.test.js`, so the runner does not collect it as a suite.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { transition } from '../../lib/state.js';
import { approvablePlan } from './approvable-plan.js';
import { auditReviewed } from './audit-review.js';
import { preflightGreen } from './preflight-evidence.js';

const run = promisify(execFile);

/** The branch the podman-desktop clone is on. */
export const BRANCH = 'DESKTOP-2001/fix-the-thing';

/**
 * A repository with podman-desktop as its upstream, on BRANCH. Nothing is ever
 * pushed from it: the gate decides, and the suites stop there.
 *
 * @param {string} prefix
 * @returns {Promise<string>}
 */
export async function podmanDesktopClone(prefix) {
  const repo = await mkdtemp(join(tmpdir(), prefix));
  await run('git', ['init', '-q', '-b', BRANCH], { cwd: repo });
  await run('git', ['remote', 'add', 'upstream', 'https://github.com/podman-desktop/podman-desktop.git'], { cwd: repo });
  return repo;
}

/**
 * A repository that is provably not podman-desktop.
 *
 * @param {string} prefix
 * @returns {Promise<string>}
 */
export async function otherRepository(prefix) {
  const repo = await mkdtemp(join(tmpdir(), prefix));
  await run('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  await run('git', ['remote', 'add', 'origin', 'git@github.com:someone/podman-desktop-kit.git'], { cwd: repo });
  return repo;
}

/**
 * Walk an issue to `preflight-green`, the only state a push token is issued
 * from — and, with `prOpen`, on to `pr-open`, where reply tokens are.
 *
 * @param {number} issue
 * @param {{home: string, prOpen?: boolean}} options
 */
export async function readyIssue(issue, options) {
  const { home } = options;
  // The move to preflight-green is earned from what preflight wrote, so a
  // fixture standing there has to have produced it like anything else.
  await preflightGreen(issue, { home });
  await approvablePlan(issue, { home });
  await auditReviewed(issue, { home });

  const path = [
    'triaged',
    'planned',
    'plan-approved',
    'implemented',
    'validated',
    'audited',
    'sliced',
    'slices-approved',
    'preflight-green',
    ...(options.prOpen ? ['pr-open'] : []),
  ];
  for (const to of path) {
    const result = await transition(issue, to, { home });
    assert.ok(result.ok, `could not reach ${to}: ${result.error}`);
  }
}
