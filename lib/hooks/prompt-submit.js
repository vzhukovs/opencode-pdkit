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

// UserPromptSubmit handler.
//
// One question: which issue is this turn about, and does the tree agree. The
// number exists in exactly one place — the command the person typed — and no
// other hook sees it. SessionStart fires on /clear, before the prompt, so the
// best it can do on an ambiguous disk is say it does not know; this is where
// the answer arrives.
//
// Found on DESKTOP-18915: every session after plan-approved opened in a main
// checkout standing on 18967's branch, and the first answer took
// `/pd:preflight 18915` for a typo, because everything in its context was
// about 18967.
//
// The contract, because this is the one hook that reads what a person types:
//   - only a `/pd:<skill> <number>` command is looked at, and only when the
//     skill's argument-hint says the number is an issue or a pull request;
//   - nothing is written — no state, no journal, no file in $PDKIT_HOME;
//   - it never blocks. On this event a block discards the prompt, and a plugin
//     that eats what somebody typed is one they uninstall;
//   - everything else returns before any git call or file read, because it
//     runs on every prompt and its cost is added to every message.

import { join } from 'node:path';

import { resolveHome } from '../config.js';
import { MOVE_TOOL, moveCall } from '../harness.js';

/**
 * The `/pd:` command at the start of a prompt, as the host delivers it.
 *
 * Two shapes, because the transcript holds a slash command expanded into tags
 * and the raw line is what a person typed; which one the hook receives is the
 * host's business, and both say the same thing.
 */
const TYPED = /^\s*\/pd:([a-z][a-z-]*)[ \t]+#?(\d+)\b/;
const EXPANDED = /<command-name>\/?pd:([a-z][a-z-]*)<\/command-name>[\s\S]*?<command-args>\s*#?(\d+)\b/;

/**
 * Read the skill and its number from a prompt, or null when it is not a
 * `/pd:` command with a number.
 *
 * @param {string} prompt
 * @returns {{skill: string, number: number}|null}
 */
export function parseCommand(prompt) {
  const match = TYPED.exec(prompt) ?? EXPANDED.exec(prompt);
  if (!match) return null;
  return { skill: match[1], number: Number.parseInt(match[2], 10) };
}

/**
 * What a skill's argument is, from its argument-hint, or null when it takes
 * neither an issue nor a pull request number first.
 *
 * `/pd:triage` writes it optional (`[<issue-number|url>]`), and that is still
 * an issue number when one is given.
 *
 * @param {string|null} hint
 * @returns {'issue'|'pr'|null}
 */
export function argumentKind(hint) {
  if (!hint) return null;
  if (/^\[?<issue-number\b/.test(hint)) return 'issue';
  if (/^\[?<pr-number\b/.test(hint)) return 'pr';
  return null;
}

/**
 * Move the session to the issue named in the prompt, when it is not in that
 * issue's tree.
 *
 * Quiet on every other outcome. The tree being the issue's is the normal case
 * and SessionStart has already described it; an issue that nothing names yet
 * leaves nowhere to point, and the command itself will say what to create.
 * A pull request number that is not registered under any issue — somebody
 * else's, for `/pd:review-pr` — is not about an issue of ours at all.
 *
 * @param {object|null} payload
 * @param {{event: string, pluginRoot: string}} context
 * @returns {Promise<import('./dispatch.js').Decision & {message?: string}>}
 */
export async function handle(payload, context) {
  // `prompt` is the documented field; `user_prompt` is the name older plugin
  // material uses. Reading both costs nothing and survives either.
  const prompt = payload?.prompt ?? payload?.user_prompt;
  if (typeof prompt !== 'string') return { block: false };

  const command = parseCommand(prompt);
  if (!command) return { block: false };

  // Loaded here rather than at the top: everything above runs on every prompt,
  // and git and the state directory are only worth touching for a command.
  const message = await treeMessage(command, payload, context);
  return message ? { block: false, message } : { block: false };
}

/**
 * The skills whose work is commits on the issue's branch, so the tree has to
 * exist before they start rather than be found missing at the first task.
 */
const WRITES_IN_TREE = new Set(['exec']);

/**
 * Where the issue named in the command lives, as context for Claude, or null
 * when the tree is the issue's or the command names no issue of ours.
 *
 * @param {{skill: string, number: number}} command  what parseCommand read from the prompt
 * @param {object|null} payload
 * @param {{pluginRoot: string}} context
 * @returns {Promise<string|null>}
 */
async function treeMessage(command, payload, context) {
  const { skillArgument } = await import('../session-model.js');
  const kind = argumentKind(await skillArgument(command.skill, context.pluginRoot || undefined));
  if (!kind) return null;

  const home = resolveHome();
  let issue = command.number;
  if (kind === 'pr') {
    const { issueOf } = await import('../pr.js');
    const found = await issueOf(command.number, { home }).catch(() => null);
    if (found === null) return null;
    issue = found;
  }

  const cwd = payload?.cwd ?? process.cwd();
  const { enterDirections, forIssue, rootFor } = await import('../worktree.js');
  const { openBranches } = await import('../pr.js');
  const recorded = await openBranches(issue, { home }).catch(() => []);
  const tree = await forIssue({ issue, cwd, recorded });

  // Nothing names the issue yet, which every other skill may start from: an
  // investigation, a plan. Not the ones that write the code. On DESKTOP-19818
  // /pd:exec ran in the main checkout and committed there, because nothing
  // said the tree had to exist before the first task. Standing on another
  // issue's branch is the same case: the tree to make is still this one's.
  if (!tree.home && tree.verdict !== 'ours' && WRITES_IN_TREE.has(command.skill)) {
    const { load } = await import('../config.js');
    const root = await rootFor({ repoRoot: tree.here.path, config: await load({ repoRoot: tree.here.path }) });
    return [
      `pdkit: /pd:${command.skill} writes DESKTOP-${issue}'s code in its own tree, and there is none yet.`,
      `  here    : ${tree.here.path} on ${tree.here.branch ?? 'a detached HEAD'}${tree.here.main ? ' — the main checkout, a template for the trees' : ''}`,
      ...entering(
        { path: join(root, `DESKTOP-${issue}`), steps: [`pdkit worktree create --issue ${issue} --slug <a few words of the issue title>`] },
        issue,
      ),
    ].join('\n');
  }

  if (tree.verdict === 'ours' && tree.stale) return staleMessage(command.skill, issue, tree.stale, tree.here);
  if (tree.verdict !== 'foreign' || !tree.home) return null;

  const { read: readState } = await import('../state.js');
  const record = await readState(issue, { home }).catch(() => null);
  const status = record?.createdAt ? ` — ${record.state}${record.route ? `, ${record.route}` : ''}` : '';

  const here = `${tree.here.path} on ${tree.here.branch ?? 'a detached HEAD'}`;
  const where = {
    worktree: `${tree.home.path} on ${tree.home.branch ?? 'a detached HEAD'}`,
    checkout: `${tree.home.branch}, held by the main checkout — a template, not a tree to work in`,
    branch: `${tree.home.branch}, a local branch checked out nowhere`,
  }[tree.home.source];

  const lines = [
    `pdkit: /pd:${command.skill} is about issue ${issue}${status}, and this tree is not its.`,
    `  here    : ${here}${tree.here.main ? ' — the main checkout' : ''}${tree.here.issue === null ? '' : ` — issue ${tree.here.issue}'s`}`,
    `  ${String(issue).padEnd(8)}: ${where}`,
    ...entering(await enterDirections(tree).catch(() => null), issue),
  ];

  return lines.join('\n');
}

/**
 * The session is in the issue's tree, and the tree is not on the issue's open
 * pull request's branch.
 *
 * Quiet before this: the tree is the issue's, so nothing looked wrong. But a
 * tree made before the pull request — detached, or on the branch its slices
 * were cut from — takes every commit beside the pull request, and the push
 * after a review round carries none of them. The switch is shown, not run: it
 * moves the tree, which is the person's to agree to.
 *
 * @param {string} skill
 * @param {number} issue
 * @param {import('../worktree.js').Stale} stale
 * @param {{path: string}} here
 * @returns {Promise<string>}
 */
async function staleMessage(skill, issue, stale, here) {
  const lines = [
    `pdkit: /pd:${skill} is about issue ${issue}, and this tree is on ${stale.branch ?? 'a detached HEAD'} — its open pull request is on ${stale.wanted}.`,
  ];

  if (stale.heldBy && !stale.heldBy.main) {
    // The way there is a new session from the fork, which the hook then moves
    // into that tree: a session goes from the fork into one issue's tree and
    // works there. Open Code would move it from one tree straight to another,
    // which Claude Code could not, and the way stayed the one it was.
    lines.push(
      `  ${stale.wanted} is checked out in ${stale.heldBy.path}, and that tree is where the review is.`,
      '  Do not run the command here. Tell the person to end this session and start opencode in the main checkout;',
      `  the next /pd:${skill} ${issue} moves it into ${stale.heldBy.path}.`,
    );
    return lines.join('\n');
  }

  const { load } = await import('../config.js');
  const { switchSteps } = await import('../worktree.js');
  const steps = switchSteps(stale, await load({ repoRoot: here.path }));
  lines.push(
    '  Before anything else, put this tree on the pull request\'s branch. Do not run the command on this one.',
    `  Check that \`git -C ${stale.path} status\` shows nothing uncommitted, show the person these commands and run them once they agree:`,
    ...steps.map((step) => `       ${step}`),
    '  Then carry on with the command as typed.',
  );
  return lines.join('\n');
}

/**
 * The instruction that moves the session, as message lines.
 *
 * An instruction, not a pointer, because a pointer was what this hook gave
 * before and the session carried on where it stood: the commands refuse in the
 * wrong tree, but subagents edit files wherever the session is, and on
 * DESKTOP-18915 that was the main checkout. The plugin the person installed is
 * the one telling the model to switch. Commands that change a checkout are
 * shown before they run: they move a branch, and that is the person's to agree
 * to.
 *
 * @param {{path: string, steps: string[]}|null} directions
 * @param {number} issue
 * @returns {string[]}
 */
function entering(directions, issue) {
  if (!directions) return [`  Work on ${issue} from its own tree; commands that take ${issue} refuse here. The issue number is not a typo.`];

  const lines = ['  Before anything else, move this session into the issue\'s tree. Do not cd, and do not run the command here.'];
  if (directions.stale) {
    const { stale } = directions;
    lines.push(
      `  1. The tree is on ${stale.branch ?? 'a detached HEAD'}, and the open pull request is on ${stale.wanted}. ` +
        `Check that \`git -C ${stale.path} status\` shows nothing uncommitted, show the person these commands and run them once they agree:`,
    );
    for (const step of directions.steps) lines.push(`       ${step}`);
    lines.push(`  2. Call the ${MOVE_TOOL} tool with ${moveCall(directions.path)}`);
  } else if (directions.steps.length > 0) {
    lines.push('  1. The tree does not exist yet. Show the person these commands and run them once they agree:');
    for (const step of directions.steps) lines.push(`       ${step}`);
    lines.push(`  2. Call the ${MOVE_TOOL} tool with ${moveCall(directions.path)}`);
  } else {
    lines.push(`  Call the ${MOVE_TOOL} tool with ${moveCall(directions.path)}`);
  }
  lines.push('  Subagents started after the switch work there too. Then carry on with the command as typed.');
  return lines;
}
