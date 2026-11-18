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

// What the plugin writes to the server's stderr, for the suites that run its
// hooks through the bridge — and the watch kept on it.
//
// A handler has two ways to speak while it allows: a message, for the model,
// and a notice, for the person (runHook's systemMessage). Open Code gives the
// plugin no line to the person, so the bridge lists a notice as `dropped` and
// writes it here (opencode/bridge/answer.js; hooks.js, report). No handler
// gives one any more: the model check that did is gone, and the way to the
// person went with it (D12). The watch holds that on every case the suites
// run through the bridge: a handler that starts to give a notice fails the
// suite that ran it, instead of saying it to a log nobody reads. Then the way
// to the person comes back as a task of its own.
//
// What the watch does not hold: a pre-hook's message, which reached no one
// under Claude Code either (owns.js on a task with no Owns, HK-10; the gate
// standing aside outside podman-desktop), and what a subagent-stop says as it
// lets one go — those go here by decision, not by accident. And a copy of the
// plugin with a stand-in handler: it is not the plugin, and says what the
// test made it say.
//
// Outside `test/*.test.js`, so the runner does not collect it as a suite.

import assert from 'node:assert/strict';

/**
 * A line the bridge writes for a notice it had no way to send: `<event> notice,
 * which reaches no one here: <text>`, after the entry point's `opencode-pdkit: `
 * when it went through setup().
 */
const NOTICE = /(?:^|: )[a-z-]+ notice, which reaches no one here: /;

/**
 * Fail when any of `lines` is a notice the bridge dropped.
 *
 * @param {readonly string[]} lines
 */
export function assertNoNotice(lines) {
  const notices = lines.filter((line) => NOTICE.test(line));
  assert.deepEqual(notices, [], 'a hook gave the person a notice, which Open Code has no way to show (D12): the channel comes back as a task of its own');
}

/**
 * Take what the plugin writes to the server's stderr for the rest of the test,
 * and, unless told otherwise, hold it to having no notice once the test ends.
 *
 * @param {import('node:test').TestContext} t
 * @param {{watch?: boolean}} [options]  `watch: false` for a copy of the plugin with stand-in handlers
 * @returns {() => string[]}  the lines so far
 */
export function logOf(t, { watch = true } = {}) {
  const error = t.mock.method(console, 'error', () => {});
  const lines = () => error.mock.calls.map((entry) => entry.arguments.join(' '));
  if (watch) t.after(() => assertNoNotice(lines()));
  return lines;
}

/**
 * The same watch on lines the bridge was handed a log for directly
 * (createBridge in a test).
 *
 * @param {import('node:test').TestContext} t
 * @param {readonly string[]} lines
 */
export function watchNotices(t, lines) {
  t.after(() => assertNoNotice(lines));
}
