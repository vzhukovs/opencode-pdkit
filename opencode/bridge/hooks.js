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

import { homedir } from 'node:os';

import { invoke, refusal } from '../../lib/hooks/runner.js';
import { answer, combine, withText } from './answer.js';
import {
  postBash as postBashPayloads,
  postClaim as postClaimPayloads,
  postWrite as postWritePayloads,
  preBash as preBashPayload,
  preWrite as preWritePayloads,
} from './payload.js';

const PRE_BASH = 'pre-bash';
const PRE_WRITE = 'pre-write';
const POST_WRITE = 'post-write';
const POST_CLAIM = 'post-claim';
const POST_BASH = 'post-bash';

/** An answer that does nothing: what a hook that had no run, or failed open, gives. */
const NOTHING = Object.freeze({ action: Object.freeze({ kind: 'pass' }), dropped: Object.freeze([]) });

/**
 * @param {unknown} error
 * @returns {string}
 */
const reason = (error) => (error instanceof Error ? error.message : String(error));

/**
 * What a fail-open hook says when the bridge itself failed before there was a
 * decision: runHook's words for a handler that failed, with where.
 *
 * @param {string} event
 * @param {unknown} error
 * @returns {import('../../lib/hooks/runner.js').Decision}
 */
const failedOpen = (event, error) => ({ block: false, diagnostic: `pdkit: hook "${event}" failed in the hook bridge (${reason(error)}); allowing` });

/**
 * The home directory Open Code expands `~` in a path to (Global.Path.home): its
 * own test override, or the user's.
 *
 * @returns {string}
 */
const hostHome = () => process.env.OPENCODE_TEST_HOME ?? homedir();

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
 *   preWrite: (event: {tool?: string, sessionID?: string, input?: unknown}) => Promise<void>,
 *   postWrite: (event: {tool?: string, sessionID?: string, status?: string, input?: unknown}) => Promise<import('./answer.js').Answer>,
 *   postClaim: (event: {tool?: string, sessionID?: string, status?: string, input?: unknown}) => Promise<import('./answer.js').Answer>,
 *   postBash: (event: {tool?: string, sessionID?: string, status?: string, input?: unknown, result?: unknown}) => Promise<import('./answer.js').Answer>,
 *   afterTool: (event: {tool?: string, sessionID?: string, status?: string, input?: unknown, result?: unknown}) => Promise<void>,
 *   register: () => Promise<void>,
 *   cleanup: () => Promise<void>,
 * }}
 */
export function createBridge(ctx, plugin) {
  /**
   * Write what the runs of one call let through without saying to anyone,
   * each distinct line once. Never throws: the decision is made, and a line
   * that cannot be written changes nothing.
   *
   * @param {string} event
   * @param {import('../../lib/hooks/runner.js').Decision[]} decisions
   * @param {import('./answer.js').Dropped[]} dropped
   */
  const report = (event, decisions, dropped) => {
    try {
      const lines = [
        ...decisions.flatMap((decision) => (decision.diagnostic ? [decision.diagnostic] : [])),
        ...dropped.map(({ field, text }) => `${event} ${field}, which reaches no one here: ${text}`),
      ];
      for (const line of new Set(lines)) plugin.log(line);
    } catch {
      // Nowhere else to say it.
    }
  };

  /**
   * One post hook, for a call that ran: a run for each payload the call gives
   * it, side by side, and one answer for the call. Never throws. A run that
   * gave no answer is a pass already (runner.decide); a failure here — an
   * event that cannot be read, a location that cannot be had — is a pass that
   * says why in the log.
   *
   * The session's directory is read when a payload needs it, which is after
   * the hook's own filter: a call a hook does not look at costs it nothing —
   * not even a line, when the location cannot be had.
   *
   * @param {string} name  the pdkit hook event
   * @param {(event: object, host: {directory: string|undefined, home: string}) => object[]} payloadsOf
   * @param {object} event  execute.after's event
   * @returns {Promise<import('./answer.js').Answer>}
   */
  const afterRuns = async (name, payloadsOf, event) => {
    try {
      const host = {
        get directory() {
          return ctx.location?.directory;
        },
        home: hostHome(),
      };
      const payloads = payloadsOf(event, host);
      if (payloads.length === 0) return NOTHING;
      const decisions = await Promise.all(payloads.map((payload) => invoke(name, payload, { root: plugin.root })));
      const answered = combine(decisions.map((decision) => answer(name, decision)));
      report(name, decisions, answered.dropped);
      return answered;
    } catch (error) {
      report(name, [failedOpen(name, error)], []);
      return NOTHING;
    }
  };

  const bridge = {
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
      report(PRE_BASH, [decision], answered.dropped);
      if (answered.action.kind === 'refuse') throw new Error(answered.action.text);
    },

    /**
     * pre-write, for any call: whether the files a write, edit or patch call
     * would change are the active task's to write. Throwing refuses the whole
     * call; the message is what the model and the person see.
     *
     * One run for each file, side by side, and a refusal of any one is a
     * refusal of the call. Everything else fails open: a run that gave no
     * answer is a pass already (runner.decide), and a failure here — an event
     * that cannot be read, a location that cannot be had — is a pass that says
     * why in the log. Nothing but a refusal leaves this callback as an
     * exception: one would make the call fail like a refusal.
     */
    async preWrite(event) {
      let refused;
      try {
        const payloads = preWritePayloads(event, { directory: ctx.location?.directory, home: hostHome() });
        if (payloads.length === 0) return;
        const decisions = await Promise.all(payloads.map((payload) => invoke(PRE_WRITE, payload, { root: plugin.root })));
        const answered = combine(decisions.map((decision) => answer(PRE_WRITE, decision)));
        report(PRE_WRITE, decisions, answered.dropped);
        if (answered.action.kind === 'refuse') refused = answered.action.text;
      } catch (error) {
        report(PRE_WRITE, [failedOpen(PRE_WRITE, error)], []);
        return;
      }
      if (refused !== undefined) throw new Error(refused);
    },

    /**
     * post-write, for a call that ran: whether a file a write, edit or patch
     * call left in podman-desktop lacks its license header, or is a schema
     * source. Gives an answer and never throws.
     *
     * One run for each file the call left (afterRuns).
     */
    async postWrite(event) {
      return afterRuns(POST_WRITE, postWritePayloads, event);
    },

    /**
     * post-claim, for a call that ran: whether the text a write, edit or patch
     * call wrote in a markdown file calls a name missing that matches nothing
     * in podman-desktop. Gives an answer and never throws.
     *
     * One run for each markdown file the call wrote text in (afterRuns).
     */
    async postClaim(event) {
      return afterRuns(POST_CLAIM, postClaimPayloads, event);
    },

    /**
     * post-bash, for a call that ran: whether a shell command that read
     * through a window, and exited 0, printed a block it did not close. Gives
     * an answer and never throws.
     *
     * One run for the command (afterRuns).
     */
    async postBash(event) {
      return afterRuns(POST_BASH, postBashPayloads, event);
    },

    /**
     * After any call: the post hooks for it, side by side — Claude Code ran
     * the hooks a tool matched in parallel — and what they have for the model
     * added to the call's result, once.
     *
     * Nothing leaves this callback as an exception. The call has already run;
     * an exception here would turn its result into an error, and the model
     * would take a write that happened for one that failed (F33).
     */
    async afterTool(event) {
      try {
        // In the order hooks/hooks.json lists them; their texts keep that
        // order in the result (combine). No call is both a write and a
        // command, so post-bash's text never shares a result with theirs.
        const answered = combine(await Promise.all([bridge.postWrite(event), bridge.postClaim(event), bridge.postBash(event)]));
        if (answered.action.kind === 'append') event.result = withText(event.result, answered.action.text);
      } catch (error) {
        report('execute.after', [{ block: false, diagnostic: `pdkit: the hook bridge failed after a tool call (${reason(error)}); its result is as the tool left it` }], []);
      }
    },

    /**
     * Register every hook but the gate, which the entry point owns and
     * registers first. pre-write is on the same point as the gate, after it;
     * the post hooks share one callback after a tool (afterTool).
     */
    async register() {
      await ctx.tool.hook('execute.before', (event) => bridge.preWrite(event));
      // TODO(T4.10–T4.14): the rest of pdkit's hook events.
      await ctx.tool.hook('execute.after', (event) => bridge.afterTool(event));
    },

    async cleanup() {},
  };
  return bridge;
}
