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

// `pdkit cost`: what each issue cost in tokens, normalized by the size of the
// work; with --planning, what planning cost round by round, and what the plan
// needed after approval.
//
// The handler only. Argument parsing and dispatch stay in lib/cli.js, which
// registers this module in REGISTRY; what more than one handler needs is in
// ./support.js.

import { basename, resolve } from 'node:path';

import { load, resolveHome } from '../config.js';
import * as cost from '../cost.js';
import * as journal from '../journal.js';
import * as planning from '../planning.js';
import { notTheClone, resolveRepoRoot } from '../repo.js';
import { EXIT, issueFlag, printJson } from './support.js';

export const flags = ['issue', 'since', 'snapshot', 'compare', 'json', 'db', 'planning'];

/**
 * What each issue cost in tokens, normalized by the size of the work.
 *
 * @param {string[]} args
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
export async function run(args, flags) {
  const repoFlag = typeof flags.repo === 'string' ? flags.repo : undefined;
  const config = await load({ repoRoot: repoFlag });
  const home = resolveHome({ repoRoot: repoFlag });

  let issue = null;
  if (flags.issue !== undefined) {
    issue = issueFlag(flags);
    if (!Number.isInteger(issue)) {
      process.stderr.write(`pdkit cost: --issue ${flags.issue} is not an issue number\n`);
      return EXIT.ERROR;
    }
  }

  let since = null;
  if (flags.since !== undefined) {
    const resolved = journal.resolveSince(String(flags.since));
    if (!resolved.ok) {
      process.stderr.write(`pdkit cost: ${resolved.error}\n`);
      return EXIT.ERROR;
    }
    since = resolved.at;
  }

  // A round is cut by journal entries, not by a date, and the planning report
  // has no snapshot to compare with yet: both would be flags that ran and did
  // not do what they say.
  const unplanned = ['since', 'compare'].find((name) => flags.planning && flags[name] !== undefined);
  if (unplanned) {
    process.stderr.write(`pdkit cost: --${unplanned} does not apply to --planning\n`);
    return EXIT.ERROR;
  }
  if (flags.db !== undefined && typeof flags.db !== 'string') {
    process.stderr.write("pdkit cost: --db takes the path of Open Code's database file\n");
    return EXIT.ERROR;
  }

  if (flags.compare !== undefined && typeof flags.compare !== 'string') {
    process.stderr.write('pdkit cost: --compare takes the date of a snapshot (YYYY-MM-DD)\n');
    return EXIT.ERROR;
  }
  // Read before measuring: a snapshot that is not there is the answer, and
  // finding out after a read of every session is a slow way to learn it.
  const before = typeof flags.compare === 'string' ? await cost.readSnapshot(flags.compare, { home }) : null;

  // Open Code keeps one database for every project, and a session belongs to
  // the clone by the directory it ran in. From any other directory this would
  // read that one's sessions and attribute them to this home's issues by time
  // alone — run from this plugin's own checkout, planning came out as no calls
  // at all. Refused, before a read, for both reports: every figure after it
  // would be wider than what was measured. --db does not lift it — it names
  // the file, not the sessions in it.
  const repo = await resolveRepoRoot({ config, cwd: repoFlag });
  const elsewhere = notTheClone(repo);
  if (elsewhere || !repo.root) {
    process.stderr.write(
      `pdkit cost: ${elsewhere ?? 'not inside a git repository'}\n` +
        '  Sessions are picked by the directory they ran in, so from another directory every figure would be the sessions opened there.\n' +
        '  Run it inside the clone, pass --repo <clone>, or set repo.path.\n',
    );
    return EXIT.ERROR;
  }

  const db = typeof flags.db === 'string' ? resolve(flags.db) : undefined;
  if (flags.planning) return planningReport({ db, repoRoot: repo.root, config, home, issue }, flags);

  const report = await cost.collect({ db, repoRoot: repo.root, config, home, issue, since });

  const written = flags.snapshot && !report.skip ? await cost.writeSnapshot(report, { home }) : null;

  if (before) {
    const comparison = cost.compare(before, report);
    if (flags.json) printJson(comparison);
    else process.stdout.write(cost.formatComparison(comparison));
  } else if (flags.json) {
    printJson(written ? { ...report, snapshot: written } : report);
  } else {
    process.stdout.write(cost.format(report));
  }

  if (written && !flags.json) process.stdout.write(`snapshot written to ${written}\n`);
  // Beside, not over, the day's snapshot from Claude Code's transcripts:
  // say why it has the other name, and how to compare with it.
  if (written && written.endsWith(`.${cost.SOURCE}.json`)) {
    process.stderr.write(
      "pdkit cost: that day's snapshot was taken from Claude Code's transcripts and marks where measuring starts, " +
        `so it is kept; compare with this one as --compare ${basename(written, '.json')}\n`,
    );
  }
  if (flags.snapshot && report.skip) process.stderr.write('pdkit cost: no snapshot written — nothing was measured\n');

  // Zero, as for stats: a cost is not a pass or a fail, and a threshold here
  // would be the recommendation this command refuses to make.
  return EXIT.OK;
}

/**
 * What planning cost round by round, and what the plan needed after approval.
 *
 * @param {{db: string|undefined, repoRoot: string, config: object, home: string, issue: number|null}} input
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<number>}
 */
async function planningReport(input, flags) {
  const report = await planning.collect(input);
  const written = flags.snapshot ? await planning.writeSnapshot(report, { home: input.home }) : null;

  if (flags.json) printJson(written ? { ...report, snapshot: written } : report);
  else process.stdout.write(planning.format(report));
  if (written && !flags.json) process.stdout.write(`snapshot written to ${written}\n`);
  // Beside, not over, the day's planning snapshot from Claude Code's
  // transcripts: the rounds before the move are measured only there.
  if (written && written.endsWith(`.${cost.SOURCE}.json`)) {
    process.stderr.write(
      "pdkit cost: that day's planning snapshot was taken from Claude Code's transcripts and holds the rounds measured before the move, " +
        `so it is kept; this one is ${basename(written)} beside it\n`,
    );
  }

  // Zero, as for the cost report: a number of rounds is not a pass or a fail.
  return EXIT.OK;
}
