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
// Most hooks are a run for an event and an answer to it. subagent-stop also
// remembers: whether it held a subagent's last stop, which Claude Code told
// its handler and Open Code does not (D11). That memory is the bridge's, per
// loaded instance of the plugin, and goes with cleanup().
//
// session-start has no one point to stand on: Claude Code ran it when a
// session started, was resumed or cleared, and after a compaction. Here it
// runs on a session's first prompt, on a fork, and after a compaction; a
// session continued as it is has no event to run it on (§13 DV10).
//
// pre-compact is on the compaction hook, which Open Code waits on before it
// asks a model for the summary — so the entry is in the journal before the
// compaction ends, and in the summary session-start gives after it, as Claude
// Code ran PreCompact before and SessionStart after. Waited on, it is also
// the compaction's to lose: a throw fails it, and a hang holds it for ever
// (F73). So the callback never throws, and waits on nothing but the run,
// which the runner stops at its deadline.
//
// prompt-submit is on the prompt hook, beside session-start: one callback runs
// both. The hook never sees what the person typed, so it looks only at a
// prompt a pdkit command labeled as its own (D6) and puts the command back
// together from the label; the handler's context goes with the prompt as an
// attached text. Open Code waits on this hook before it takes the prompt in,
// and a throw or a hang there loses what the person typed (F81) — where
// Claude Code's hook never blocked — so the same holds: never a throw, and
// nothing waited on but the run.
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

import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';

import { invoke, refusal } from '../../lib/hooks/runner.js';
import { answer, combine, withAttachment, withText } from './answer.js';
import {
  postBash as postBashPayloads,
  postClaim as postClaimPayloads,
  postRead as postReadPayloads,
  postWrite as postWritePayloads,
  preBash as preBashPayload,
  preCompact as preCompactPayloads,
  preWrite as preWritePayloads,
  promptSubmit as promptSubmitPayloads,
  sessionStart as sessionStartPayloads,
  startsSession,
  subagentStop as subagentStopPayloads,
} from './payload.js';

const PRE_BASH = 'pre-bash';
const PRE_WRITE = 'pre-write';
const POST_WRITE = 'post-write';
const POST_CLAIM = 'post-claim';
const POST_BASH = 'post-bash';
const POST_READ = 'post-read';
const SUBAGENT_STOP = 'subagent-stop';
const SESSION_START = 'session-start';
const PRE_COMPACT = 'pre-compact';
const PROMPT_SUBMIT = 'prompt-submit';

/** Who added a message to a session: the plugin, by its ID, as Open Code's own plugins sign theirs. */
const SOURCE = 'opencode-pdkit';

/**
 * The key of the session summary among a session's instruction entries: the
 * plugin's ID, as above. The model reads the entry as `<context key="…">`.
 */
const SUMMARY_KEY = SOURCE;

/**
 * How many stops in a row of one round of a subagent the bridge holds before
 * it lets the subagent go, whatever the hook says. Not a rule of pdkit's but
 * Claude Code's, which the handler was written against: "Claude Code
 * overrides the hook and ends the turn after 8 consecutive blocks" (its hooks
 * reference, Stop input; CLAUDE_CODE_STOP_HOOK_BLOCK_CAP, default 8, counts
 * Stop and SubagentStop alike). Open Code has no such limit — a plugin that
 * keeps adding input "must bound its own loop" (F57) — and without one,
 * `exec.max_attempts: 0` would hold an implementer whose capture stays red for
 * ever, where Claude Code let it go after eight.
 */
export const HOLD_LIMIT = 8;

/**
 * How far up a chain of parents the bridge looks for the session at its top.
 * Open Code nests subagents one deep unless configured otherwise
 * (`experimental.subagent_depth`); this is only a bound on the walk.
 */
const DEPTH_LIMIT = 16;

/**
 * The ends of a run that no stop follows: experimental.idle is not called
 * after a run fails or is interrupted (F57).
 */
const ENDED = ['session.execution.failed', 'session.execution.interrupted'];

/** A session's compaction that succeeded: where Claude Code ran SessionStart with `compact`. */
const COMPACTED = 'session.compaction.ended';

/** A line feed, the byte a line of a text file ends with. */
const LF = 0x0a;

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
 * The first line of a text: what a person sees of a message the bridge adds
 * to a session, above it (F86).
 *
 * @param {string} text
 * @returns {string}
 */
const firstLine = (text) => text.split('\n', 1)[0].trim();

/**
 * The home directory Open Code expands `~` in a path to (Global.Path.home): its
 * own test override, or the user's.
 *
 * @returns {string}
 */
const hostHome = () => process.env.OPENCODE_TEST_HOME ?? homedir();

/**
 * How many lines Open Code's read tool counts in a file: one for each line
 * feed, and one more for a last line that ends without one (read-filesystem.ts
 * textPage, F265) — so a file that ends in `\r\n`, or starts with a byte order
 * mark, has as many as it has line feeds, and an empty one has none. Read a
 * chunk at a time: the file is one too large for a page to hold.
 *
 * @param {string} file  absolute
 * @returns {Promise<number>}
 */
async function linesOf(file) {
  let count = 0;
  let last;
  for await (const chunk of createReadStream(file)) {
    for (let at = chunk.indexOf(LF); at !== -1; at = chunk.indexOf(LF, at + 1)) count += 1;
    last = chunk[chunk.length - 1];
  }
  return last === undefined || last === LF ? count : count + 1;
}

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
 *   postRead: (event: {tool?: string, sessionID?: string, status?: string, input?: unknown, result?: unknown}) => Promise<import('./answer.js').Answer>,
 *   afterTool: (event: {tool?: string, sessionID?: string, status?: string, input?: unknown, result?: unknown}) => Promise<void>,
 *   subagentStop: (event: {sessionID?: string}) => Promise<void>,
 *   startOnPrompt: (event: {sessionID?: string}) => Promise<void>,
 *   startOnFork: (event: {sessionID?: string}) => Promise<void>,
 *   startOnCompaction: (event: {type?: string, data?: {sessionID?: string}}) => Promise<void>,
 *   preCompact: (event: {sessionID?: string, result?: unknown}) => Promise<void>,
 *   promptSubmit: (event: {sessionID?: string, prompt?: {files?: unknown}, metadata?: unknown}) => Promise<void>,
 *   onPrompt: (event: {sessionID?: string, prompt?: {files?: unknown}, metadata?: unknown}) => Promise<void>,
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
   * The subagents whose last stop the bridge held, each with how many stops
   * in a row of the current round it has held. Whether one is here is what
   * Claude Code told the handler as `stop_hook_active`, and the count is what
   * its limit is on (HOLD_LIMIT); Open Code tells a plugin neither (F58).
   *
   * A session goes in when a stop is held, and comes out when one is let go,
   * for whatever reason, or when its run fails or is interrupted: no stop of
   * that round comes after either (F57). So the first stop of a round —
   * the first ever, or one after a follow-up — is never taken for a stop the
   * bridge already held, as Claude Code did not take it. Each subagent is its
   * own key: subagents run side by side and are held each on its own (F66).
   *
   * In memory, for this instance: a reload of the plugin in the middle of a
   * round forgets it (§13 DV3).
   *
   * @type {Map<string, number>}
   */
  const held = new Map();

  /** Ends the bridge's watches on the host's events — runs that fail or are interrupted, compactions — at cleanup. */
  const watching = new AbortController();

  /**
   * Forget a held subagent whose run ended without a stop. Never throws;
   * a watch that cannot be had, or breaks, says so once.
   */
  const watch = async () => {
    try {
      for await (const event of ctx.event.subscribe({ types: ENDED, signal: watching.signal })) {
        if (ENDED.includes(event?.type)) held.delete(event.data?.sessionID);
      }
    } catch (error) {
      if (watching.signal.aborted) return;
      report(SUBAGENT_STOP, [
        {
          block: false,
          diagnostic:
            `pdkit: the hook bridge cannot follow the runs of subagents that fail or are interrupted (${reason(error)}); ` +
            'one held when that happens is taken, at its next stop, for one already told',
        },
      ], []);
    }
  };

  /**
   * The session at the top of a session's chain of parents: the one a person
   * drives, and whose shell commands started the task. Undefined for a
   * session that has no parent, without a lookup.
   *
   * @param {{parentID?: unknown}|undefined} session
   * @returns {Promise<string|undefined>}
   */
  const rootOf = async (session) => {
    let root = session?.parentID;
    for (let step = 0; step < DEPTH_LIMIT && typeof root === 'string' && root !== ''; step += 1) {
      const above = (await ctx.session.get({ sessionID: root }))?.parentID;
      if (typeof above !== 'string' || above === '') return root;
      root = above;
    }
    return typeof root === 'string' && root !== '' ? root : undefined;
  };

  /**
   * A session's instruction entries, which Open Code marks experimental
   * (ExperimentalSessionApi, F69): what the host has, or an error that says
   * it has none — a failure like any other, which the caller fails open on.
   *
   * @returns {{put: (input: {sessionID: string, key: string, value: string}) => Promise<unknown>, remove: (input: {sessionID: string, key: string}) => Promise<unknown>}}
   */
  const entries = () => {
    const entry = ctx.session?.instructions?.entry;
    if (typeof entry?.put !== 'function' || typeof entry?.remove !== 'function') {
      throw new Error('this Open Code has no session.instructions.entry, which is experimental');
    }
    return entry;
  };

  /**
   * session-start for one session: the summary, as the session's entry. A
   * run, unless the session is a subagent's (sessionStart builds no payload
   * for one); then the entry is put, or withdrawn when the summary is empty —
   * except on a session's first prompt, which has none to withdraw. A run
   * with no answer leaves the entry as it was (answer.js). Throws what the
   * host throws; the callers fail open.
   *
   * @param {string} sessionID
   * @param {object|undefined} session  its record
   * @param {'startup'|'resume'|'compact'} source
   */
  const summarize = async (sessionID, session, source) => {
    const payloads = sessionStartPayloads({ sessionID }, { session, source });
    if (payloads.length === 0) return;
    const decision = await invoke(SESSION_START, payloads[0], { root: plugin.root });
    const answered = answer(SESSION_START, decision);
    report(SESSION_START, [decision], answered.dropped);
    const { action } = answered;
    if (action.kind === 'instruct') await entries().put({ sessionID, key: SUMMARY_KEY, value: action.text });
    else if (action.kind === 'withdraw' && source !== 'startup') await entries().remove({ sessionID, key: SUMMARY_KEY });
  };

  /**
   * Run session-start after each compaction of a session of this instance's
   * directory. Every loaded instance sees every session's events (F137), so
   * one that is not the session's own leaves it to that one. A compaction is
   * not waited on: each is summarized on its own. Never throws; a watch that
   * cannot be had, or breaks, says so once.
   */
  const watchCompactions = async () => {
    try {
      for await (const event of ctx.event.subscribe({ types: [COMPACTED], signal: watching.signal })) {
        void bridge.startOnCompaction(event);
      }
    } catch (error) {
      if (watching.signal.aborted) return;
      report(SESSION_START, [
        {
          block: false,
          diagnostic: `pdkit: the hook bridge cannot follow compactions (${reason(error)}); a compacted session keeps the summary it had`,
        },
      ], []);
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
   * not even a line, when the location cannot be had. The same for a file on
   * disk: post-read reads one, to count its lines, only after a page that
   * does not reach its end.
   *
   * @param {string} name  the pdkit hook event
   * @param {(event: object, host: {directory: string|undefined, home: string, lines: (file: string) => Promise<number>}) => object[]|Promise<object[]>} payloadsOf
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
        lines: linesOf,
      };
      const payloads = await payloadsOf(event, host);
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
     * post-read, for a call that ran: whether a read or a search that
     * returned part of what there was ended inside a block it did not close.
     * Gives an answer and never throws.
     *
     * One run for a read or a grep that went through a window (afterRuns).
     */
    async postRead(event) {
      return afterRuns(POST_READ, postReadPayloads, event);
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
        // order in the result (combine). A call is a write, a command or a
        // read, never two of them, so only the writes' hooks ever share a
        // result.
        const answered = combine(
          await Promise.all([bridge.postWrite(event), bridge.postClaim(event), bridge.postBash(event), bridge.postRead(event)]),
        );
        if (answered.action.kind === 'append') event.result = withText(event.result, answered.action.text);
      } catch (error) {
        report('execute.after', [{ block: false, diagnostic: `pdkit: the hook bridge failed after a tool call (${reason(error)}); its result is as the tool left it` }], []);
      }
    },

    /**
     * subagent-stop, for a session about to go idle: count the stop of a
     * subagent, and hold the implementer until its task has a receipt that
     * passes. Open Code asks this of every session, a person's included; one
     * that has no parent is no subagent, and costs a lookup and no process.
     *
     * A hold is the reason added to the child session as a message: Open Code
     * then runs it in the same execution instead of letting the child go idle,
     * and the parent hears nothing until a stop is let go — one report, with
     * the last answer (F58). The model reads the reason as its next
     * instruction, as it read it under Claude Code; the person sees its first
     * line, in the child's session (F86).
     *
     * Nothing leaves this callback as an exception: one would fail the child's
     * run, lose its answer, and hand the parent the exception's text instead
     * (F59). Whatever fails — the session that cannot be looked up, the run
     * that gives no answer, the message that cannot be added — lets the
     * subagent go, and says why in the log. A run that hangs is stopped at the
     * runner's deadline (F59: Open Code would wait on it without end).
     */
    async subagentStop(event) {
      const child = event?.sessionID;
      try {
        if (typeof child !== 'string' || child === '') return;
        const session = await ctx.session.get({ sessionID: child });
        const payloads = subagentStopPayloads(event, { session, root: await rootOf(session), held: held.has(child) });
        if (payloads.length === 0) return;

        const decision = await invoke(SUBAGENT_STOP, payloads[0], { root: plugin.root });
        const answered = answer(SUBAGENT_STOP, decision);
        report(SUBAGENT_STOP, [decision], answered.dropped);
        if (answered.action.kind !== 'hold') {
          held.delete(child);
          return;
        }

        const holds = (held.get(child) ?? 0) + 1;
        if (holds > HOLD_LIMIT) {
          held.delete(child);
          report(SUBAGENT_STOP, [{ block: false, diagnostic: `pdkit: hook "subagent-stop" held ${child} ${HOLD_LIMIT} times in a row, as many as Claude Code allowed; letting it go` }], []);
          return;
        }
        const text = answered.action.text;
        await ctx.session.synthetic({ sessionID: child, text, description: firstLine(text), metadata: { source: SOURCE, hook: SUBAGENT_STOP } });
        held.set(child, holds);
      } catch (error) {
        held.delete(child);
        report(SUBAGENT_STOP, [failedOpen(SUBAGENT_STOP, error)], []);
      }
    },

    /**
     * session-start on a prompt: the first prompt of a session that has never
     * run, before it reaches the model — Open Code waits on this hook before
     * it takes the prompt in (F69, F75), so the summary is in the session's first
     * request. Any other prompt costs a lookup and no process.
     *
     * Nothing leaves this callback as an exception: one, or a hook that never
     * returns, would lose the person's input (C36). Whatever fails lets the
     * prompt through without a summary, and says why in the log; a run that
     * hangs is stopped at the runner's deadline.
     */
    async startOnPrompt(event) {
      try {
        const sessionID = event?.sessionID;
        if (typeof sessionID !== 'string' || sessionID === '') return;
        const session = await ctx.session.get({ sessionID });
        if (!startsSession(session)) return;
        await summarize(sessionID, session, 'startup');
      } catch (error) {
        report(SESSION_START, [failedOpen(SESSION_START, error)], []);
      }
    },

    /**
     * session-start on a fork: the fork carries the summary its session had
     * (F71), from whenever that was written; Claude Code ran SessionStart on
     * the resumed session a fork was. Open Code calls this hook in the fork's
     * directory and finishes the fork after it (F271), so the summary is in
     * the fork's first request. Never throws.
     */
    async startOnFork(event) {
      try {
        const sessionID = event?.sessionID;
        if (typeof sessionID !== 'string' || sessionID === '') return;
        await summarize(sessionID, await ctx.session.get({ sessionID }), 'resume');
      } catch (error) {
        report(SESSION_START, [failedOpen(SESSION_START, error)], []);
      }
    },

    /**
     * session-start after a compaction that succeeded, for a session of this
     * instance's directory. The entry outlives the compaction as it was
     * written (F70); the new summary reaches the model after the compaction's
     * own, as a value that supersedes it (F272). Never throws.
     */
    async startOnCompaction(event) {
      try {
        if (event?.type !== COMPACTED) return;
        const sessionID = event.data?.sessionID;
        if (typeof sessionID !== 'string' || sessionID === '') return;
        const session = await ctx.session.get({ sessionID });
        const here = ctx.location?.directory;
        if (typeof here !== 'string' || session?.location?.directory !== here) return;
        await summarize(sessionID, session, 'compact');
      } catch (error) {
        report(SESSION_START, [failedOpen(SESSION_START, error)], []);
      }
    },

    /**
     * pre-compact, for a session about to be compacted: the active task of
     * this instance's directory written in the journal, before the summary is
     * asked for. Open Code calls this once for each compaction — asked for,
     * automatic, or after a request that overflowed — in the instance of the
     * session's directory, a subagent's session included (F72).
     *
     * The event is left as it is: a `result` set on it would be taken for the
     * summary, and no model asked (F72).
     *
     * Nothing leaves this callback as an exception: one would fail the
     * compaction, and an automatic one the person's turn with it (F73). Nor
     * does it wait on the host: the compaction waits on this callback without
     * end, so the one thing it waits on is the run, which the runner stops at
     * its deadline. Whatever fails lets the compaction go on without the
     * entry, and says why in the log.
     */
    async preCompact(event) {
      try {
        const payloads = preCompactPayloads(event, ctx.location?.directory);
        if (payloads.length === 0) return;
        const decision = await invoke(PRE_COMPACT, payloads[0], { root: plugin.root });
        report(PRE_COMPACT, [decision], answer(PRE_COMPACT, decision).dropped);
      } catch (error) {
        report(PRE_COMPACT, [failedOpen(PRE_COMPACT, error)], []);
      }
    },

    /**
     * prompt-submit, for a prompt a pdkit command sends: whether the session
     * is in the tree where the issue the command names is worked on, and if
     * not, where that is and how to get there. What the handler has for the
     * model goes with the prompt as an attached text (answer.js); what the
     * person typed is left as it was.
     *
     * A prompt with no pdkit label — what a person types, a subagent's first
     * task — costs nothing: no read, not even of the location, and no process
     * (payload.js promptSubmit).
     *
     * Nothing leaves this callback as an exception: one, or a hook that never
     * returns, would lose the person's input (F81), where Claude Code's hook
     * never blocked. Nor does it wait on the host: the one thing it waits on
     * is the run, which the runner stops at its deadline. Whatever fails lets
     * the prompt through without the context, and says why in the log.
     */
    async promptSubmit(event) {
      try {
        const host = {
          get directory() {
            return ctx.location?.directory;
          },
        };
        const payloads = promptSubmitPayloads(event, host);
        if (payloads.length === 0) return;
        const decision = await invoke(PROMPT_SUBMIT, payloads[0], { root: plugin.root });
        const answered = answer(PROMPT_SUBMIT, decision);
        report(PROMPT_SUBMIT, [decision], answered.dropped);
        if (answered.action.kind === 'attach') event.prompt.files = withAttachment(event.prompt.files, answered.action.text);
      } catch (error) {
        report(PROMPT_SUBMIT, [failedOpen(PROMPT_SUBMIT, error)], []);
      }
    },

    /**
     * The prompt hook: session-start on a session's first prompt, and
     * prompt-submit on a pdkit command's — side by side, as neither needs the
     * other. One callback for the point, so the order of two on one point is
     * nothing the bridge relies on. Neither throws, so this does not.
     */
    async onPrompt(event) {
      await Promise.all([bridge.startOnPrompt(event), bridge.promptSubmit(event)]);
    },

    /**
     * Register every hook but the gate, which the entry point owns and
     * registers first. pre-write is on the same point as the gate, after it;
     * the post hooks share one callback after a tool (afterTool);
     * subagent-stop is on the point a session reaches before it goes idle;
     * session-start on a prompt, on a fork, and on the stream of compactions;
     * pre-compact on the compaction itself; prompt-submit on a prompt, in the
     * same callback as session-start (onPrompt).
     *
     * Each on its own: a point the host does not have — experimental.idle may
     * be renamed in a later Open Code (F57) — leaves the others registered.
     * What failed is thrown after the rest, for the entry point to report.
     */
    async register() {
      const failures = [];
      const attempt = async (registration) => {
        try {
          await registration();
        } catch (error) {
          failures.push(reason(error));
        }
      };
      await attempt(() => ctx.tool.hook('execute.before', (event) => bridge.preWrite(event)));
      await attempt(() => ctx.tool.hook('execute.after', (event) => bridge.afterTool(event)));
      await attempt(async () => {
        await ctx.session.hook('experimental.idle', (event) => bridge.subagentStop(event));
        void watch();
      });
      await attempt(() => ctx.session.hook('prompt', (event) => bridge.onPrompt(event)));
      await attempt(() => ctx.session.hook('fork', (event) => bridge.startOnFork(event)));
      void watchCompactions();
      await attempt(() => ctx.session.hook('compaction', (event) => bridge.preCompact(event)));
      if (failures.length > 0) throw new Error(failures.join('; '));
    },

    /**
     * What this instance remembers goes: the subagents it held, and the
     * watches on runs and compactions. The host removes the registrations
     * itself (F250).
     */
    async cleanup() {
      watching.abort();
      held.clear();
    },
  };
  return bridge;
}
