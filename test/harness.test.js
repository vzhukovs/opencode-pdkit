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

// Tests for lib/harness.js: telling this harness's journal entries from the
// other's, and the call that moves a session.
//
// The journal is shared with the Claude Code version of the plugin, and the
// doctor's agent-done check reads it to see whether the subagent hook is
// alive here. An entry the other harness wrote must not count: weeks of them
// would keep the check green while the hook in Open Code never ran.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MOVE_TOOL, isOwnRun, moveCall } from '../lib/harness.js';
import { append, read } from '../lib/journal.js';
import { handle } from '../lib/hooks/task-completed.js';

const agentDone = (detail) => ({ at: '2026-11-18T10:00:00Z', issue: 1, slice: null, event: 'agent-done', detail });

describe('an agent-done of this harness', () => {
  // Open Code's session IDs, as the bridge passes a subagent's run (F91).
  const RUN = 'ses_e1ab4dbd8ffeAGRhkvVT6EWLR0';

  test('is one whose run is an Open Code session, whatever follows it', () => {
    for (const detail of [
      `agent task ${RUN}`,
      `agent task ${RUN}; pd-implementer`,
      `agent task ${RUN}; pd-implementer; while T1 was active`,
      `agent task ${RUN}; pd-scout; from another session than the one running T2`,
      `agent task ${RUN}; sandbox-scout`,
    ]) {
      assert.equal(isOwnRun(agentDone(detail)), true, detail);
    }
  });

  test("is not one of Claude Code's, a run with no ID, or anything else", () => {
    for (const detail of [
      'agent task ae54bced346c9abb3; pd:pd-plan-critic',
      'agent task a778bdca6338c5c09',
      'agent task unnamed',
      'agent task unnamed; pd-implementer; while T1 was active',
      'agent task ses_',
      `agent task ${RUN}x-y; pd-scout`,
      `agent task  ${RUN}`,
      `agent task ${RUN.toUpperCase().replace('SES_', 'Ses_')}`,
      `pd-implementer; agent task ${RUN}`,
      `T1 accepted; agent task ${RUN}`,
      'agent task old',
      '',
    ]) {
      assert.equal(isOwnRun(agentDone(detail)), false, JSON.stringify(detail));
    }
  });

  test('is an agent-done: a receipt or a denial naming the run is not', () => {
    for (const event of ['task-receipt', 'denied', 'agent-start']) {
      assert.equal(isOwnRun({ ...agentDone(`agent task ${RUN}`), event }), false, event);
    }
  });

  test('reads nothing into an entry that is not one', () => {
    for (const entry of [null, undefined, {}, { event: 'agent-done' }, { event: 'agent-done', detail: 42 }]) {
      assert.equal(isOwnRun(entry), false, JSON.stringify(entry));
    }
  });

  // The predicate reads the format the hook writes; this is the hook writing
  // it. A change to how task-completed.js words the entry would otherwise leave
  // every test above green and the doctor warning about a hook that works.
  test('is what the subagent-stop hook writes for an Open Code run, and not for a Claude Code one', async () => {
    // The hook writes to the home it resolves, which isolate-home made this
    // file's own.
    const home = process.env.PDKIT_HOME;
    const cwd = await mkdtemp(join(tmpdir(), 'pdkit-harness-cwd-'));
    try {
      for (const [agent_id, agent_type] of [
        [RUN, 'pd-scout'],
        ['ae54bced346c9abb3', 'pd:pd-plan-critic'],
        [undefined, 'pd-scout'],
      ]) {
        await handle({ hook_event_name: 'SubagentStop', ...(agent_id ? { agent_id } : {}), agent_type, cwd, session_id: 'ses_parent' }, {});
      }
      // An entry another module writes with the run in it.
      await append({ issue: 1, event: 'task-receipt', detail: `T1 accepted; agent task ${RUN}` }, { home });

      const entries = await read({}, { home });
      assert.deepEqual(
        entries.map((entry) => [entry.event, entry.detail, isOwnRun(entry)]),
        [
          ['agent-done', `agent task ${RUN}; pd-scout`, true],
          ['agent-done', 'agent task ae54bced346c9abb3; pd:pd-plan-critic', false],
          ['agent-done', 'agent task unnamed; pd-scout', false],
          ['task-receipt', `T1 accepted; agent task ${RUN}`, false],
        ],
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// The hooks and `pdkit task start` tell the model to move its session into an
// issue's tree, as Claude Code's hooks told it to call EnterWorktree. In Open
// Code the model writes the call into the code it gives the execute tool, so
// the text is code: what it names must reach Open Code as it is.
describe('the call that moves a session', () => {
  /** What session_move receives when the model runs the call as given. */
  const received = (call) => new Function('tools', `return ${call};`)({ opencode: { session_move: (input) => input } });

  test('is session_move through the execute tool, with the directory', () => {
    assert.equal(MOVE_TOOL, 'execute');
    assert.equal(moveCall('/work/pd-worktrees/DESKTOP-42'), 'tools.opencode.session_move({ directory: "/work/pd-worktrees/DESKTOP-42" })');
  });

  // A Windows path written bare in a JavaScript string loses its backslashes.
  test('hands the directory over as it is, whatever it holds', () => {
    for (const directory of [
      '/work/pd-worktrees/DESKTOP-42',
      'C:\\Users\\dev\\pd-worktrees\\DESKTOP-42',
      '/work/a "quoted" name/DESKTOP-42',
      '/work/with space/DESKTOP-42',
      '/work/ünïcödé/DESKTOP-42',
    ]) {
      assert.deepEqual(received(moveCall(directory)), { directory }, directory);
    }
  });
});
