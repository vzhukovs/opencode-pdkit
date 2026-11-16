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

// The hook bridge: where Open Code's hook points meet pdkit's hook events.
//
// Under Claude Code, hooks/hooks.json told the host to run `pdkit hook <event>`
// as a process and read the exit code. Open Code has no such manifest: a plugin
// registers callbacks on its hook points from inside the server. This module is
// those callbacks. Each one turns the Open Code event into the payload a pdkit
// handler reads (./payload.js), runs the handler in a child process
// (lib/hooks/runner.js, the same call the doctor's self-test makes), and turns
// its decision back into what Open Code understands (./answer.js) — a throw,
// text added to a tool result, a message to the session.
//
// It is the one module of the bridge the entry point loads, and it loads the
// rest itself. The entry point registers the gate's callback before loading
// anything, and hands it to preBash() once this module has loaded; if it fails
// to load, the entry point refuses on its own, so a broken bridge cannot leave
// the gate open.
//
// WHERE FAILURES GO. A hook that fails open says why in one line to the
// server's stderr, through the entry point's log: a handler that could not run
// (runHook's "…; allowing"), what a handler wrote to stderr while it allowed,
// and what the host gives no way to anyone (answer.js, `dropped`). That is
// where Claude Code put the same lines — its debug log — and it is as far as a
// plugin can write: Open Code gives the server part no log of its own, and a
// background service's stderr reaches no one. Not the journal: it records what
// the handlers decided, and a failure of the bridge is not a decision. A
// failure that matters fails closed, on the one event that guards writes, and
// is seen by the model and the person; one that persists is the doctor's to
// find.

import { invoke, refusal } from '../../lib/hooks/runner.js';
import { answer } from './answer.js';
import { preBash as preBashPayload } from './payload.js';

const PRE_BASH = 'pre-bash';

/**
 * @param {unknown} error
 * @returns {string}
 */
const reason = (error) => (error instanceof Error ? error.message : String(error));

/**
 * The bridge for one loaded instance of the plugin. Open Code loads the plugin
 * once per project directory and calls setup() for each, so whatever the
 * bridge remembers between callbacks lives here, per instance, and goes away
 * with cleanup().
 *
 * @param {object} ctx the plugin context setup() received
 * @param {{root: string, settings: {models: Readonly<Record<string, string>>}, log: (line: string) => void}} plugin
 * @returns {{
 *   preBash: (event: {tool?: string, sessionID?: string, input: {command: string, workdir?: unknown}}) => Promise<void>,
 *   register: () => Promise<void>,
 *   cleanup: () => Promise<void>,
 * }}
 */
export function createBridge(ctx, plugin) {
  /**
   * Write what a run let through without saying to anyone. Never throws: the
   * decision is made, and a line that cannot be written changes nothing.
   *
   * @param {string} event
   * @param {import('../../lib/hooks/runner.js').Decision} decision
   * @param {import('./answer.js').Dropped[]} dropped
   */
  const report = (event, decision, dropped) => {
    try {
      if (decision.diagnostic) plugin.log(decision.diagnostic);
      for (const { field, text } of dropped) plugin.log(`${event} ${field}, which reaches no one here: ${text}`);
    } catch {
      // Nowhere else to say it.
    }
  };

  return {
    /**
     * pre-bash, for one call that carries a command. Throwing refuses it; the
     * message is what the model and the person see.
     *
     * Everything up to the decision is inside one try: a payload that cannot
     * be built, a runner that throws, an answer that cannot be read — none of
     * them is a decision, so each refuses in runHook's words. The runner
     * itself never throws; what it could not do comes back as a decision
     * already made under FAIL_CLOSED.
     */
    async preBash(event) {
      let decision;
      let answered;
      try {
        decision = await invoke(PRE_BASH, preBashPayload(event, ctx.location?.directory), { root: plugin.root });
        answered = answer(PRE_BASH, decision);
      } catch (error) {
        throw new Error(refusal(PRE_BASH, `failed in the hook bridge (${reason(error)})`));
      }
      report(PRE_BASH, decision, answered.dropped);
      if (answered.action.kind === 'refuse') throw new Error(answered.action.text);
    },

    /** Register every hook but the gate, which the entry point owns. */
    async register() {
      // TODO(T4.6–T4.14): one registration per pdkit hook event.
      await ctx.tool.hook('execute.after', () => {});
    },

    async cleanup() {},
  };
}
