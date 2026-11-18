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

// Tests for lib/hooks/prompt-submit.js.
//
// The case it exists for is DESKTOP-18915's: a tree on issue A's branch, a
// command typed for issue B, and B's work in a worktree beside it. What is
// asserted is that the context then names both trees and tells Claude to move
// the session with EnterWorktree — and that every other prompt gets nothing at
// all, because the hook runs on every message and a line on each would be read
// as noise.
//
// The main checkout is never an issue's tree, even on that issue's branch: a
// command typed there is told how to move the branch out and where to go.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import plugin from '../opencode/server.js';
import { WIRING } from '../opencode/bridge/hooks.js';
import { LABEL_SOURCE, promptSubmit as promptSubmitPayloads } from '../opencode/bridge/payload.js';
import { PLUGIN_ROOT, issueDir } from '../lib/config.js';
import { FAIL_CLOSED, HOOK_HANDLERS } from '../lib/hooks/events.js';
import { argumentKind, handle, parseCommand } from '../lib/hooks/prompt-submit.js';
import { escapeRegExp as esc } from '../lib/globs.js';
import { transition } from '../lib/state.js';

const execFileAsync = promisify(execFile);
const git = (args, cwd) => execFileAsync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd });

const HERE = 18967;
const AWAY = 18915;
const PARKED = 18833;

let home;
let base;
let MAIN;
let AWAY_TREE;
const savedHome = process.env.PDKIT_HOME;

const context = () => ({ event: 'prompt-submit', pluginRoot: PLUGIN_ROOT });
const submit = (prompt, cwd = MAIN) => handle({ prompt, cwd }, context());

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'pdkit-prompt-'));
  base = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-prompt-repo-')));
  process.env.PDKIT_HOME = home;

  // The main checkout left on one issue's branch, a registered worktree for
  // another, and a third issue whose branch is checked out nowhere.
  MAIN = join(base, 'podman-desktop');
  AWAY_TREE = join(base, `DESKTOP-${AWAY}`);
  await mkdir(MAIN);
  await git(['init', '-q', '-b', 'main'], MAIN);
  await git(['commit', '-q', '--allow-empty', '-m', 'init'], MAIN);
  await git(['branch', `DESKTOP-${PARKED}/1-store-image-info-ui`], MAIN);
  await git(['switch', '-q', '-c', `DESKTOP-${HERE}/1-fix-main-event-stream-reconnect`], MAIN);
  await git(['worktree', 'add', '-q', '-b', `DESKTOP-${AWAY}/1-quit-and-install-race`, AWAY_TREE, 'main'], MAIN);

  await transition(AWAY, 'triaged', { home });
});

after(async () => {
  if (savedHome === undefined) delete process.env.PDKIT_HOME;
  else process.env.PDKIT_HOME = savedHome;

  for (const dir of [home, base]) await rm(dir, { recursive: true, force: true });
});

describe('reading the command', () => {
  test('as typed', () => {
    assert.deepEqual(parseCommand('/pd:preflight 18915'), { skill: 'preflight', number: 18915 });
    assert.deepEqual(parseCommand('  /pd:pr 18915 2\nand the body'), { skill: 'pr', number: 18915 });
    assert.deepEqual(parseCommand('/pd:pr-sync #19750'), { skill: 'pr-sync', number: 19750 });
  });

  test('as the host expands it', () => {
    const expanded = '<command-message>pd:preflight</command-message>\n<command-name>/pd:preflight</command-name>\n<command-args>18915</command-args>';
    assert.deepEqual(parseCommand(expanded), { skill: 'preflight', number: 18915 });
  });

  test('and nothing else', () => {
    for (const prompt of ['почини preflight для 18915', '/pd:pr-status', '/pd:triage --label kind/bug', 'see /pd:preflight 18915', '/clear']) {
      assert.equal(parseCommand(prompt), null, prompt);
    }
  });

  // Read from the skills' argument-hint, so a skill that changes what it takes
  // changes what the hook does without a list here to forget.
  test('an issue or a pull request, by what the skill says it takes', () => {
    assert.equal(argumentKind('<issue-number>'), 'issue');
    assert.equal(argumentKind('<issue-number> [slice]'), 'issue');
    assert.equal(argumentKind('[<issue-number|url>] [--label <a,b>]'), 'issue');
    assert.equal(argumentKind('<pr-number>'), 'pr');
    assert.equal(argumentKind(null), null);
    assert.equal(argumentKind('<anything-else>'), null);
  });
});

describe('a command for one issue, typed in another issue\'s tree', () => {
  test('names both trees and tells the session to move into the issue\'s', async () => {
    const decision = await submit(`/pd:preflight ${AWAY}`);

    assert.equal(decision.block, false);
    assert.match(decision.message, /\/pd:preflight is about issue 18915 — triaged, and this tree is not its/);
    assert.match(
      decision.message,
      new RegExp(`here {4}: ${esc(MAIN)} on DESKTOP-${HERE}/1-fix-main-event-stream-reconnect — the main checkout — issue ${HERE}'s`),
    );
    assert.match(decision.message, new RegExp(`${AWAY} {3}: ${esc(AWAY_TREE)} on DESKTOP-${AWAY}/1-quit-and-install-race`));
    assert.match(decision.message, new RegExp(`Call the EnterWorktree tool with path: ${esc(AWAY_TREE)}$`, 'm'));
    // The tree exists: nothing to run first.
    assert.doesNotMatch(decision.message, /pdkit worktree create|git -C/);
  });

  test('a branch checked out nowhere is named, with how to get a tree for it', async () => {
    const decision = await submit(`/pd:slice ${PARKED}`);

    assert.match(decision.message, new RegExp(`DESKTOP-${PARKED}/1-store-image-info-ui, a local branch checked out nowhere`));
    assert.match(decision.message, new RegExp(`^ +pdkit worktree create --issue ${PARKED} --branch DESKTOP-${PARKED}/1-store-image-info-ui$`, 'm'));
    assert.match(decision.message, new RegExp(`EnterWorktree tool with path: ${esc(join(base, 'pd-worktrees', `DESKTOP-${PARKED}`))}$`, 'm'));
    // Only the main checkout's own branch is switched away from, never this one.
    assert.doesNotMatch(decision.message, /git -C/);
    // No record for it: the line says nothing it does not know.
    assert.doesNotMatch(decision.message, new RegExp(`${PARKED} — `));
  });

  // The way /pd:pr-sync arrives: a pull request number, mapped through the
  // record pdkit keeps of what it published.
  test('a pull request of ours is followed to its issue', async () => {
    await writeFile(join(issueDir(home, AWAY), 'prs.json'), JSON.stringify({ prs: [{ number: 19750, slice: 1 }] }));
    try {
      const decision = await submit('/pd:pr-sync 19750');
      assert.match(decision.message, /\/pd:pr-sync is about issue 18915/);
      assert.match(decision.message, new RegExp(`EnterWorktree tool with path: ${esc(AWAY_TREE)}$`, 'm'));
    } finally {
      await rm(join(issueDir(home, AWAY), 'prs.json'), { force: true });
    }
  });
});

// After slicing, the branch the slices were cut from is still there, and by
// name it ranks before theirs. The tree the hook offers for a resume is the
// pull request's.
describe('an issue under review, with the branch its slices were cut from beside', () => {
  const REVIEWED = 4242;
  before(async () => {
    await git(['branch', `DESKTOP-${REVIEWED}/before-slicing`, 'main'], MAIN);
    await git(['branch', `DESKTOP-${REVIEWED}/1-under-review`, 'main'], MAIN);
    await mkdir(issueDir(home, REVIEWED), { recursive: true });
    await writeFile(
      join(issueDir(home, REVIEWED), 'prs.json'),
      JSON.stringify({ prs: [{ number: 4001, slice: 1, branch: `DESKTOP-${REVIEWED}/1-under-review`, state: 'open' }] }),
    );
  });

  test('the tree to make is on the pull request\'s branch', async () => {
    const decision = await submit(`/pd:resume ${REVIEWED}`);

    assert.match(decision.message, new RegExp(`DESKTOP-${REVIEWED}/1-under-review, a local branch checked out nowhere`));
    const steps = decision.message.split('\n').filter((line) => /^ {7}\S/.test(line)).map((line) => line.trim());
    assert.deepEqual(steps, [`pdkit worktree create --issue ${REVIEWED} --branch DESKTOP-${REVIEWED}/1-under-review`]);
    assert.doesNotMatch(decision.message, /before-slicing/);
  });
});

// A tree made before the pull request, still on the branch the slices were cut
// from: the issue's tree, and everything done in it misses the pull request.
describe('the issue\'s tree on another branch than its open pull request', () => {
  const STALE = 4343;
  const CUT_FROM = `DESKTOP-${STALE}/before-slicing`;
  const UNDER_REVIEW = `DESKTOP-${STALE}/1-under-review`;
  let tree;

  before(async () => {
    tree = join(base, 'pd-worktrees', `DESKTOP-${STALE}`);
    await git(['branch', UNDER_REVIEW, 'main'], MAIN);
    await git(['worktree', 'add', '-q', '-b', CUT_FROM, tree, 'main'], MAIN);
    await mkdir(issueDir(home, STALE), { recursive: true });
    await writeFile(join(issueDir(home, STALE), 'prs.json'), JSON.stringify({ prs: [{ number: 4002, slice: 1, branch: UNDER_REVIEW, state: 'open' }] }));
  });

  const steps = (message) => message.split('\n').filter((line) => /^ {7}\S/.test(line)).map((line) => line.trim());

  test('from the main checkout: switch the tree, then move the session into it', async () => {
    const decision = await submit(`/pd:resume ${STALE}`);

    assert.match(decision.message, new RegExp(`The tree is on ${esc(CUT_FROM)}, and the open pull request is on ${esc(UNDER_REVIEW)}`));
    assert.match(decision.message, new RegExp(`git -C ${esc(tree)} status`));
    assert.deepEqual(steps(decision.message), [`git -C ${tree} switch ${UNDER_REVIEW}`]);
    assert.match(decision.message, new RegExp(`EnterWorktree tool with path: ${esc(tree)}$`, 'm'));
  });

  test('from inside it: the hook is no longer quiet', async () => {
    const decision = await submit(`/pd:resume ${STALE}`, tree);

    assert.match(decision.message, new RegExp(`this tree is on ${esc(CUT_FROM)} — its open pull request is on ${esc(UNDER_REVIEW)}`));
    assert.deepEqual(steps(decision.message), [`git -C ${tree} switch ${UNDER_REVIEW}`]);
    assert.doesNotMatch(decision.message, /EnterWorktree/);
  });

  test('with the pull request\'s branch in another tree, the session is sent there by way of the fork', async () => {
    const reviewing = join(base, 'pd-worktrees', `DESKTOP-${STALE}-2`);
    await git(['worktree', 'add', '-q', reviewing, UNDER_REVIEW], MAIN);
    try {
      const inside = await submit(`/pd:resume ${STALE}`, tree);
      assert.match(inside.message, new RegExp(`${esc(UNDER_REVIEW)} is checked out in ${esc(reviewing)}`));
      assert.match(inside.message, /end this session and start claude in the main checkout/);
      assert.deepEqual(steps(inside.message), []);

      const fromFork = await submit(`/pd:resume ${STALE}`);
      assert.match(fromFork.message, new RegExp(`EnterWorktree tool with path: ${esc(reviewing)}$`, 'm'));
      assert.doesNotMatch(fromFork.message, /git -C \S+ switch/);
    } finally {
      await git(['worktree', 'remove', '--force', reviewing], MAIN);
    }
  });

  test('on the pull request\'s branch, quiet again', async () => {
    await git(['switch', '-q', UNDER_REVIEW], tree);
    try {
      assert.equal((await submit(`/pd:resume ${STALE}`, tree)).message, undefined);
    } finally {
      await git(['switch', '-q', CUT_FROM], tree);
    }
  });
});

// DESKTOP-18915 once more: the pull request's branch left in the main checkout
// by `slice materialize`, and the review round committed beside the worktree.
describe('the main checkout on the issue\'s own branch', () => {
  test('is not the issue\'s tree: the branch moves out, then the session follows', async () => {
    const decision = await submit(`/pd:audit ${HERE}`);

    assert.match(decision.message, /\/pd:audit is about issue 18967, and this tree is not its/);
    assert.match(decision.message, new RegExp(`DESKTOP-${HERE}/1-fix-main-event-stream-reconnect, held by the main checkout`));
    const steps = decision.message.split('\n').filter((line) => /^ {7}\S/.test(line)).map((line) => line.trim());
    assert.deepEqual(steps, [
      `git -C ${MAIN} switch main`,
      `pdkit worktree create --issue ${HERE} --branch DESKTOP-${HERE}/1-fix-main-event-stream-reconnect`,
    ]);
    assert.match(decision.message, /Show the person these commands and run them once they agree/);
    assert.match(decision.message, new RegExp(`EnterWorktree tool with path: ${esc(join(base, 'pd-worktrees', `DESKTOP-${HERE}`))}$`, 'm'));
  });
});

// DESKTOP-19818: /pd:exec typed in the main checkout of an issue that had no
// tree, and T1 committed there on a branch the session named itself.
describe('/pd:exec for an issue with no tree yet', () => {
  let FRESH;
  before(async () => {
    FRESH = join(base, 'fresh-clone');
    await mkdir(FRESH);
    await git(['init', '-q', '-b', 'main'], FRESH);
    await git(['commit', '-q', '--allow-empty', '-m', 'init'], FRESH);
  });

  test('from the main checkout: create the tree, then move the session into it', async () => {
    const decision = await submit('/pd:exec 19818', FRESH);

    assert.match(decision.message, /\/pd:exec writes DESKTOP-19818's code in its own tree, and there is none yet/);
    assert.match(decision.message, /the main checkout, a template for the trees/);
    const steps = decision.message.split('\n').filter((line) => /^ {7}\S/.test(line)).map((line) => line.trim());
    assert.deepEqual(steps, ['pdkit worktree create --issue 19818 --slug <a few words of the issue title>']);
    assert.match(decision.message, new RegExp(`EnterWorktree tool with path: ${esc(join(base, 'pd-worktrees', 'DESKTOP-19818'))}$`, 'm'));
  });

  test('from a tree on another issue\'s branch, the tree to make is still this one\'s', async () => {
    const decision = await submit('/pd:exec 19818');
    assert.match(decision.message, /pdkit worktree create --issue 19818/);
  });

  test('a skill that does not write code still starts anywhere', async () => {
    assert.equal((await submit('/pd:plan 19818', FRESH)).message, undefined);
  });
});

describe('everything else is quiet', () => {
  test('the issue\'s own tree', async () => {
    assert.equal((await submit(`/pd:preflight ${AWAY}`, AWAY_TREE)).message, undefined);
  });

  test('an issue nothing names yet', async () => {
    assert.equal((await submit('/pd:triage 11111')).message, undefined);
  });

  test('somebody else\'s pull request', async () => {
    assert.equal((await submit('/pd:review-pr 19001')).message, undefined);
  });

  test('a skill whose argument is not a number of ours', async () => {
    assert.equal((await submit(`/pd:knowledge ${AWAY}`)).message, undefined);
  });

  test('plain text, and a payload with no prompt', async () => {
    assert.equal((await submit(`what is left on ${AWAY}?`)).message, undefined);
    assert.deepEqual(await handle({ cwd: MAIN }, { event: 'prompt-submit', pluginRoot: PLUGIN_ROOT }), { block: false });
    assert.deepEqual(await handle(null, { event: 'prompt-submit', pluginRoot: PLUGIN_ROOT }), { block: false });
  });

  // `user_prompt` is the name plugin-dev material uses; reading it too costs nothing.
  test('the other name for the prompt is read the same way', async () => {
    const decision = await handle({ user_prompt: `/pd:preflight ${AWAY}`, cwd: MAIN }, context());
    assert.match(decision.message, /EnterWorktree/);
  });
});

// The cases above on Open Code's form. Open Code's prompt hook never sees what the
// person typed (F76): a pdkit command labels the prompt it sends with its name
// and arguments (D6), and the hook bridge puts `/pd:<skill> <arguments>` back
// together from the label and runs this handler on it, through bin/pdkit, in
// the directory of the plugin instance the hook is called in — the session's
// (F75). What the handler says reaches the model as a text file attached to
// the prompt (F79; the person sees its name, §13 DV11). So each case above is
// asserted again this way: the attached text is the message handle() gives
// for the command as typed, and nothing is attached where it is quiet.
describe('in Open Code: the prompt a pdkit command sends, through the hook bridge', () => {
  const REVIEWED = 4242;
  const STALE = 4343;
  const SESSION = 'ses_person';

  /** A session that has run: session-start, on the same hook, leaves its prompts alone (F270). */
  const ran = (directory) => ({
    id: SESSION,
    projectID: 'global',
    outcome: 'succeeded',
    time: { created: 1794850025467, updated: 1794850025924, busy: 1794850025888, idle: 1794850025921 },
    location: { directory },
  });

  /**
   * A stand-in for setup()'s context in `directory`: just enough for the entry
   * point to load in full. A point runs every callback registered on it, in
   * order, on the one event, as Open Code 2.3.0 does (src/plugin/hooks.ts).
   */
  const host = (directory) => {
    const hooks = new Map();
    const callbacks = new Map();
    const registered = { dispose: async () => {} };
    const transforms = { transform: async () => registered };
    const ctx = {
      app: { name: 'cli', version: '2.3.0', channel: 'latest' },
      location: { directory, project: { id: 'global', directory, canonical: directory } },
      tool: { hook: async () => registered },
      session: {
        hook: async (name, callback) => {
          callbacks.set(name, [...(callbacks.get(name) ?? []), callback]);
          hooks.set(name, async (event) => {
            const answers = [];
            for (const each of callbacks.get(name)) answers.push(await each(event));
            return answers.find((answer) => answer !== undefined);
          });
          return registered;
        },
        get: async () => ran(directory),
        instructions: { entry: { put: async () => {}, remove: async () => {}, list: async () => [] } },
      },
      shell: { hook: async () => registered },
      permission: { hook: async () => registered },
      agent: transforms,
      command: transforms,
      skill: transforms,
      event: { subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }) },
    };
    return { ctx, hooks };
  };

  /** The prompt hook's event for what a pdkit command sends: the text its execute built, and its label. */
  const sent = (command, args) => ({
    sessionID: SESSION,
    messageID: 'msg_test',
    prompt: { text: `The ${command} template, as its execute expanded it.`, files: [], agents: [] },
    metadata: { source: 'opencode-pdkit', command, arguments: args },
    delivery: 'steer',
  });

  /** The texts the bridge attached to a prompt. */
  const attached = (event) =>
    (event.prompt.files ?? [])
      .filter((file) => file.name === 'pdkit-context')
      .map((file) => Buffer.from(file.uri.replace(/^data:text\/plain;base64,/, ''), 'base64').toString('utf8'));

  /**
   * The command through the plugin loaded in `cwd`, and through handle() as
   * typed, at the same moment; what the server's log got besides.
   */
  const both = async (t, command, args, cwd) => {
    const error = t.mock.method(console, 'error', () => {});
    const { ctx, hooks } = host(cwd);
    const cleanup = await plugin.setup(ctx);
    t.after(() => cleanup?.());

    const event = sent(command, args);
    assert.equal(await hooks.get('prompt')(event), undefined);
    const typed = await handle({ prompt: `/${command} ${args}`.trimEnd(), cwd }, context());
    return { event, texts: attached(event), message: typed.message, log: error.mock.calls.map((entry) => entry.arguments.join(' ')) };
  };

  const withPullRequest = async () => {
    await writeFile(join(issueDir(home, AWAY), 'prs.json'), JSON.stringify({ prs: [{ number: 19750, slice: 1 }] }));
    return () => rm(join(issueDir(home, AWAY), 'prs.json'), { force: true });
  };

  const SAYS = [
    ["a command for one issue, typed in another issue's tree (HK-24)", 'pd:preflight', `${AWAY}`, () => MAIN],
    ['a branch checked out nowhere (HK-24)', 'pd:slice', `${PARKED}`, () => MAIN],
    ['a pull request of ours, followed to its issue (HK-24)', 'pd:pr-sync', '19750', () => MAIN, withPullRequest],
    ["the tree to make is on the pull request's branch (HK-40)", 'pd:resume', `${REVIEWED}`, () => MAIN],
    ["the issue's tree on another branch than its pull request, from the main checkout (HK-40)", 'pd:resume', `${STALE}`, () => MAIN],
    ["the issue's tree on another branch than its pull request, from inside it (HK-40)", 'pd:resume', `${STALE}`, () => join(base, 'pd-worktrees', `DESKTOP-${STALE}`)],
    ["the main checkout on the issue's own branch (HK-24)", 'pd:audit', `${HERE}`, () => MAIN],
    ['/pd:exec for an issue with no tree yet, from the main checkout (HK-39)', 'pd:exec', '19818', () => join(base, 'fresh-clone')],
    ["/pd:exec for an issue with no tree yet, from another issue's tree (HK-39)", 'pd:exec', '19818', () => MAIN],
  ];

  for (const [label, command, args, cwd, arrange] of SAYS) {
    test(`${label}: the context goes with the prompt`, async (t) => {
      const undo = await arrange?.();
      try {
        const { event, texts, message, log } = await both(t, command, args, cwd());

        assert.ok(message, 'handle() has something to say here');
        assert.deepEqual(texts, [message]);
        assert.deepEqual(log, []);
        // What the person typed is theirs: the prompt's text, and the label.
        assert.equal(event.prompt.text, sent(command, args).prompt.text);
        assert.deepEqual(event.metadata, sent(command, args).metadata);
      } finally {
        await undo?.();
      }
    });
  }

  const QUIET = [
    ["the issue's own tree", 'pd:preflight', `${AWAY}`, () => AWAY_TREE],
    ['an issue nothing names yet', 'pd:triage', '11111', () => MAIN],
    ["somebody else's pull request", 'pd:review-pr', '19001', () => MAIN],
    ['a skill whose argument is not a number of ours', 'pd:knowledge', `${AWAY}`, () => MAIN],
    ['a skill that does not write code, for an issue with no tree', 'pd:plan', '19818', () => join(base, 'fresh-clone')],
    ['a command that takes no number', 'pd:pr-status', '', () => MAIN],
  ];

  for (const [label, command, args, cwd] of QUIET) {
    test(`${label}: nothing is attached`, async (t) => {
      const { event, texts, message, log } = await both(t, command, args, cwd());

      assert.equal(message, undefined);
      assert.deepEqual(texts, []);
      assert.deepEqual(event.prompt.files, []);
      assert.deepEqual(log, []);
    });
  }

  // The meaning, once, in Open Code's words for the person's input: the tree,
  // the issue's, and where to go.
  test('the attached text names both trees and where the session goes', async (t) => {
    const { texts } = await both(t, 'pd:preflight', `${AWAY}`, MAIN);
    assert.match(texts[0], /\/pd:preflight is about issue 18915 — triaged, and this tree is not its/);
    assert.match(texts[0], new RegExp(`EnterWorktree tool with path: ${esc(AWAY_TREE)}$`, 'm'));
  });

  // A `/pd:` line that arrives as text was not run as a command — what
  // `opencode run` sends (F78) — and the hook looks at nothing unlabeled (D6).
  test('the same line as text, without the label, gets nothing', async (t) => {
    const error = t.mock.method(console, 'error', () => {});
    const { ctx, hooks } = host(MAIN);
    const cleanup = await plugin.setup(ctx);
    t.after(() => cleanup?.());

    const event = { sessionID: SESSION, messageID: 'msg_test', prompt: { text: `/pd:preflight ${AWAY}` }, metadata: null, delivery: 'steer' };
    await hooks.get('prompt')(event);

    assert.deepEqual(event.prompt, { text: `/pd:preflight ${AWAY}` });
    assert.deepEqual(error.mock.calls, []);
  });
});

// The wiring, which a direct call to handle() cannot prove — the lesson of the
// receipt gate that sat on an event subagents never raise. The plugin stands
// the event on Open Code's prompt hook (opencode/bridge/hooks.js, WIRING), and
// test/opencode-wiring.test.js runs it from there to this module.
describe('the hook is registered on the prompt', () => {
  test('the prompt hook runs this module, and nothing else does', () => {
    const points = Object.entries(WIRING)
      .filter(([event]) => HOOK_HANDLERS[event] === 'prompt-submit.js')
      .flatMap(([, rows]) => rows.map((row) => row.point));

    assert.deepEqual(points, ['session prompt']);
  });

  // No matcher: Open Code calls the hook on every prompt, and the bridge
  // narrows it to a pdkit command's by the label the command puts on it (D6),
  // never to some of the commands.
  test('for the prompt of any pdkit command', async () => {
    const skills = (await readdir(join(PLUGIN_ROOT, 'skills'), { withFileTypes: true })).filter((entry) => entry.isDirectory());
    assert.ok(skills.length > 0);
    for (const { name } of skills) {
      const metadata = { source: LABEL_SOURCE, command: `pd:${name}`, arguments: `${AWAY}` };
      const payloads = promptSubmitPayloads({ sessionID: 'ses_1', metadata }, { directory: MAIN });

      assert.equal(payloads.length, 1, `the prompt of /pd:${name} is not looked at`);
      assert.equal(payloads[0].prompt, `/pd:${name} ${AWAY}`);
    }
  });

  // A block on this event discards what the person typed.
  test('and a handler that cannot run lets the prompt through', () => {
    assert.ok(!FAIL_CLOSED.includes('prompt-submit'));
  });

  /** The hook through bin/pdkit. */
  const viaBinary = (payload) =>
    new Promise((resolve) => {
      const env = { ...process.env, PDKIT_HOME: home };
      const child = spawn('node', [join(PLUGIN_ROOT, 'bin', 'pdkit'), 'hook', 'prompt-submit'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.on('exit', (code) => resolve({ code, stdout }));
      child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', ...payload }));
    });

  test('through the binary, the message reaches stdout and the exit is 0', async () => {
    const run = await viaBinary({ prompt: `/pd:preflight ${AWAY}`, cwd: MAIN });

    assert.equal(run.code, 0);
    assert.match(run.stdout, new RegExp(`${esc(AWAY_TREE)} on DESKTOP-${AWAY}/1-quit-and-install-race`));
  });
});
