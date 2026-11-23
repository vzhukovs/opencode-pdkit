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

// Running the scripts lib/scripts.js resolves, on preflight's behalf: why a run
// could not start, and whether slice verify or an earlier preflight run on the
// same tree already measured it.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { get, issueDir } from '../config.js';
import { capture, validateReceipt } from '../evidence.js';
import { measuredOnTree } from './record.js';

export { candidatesFor, runScript, scopedScripts, typecheckScripts } from '../scripts.js';

/**
 * Why a script could not be started, or null when it ran — whatever it said.
 *
 * A shell that cannot find a command exits 127, and that is a fact about PATH,
 * not about the code. cmd.exe is the exception: under `cmd /d /s /c` it exits 1
 * and says `'x' is not recognized as an internal or external command`, so on
 * Windows the sentence is the signal, not the code. On DESKTOP-19901 a node upgrade left
 * `pnpm` off PATH, and tests, lint and typecheck all came back `failing` with
 * "fix the tests, or the code they are telling you about" — the remedy for a
 * different problem, followed for five minutes before anyone read the output.
 *
 * @param {import('../evidence.js').Capture} result
 * @param {import('./index.js').PreflightContext} context
 * @returns {string|null}
 */
export function unrunnable(result, context) {
  const said = `${result.stderr}\n${result.stdout}`;
  const cmd = /^'([^']+)' is not recognized as an internal or external command/m.exec(said);
  const notFound = result.exitCode === 127 || result.exitCode === 9009 || (result.exitCode !== 0 && result.exitCode !== null && cmd !== null);
  if (!notFound) return null;

  const manager = get(context.config, 'repo.package_manager') ?? 'pnpm';
  // The manager itself, or something a script calls. Both are the environment;
  // only the remedy differs.
  const named = cmd?.[1] ?? /([\w.@/-]+): (?:command )?not found/.exec(said)?.[1] ?? null;
  const missing = named === manager || new RegExp(`(^|[\\s:])${manager}: (command )?not found`, 'm').test(said) ? manager : named;

  return missing === manager
    ? `${manager} is not on PATH`
    : `${missing ? `\`${missing}\`` : 'a command it calls'} is not on PATH (exit ${result.exitCode})`;
}

/**
 * The result for a check whose scripts could not be started.
 *
 * Still a blocking `fail` — nothing was measured, and a gate that passes on an
 * unmeasured run is the thing this file exists to prevent — but worded as the
 * environment it is.
 *
 * @param {string} id
 * @param {boolean} blocking
 * @param {string[]} reasons  one per script, from `unrunnable`
 * @param {string} output
 * @param {import('./index.js').PreflightContext} context
 * @returns {import('./index.js').CheckResult}
 */
export function environmentFailure(id, blocking, reasons, output, context) {
  const manager = get(context.config, 'repo.package_manager') ?? 'pnpm';
  return {
    id,
    status: 'fail',
    blocking,
    summary: `could not run: ${[...new Set(reasons)].join('; ')} — the environment, not the code`,
    output,
    remedy: `put ${manager} on PATH (\`pdkit doctor\` checks it) or run \`${manager} install\` for a missing dependency binary, then run preflight again`,
  };
}

/** One lookup per preflight run, shared by the three checks that ask. */
const verifiedRuns = new WeakMap();

/**
 * The slice verification's run, when it already ran these scripts on this
 * commit or on this tree.
 *
 * `slice verify` runs typecheck, lint and the scoped tests on the slice, and
 * preflight used to run the same three again straight after it: on
 * DESKTOP-19818 the pair outlived a 600-second tool timeout. When the receipt
 * validates, exited 0, names this exact commit and the tree has no tracked
 * change, running them again measures nothing new — the same commit, the same
 * scripts. Anything short of all of that and the scripts run as before.
 *
 * Or the same tree. A verification built from the change set names the base it
 * was prepared at, not a commit of the slice — the slice has none until it is
 * materialized — and the branch materialized from it is that build's tree to the
 * byte. Matched by commit only, every slice's first preflight ran again what its
 * verification had just run: 261 and 118 seconds on the two slices of a
 * podman-desktop issue, trees identical to the ones verified. The tree comes
 * from the verification record, which `slice verify` writes from the build.
 *
 * @param {import('./index.js').PreflightContext} context
 * @returns {Promise<{command: string, commit: string|null, tree: string|null, at: string|null, evidence: string}|null>}
 */
export function verifiedRun(context) {
  if (!verifiedRuns.has(context)) verifiedRuns.set(context, findVerifiedRun(context));
  return verifiedRuns.get(context);
}

/**
 * @param {import('./index.js').PreflightContext} context
 * @returns {Promise<{command: string, commit: string|null, tree: string|null, at: string|null, evidence: string}|null>}
 */
async function findVerifiedRun(context) {
  const verification = context.sliceRecord?.verification;
  const path = verification?.evidence;
  if (!path || !context.headSha || !context.home) return null;

  let content;
  try {
    content = await readFile(join(issueDir(context.home, context.issue), path), 'utf8');
  } catch {
    return null;
  }

  const checked = validateReceipt(content);
  if (!checked.ok || checked.exitCode !== 0) return null;

  const commit = /^- Commit: ([0-9a-f]{7,40})\s*$/m.exec(content)?.[1] ?? null;
  const sameCommit = Boolean(commit) && context.headSha.startsWith(commit);
  const sameTree =
    verification.ok === true && typeof verification.tree === 'string' && Boolean(context.tree) && verification.tree === context.tree;
  if (!sameCommit && !sameTree) return null;

  // The commit says what was verified; the scripts run the working tree. They
  // agree only when nothing tracked has changed since.
  if (!(await trackedClean(context))) return null;

  const at = /^- Completed: (\S+)\s*$/m.exec(content)?.[1] ?? null;
  return { command: checked.command, commit: sameCommit ? commit : null, tree: sameCommit ? null : verification.tree, at, evidence: path };
}

/** One `git status` per preflight run, shared by the checks that ask. */
const cleanTrees = new WeakMap();

/**
 * Whether the tree has no tracked change: what has to hold for a run measured
 * elsewhere to stand for one made here, since the scripts run what is on disk.
 *
 * @param {import('./index.js').PreflightContext} context
 * @returns {Promise<boolean>}
 */
function trackedClean(context) {
  if (!cleanTrees.has(context)) {
    cleanTrees.set(
      context,
      capture({ command: 'git status --porcelain', cwd: context.repoRoot }).then(
        (status) => status.exitCode === 0 && !status.stdout.split('\n').some((line) => line.trim() !== '' && !line.startsWith('??')),
      ),
    );
  }
  return cleanTrees.get(context);
}

/**
 * An earlier preflight run of this issue that passed these scripts on this
 * tree, when one stands for a run made now.
 *
 * A squash or a reworded message makes a new commit and keeps the tree, and
 * the scripts measure the tree. On the quickfix route that tree went through
 * the whole of preflight three times — at the end of /pd:quickfix, in
 * /pd:preflight, and in /pd:pr after its squash — two to three minutes each
 * time, saying nothing the first run had not. So the latest run on this tree
 * with nothing uncommitted decides (preflight/record.js `measuredOnTree`): a
 * pass it recorded for this check, over every script this check would run now,
 * is taken while the tree has no tracked change. A failure is never taken, and
 * neither is a pass that a red run on the same tree has since contradicted.
 *
 * @param {import('./index.js').PreflightContext} context
 * @param {string} id
 * @param {string[]} names   the scripts this check would run
 * @returns {Promise<{head: string|null, at: string|null}|null>}
 */
export async function treeRun(context, id, names) {
  if (!context.tree || !context.home || names.length === 0) return null;

  const earlier = await measuredOnTree(context.issue, { home: context.home, tree: context.tree, id });
  if (earlier?.status !== 'pass' || !earlier.scripts || !names.every((name) => earlier.scripts.includes(name))) return null;
  if (!(await trackedClean(context))) return null;

  return { head: earlier.head, at: earlier.at };
}

/**
 * Whether a verified run covered every one of these scripts.
 *
 * Matched on `run <script>` rather than on the whole step, so the package
 * manager the receipt names does not have to be spelled as this run's config
 * spells it — the script is what was measured.
 *
 * @param {{command: string}} run
 * @param {string[]} names
 * @returns {boolean}
 */
export function covers(run, names) {
  // `&&` chains a part, ` & ` sets parts side by side (`slice verify` runs lint
  // beside the typecheck and the tests); a step is either.
  const steps = run.command.split(/&&|&/).map((step) => step.trim());
  return names.length > 0 && names.every((name) => steps.some((step) => step.endsWith(` run ${name}`)));
}

/**
 * The result for a check that runs scripts, when this tree has checked out
 * another commit than the one the run is about. Null when they agree.
 *
 * The file checks read `base...ref`, and `ref` is the slice's branch whatever
 * the tree stands on. The scripts run what is on disk. In the issue's tree on
 * the branch its slices were cut from, `preflight --slice 1` would read the
 * slice's diff and run tests, lint and typecheck on the other branch, and a
 * green there says nothing about the slice. Nothing is run: a blocking `fail`
 * worded as where to run it, as `environmentFailure` is worded as the
 * environment. A slice verification that already ran the scripts on the
 * slice's commit is asked first, by the caller: that run is about the right
 * commit wherever this tree stands.
 *
 * @param {string} id
 * @param {boolean} blocking
 * @param {import('./index.js').PreflightContext} context
 * @returns {import('./index.js').CheckResult|null}
 */
export function offDisk(id, blocking, context) {
  if (!context.headSha || !context.diskSha || context.headSha === context.diskSha) return null;

  return {
    id,
    status: 'fail',
    blocking,
    summary:
      `not run: this tree has ${context.branch ?? 'a detached HEAD'} at ${context.diskSha.slice(0, 11)} checked out, ` +
      `and the run is about ${context.ref} at ${context.headSha.slice(0, 11)}`,
    remedy: `run preflight from the tree that has ${context.ref} checked out, or \`git switch ${context.ref}\` in this one first`,
  };
}

/**
 * The pass of a check whose scripts the slice verification already ran.
 *
 * @param {string} id
 * @param {boolean} blocking
 * @param {string[]} names
 * @param {{commit: string|null, tree?: string|null, at: string|null, evidence: string}} run
 * @returns {import('./index.js').CheckResult}
 */
export function passedInVerify(id, blocking, names, run) {
  // Named by what matched. A verification of the same tree, built from the
  // change set, has no commit of this slice to name — the one in its receipt is
  // the base it was prepared at, and printing it here would say the run was on
  // the base.
  const on = run.commit ? run.commit.slice(0, 11) : `the same tree (${String(run.tree ?? '').slice(0, 11)})`;
  return {
    id,
    status: 'pass',
    blocking,
    summary: `${names.join(', ')} — passed in slice verify on ${on}${run.at ? ` at ${run.at}` : ''}, not run again`,
    output: `the run is ${run.evidence} under the issue`,
    scripts: [...names],
    measured: { head: run.commit ?? null, at: run.at },
  };
}

/**
 * The pass of a check whose scripts an earlier run already passed on this tree.
 *
 * @param {string} id
 * @param {boolean} blocking
 * @param {string[]} names
 * @param {{head: string|null, at: string|null}} run   the run that measured it
 * @returns {import('./index.js').CheckResult}
 */
export function passedOnTree(id, blocking, names, run) {
  return {
    id,
    status: 'pass',
    blocking,
    summary: `${names.join(', ')} — passed on ${run.head ? run.head.slice(0, 11) : 'an unrecorded commit'}${run.at ? ` at ${run.at}` : ''}, the same tree, not run again`,
    output: 'the run is in preflight.json under the issue',
    scripts: [...names],
    measured: { head: run.head, at: run.at },
  };
}
