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

// A hook's decision, as what Open Code does with it.
//
// lib/hooks/runner.js reads the handler's process back into the object its
// handle() returned. This turns that object into one action of the host's —
// refuse the call, add text to its result, let it through — and lists what
// has no way to anyone here. A row per pdkit event the bridge carries,
// combine() for a call that took more than one run to decide, and withText()
// for the result the text goes into; pure.
//
// What has no way: before a tool runs, Open Code gives a plugin a throw and
// nothing else — no text that reaches the model beside a call it lets through,
// and no line for the person (the plugin has no notice channel, D12). Claude
// Code did no better with a message on PreToolUse: plain stdout from a hook
// that exits 0 went to its debug log, which neither the model nor the person
// sees. So a pre-hook's message and any notice are `dropped` — listed, not
// lost silently — and the bridge writes them where it writes its own failures.
//
// After a tool, the one way to the model is the tool's result (F28, F29): what
// Claude Code placed beside it — a PostToolUse hook's additionalContext, and
// the stderr of one that exits 2 — is added to it as its last text part. The
// call has run, and stays a call that succeeded, as it did under Claude Code;
// the model reads the text in the result rather than in a block of its own,
// and the person sees it where Open Code shows a result's text (§13 DV8).
//
// When a subagent stops, exit 2 is not a refusal but an instruction: Claude
// Code kept the subagent running with the reason as what it does next. Open
// Code does the same for a message a plugin adds to the child session before
// it goes idle (F58), so a refusal there is a hold, and the bridge adds the
// message. What a handler says while it lets the subagent go — a receipt
// accepted, a run let go stalled — went to Claude Code's debug log, and is
// `dropped` here.

/** @typedef {import('../../lib/hooks/runner.js').Decision} Decision */

/**
 * @typedef {{kind: 'refuse', text: string} | {kind: 'append', text: string} | {kind: 'hold', text: string} | {kind: 'pass'}} Action
 * @typedef {{field: 'message'|'notice', text: string}} Dropped
 * @typedef {{action: Action, dropped: Dropped[]}} Answer
 */

/** @type {Action} */
const PASS = Object.freeze({ kind: 'pass' });

/**
 * The fields of a decision that reach no one on this event.
 *
 * @param {Decision} decision
 * @param {Array<'message'|'notice'>} fields
 * @returns {Dropped[]}
 */
function unheard(decision, fields) {
  return fields.filter((field) => typeof decision[field] === 'string' && decision[field] !== '').map((field) => ({ field, text: decision[field] }));
}

/**
 * Before a tool runs: a refusal is a throw, whose text the model gets as the
 * call's error and the person sees under the failed call; anything else lets
 * the call through. What a run that gave no answer means, runner.decide has
 * already said by FAIL_CLOSED: a refusal on pre-bash, a pass everywhere else.
 *
 * @param {Decision} decision
 * @returns {Answer}
 */
const beforeTool = (decision) => ({
  action: decision.block ? { kind: 'refuse', text: decision.reason } : PASS,
  dropped: unheard(decision, ['message', 'notice']),
});

/**
 * After a tool has run: what the handler had for the model — the reason it
 * exited 2 with, or its context — is added to the call's result. Nothing is
 * refused: the call has happened, and exit 2 after a tool never undid it
 * under Claude Code either. What a run that gave no answer means, runner.decide
 * has already said: a pass, on every event but pre-bash.
 *
 * @param {Decision} decision
 * @returns {Answer}
 */
const afterTool = (decision) => {
  const text = decision.block ? decision.reason : decision.message;
  return {
    action: typeof text === 'string' && text !== '' ? { kind: 'append', text } : PASS,
    dropped: unheard(decision, ['notice']),
  };
};

/**
 * When a subagent stops: a refusal holds it, with the reason as its next
 * instruction; anything else lets it go. What a run that gave no answer means,
 * runner.decide has already said: a pass — subagent-stop fails open. One run
 * for each stop, so a hold is never one of several answers to combine.
 *
 * @param {Decision} decision
 * @returns {Answer}
 */
const whenStopping = (decision) => ({
  action: decision.block ? { kind: 'hold', text: decision.reason } : PASS,
  dropped: unheard(decision, ['message', 'notice']),
});

/** @type {Record<string, (decision: Decision) => Answer>} */
const ANSWERS = {
  'pre-bash': beforeTool,
  // A message here is owns.js saying a task has no Owns recorded (HK-10).
  // Claude Code sent it where it sent pre-bash's, to its debug log.
  'pre-write': beforeTool,
  // A source file with no license header exits 2 with the header to insert
  // (HK-12); a schema file allows with a reminder (HK-13). The model gets
  // either in the write's result.
  'post-write': afterTool,
  // A markdown file that calls a backticked name missing, asks whether it is
  // needed, or proposes adding a dotted one, when the name matches nothing in
  // podman-desktop outside that file (HK-16): Claude Code placed the reminder
  // beside the write as additionalContext; the model gets it in the write's
  // result. post-claim never blocks.
  'post-claim': afterTool,
  // A command that read through a window — `grep -A`, `sed -n a,bp`, `head` of
  // a file — and printed a block it did not close (HK-14): Claude Code placed
  // the rule beside the command as additionalContext; the model gets it in
  // the command's result. post-bash never blocks.
  'post-bash': afterTool,
  // A read or a search that returned part of what there was — a page of a
  // file, matches cut at a limit — and ended inside a block it did not close
  // (HK-15): Claude Code placed the rule beside the Read or the Grep as
  // additionalContext; the model gets it in the call's result. post-read never
  // blocks.
  'post-read': afterTool,
  // The implementer stopping before its task has a receipt that passes
  // (HK-18–HK-21): held, with the reason as its next instruction. Letting it
  // go says why only in what reaches no one: the receipt accepted (HK-35), a
  // run let go stalled (HK-20) or blocked (HK-21).
  'subagent-stop': whenStopping,
};

/**
 * @param {string} event  a pdkit hook event the bridge carries
 * @param {Decision} decision
 * @returns {Answer}
 */
export function answer(event, decision) {
  const row = Object.hasOwn(ANSWERS, event) ? ANSWERS[event] : undefined;
  if (!row) throw new Error(`the hook bridge carries no "${event}"`);
  return row(decision);
}

/**
 * One answer for a call that took several runs to decide — a patch, which
 * pre-write checks once for each file it changes and post-write once for each
 * file it leaves; or any write, which post-write and post-claim both look at.
 * Any refusal refuses the call: the host has no way to apply part of one.
 * Otherwise every distinct text for the model goes into the one result, in
 * the order of the runs, as Claude Code would have placed one beside each of
 * as many separate writes. The text of a refusal is every distinct reason, the
 * same way; what reaches no one is listed once.
 *
 * @param {Answer[]} answers
 * @returns {Answer}
 */
export function combine(answers) {
  const distinct = (kind) => [...new Set(answers.flatMap(({ action }) => (action.kind === kind ? [action.text] : [])))];
  const reasons = distinct('refuse');
  const texts = distinct('append');
  const dropped = new Map();
  for (const entry of answers.flatMap((answered) => answered.dropped)) dropped.set(`${entry.field}\n${entry.text}`, entry);
  return {
    action:
      reasons.length > 0
        ? { kind: 'refuse', text: reasons.join('\n\n') }
        : texts.length > 0
          ? { kind: 'append', text: texts.join('\n\n') }
          : PASS,
    dropped: [...dropped.values()],
  };
}

/**
 * The parts of a tool's result, read the way Open Code reads them (F28): a
 * string is one text part, a list is kept, and a result with neither is its
 * output, as text. execute.after gets the list already; the rest is for a
 * result some other plugin's callback replaced before this one.
 *
 * @param {{content?: unknown, output?: unknown}|undefined} result
 * @returns {unknown[]}
 */
function partsOf(result) {
  const { content, output } = result ?? {};
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content) && content.length > 0) return [...content];
  if (output === undefined) return [];
  return [{ type: 'text', text: typeof output === 'string' ? output : (JSON.stringify(output) ?? String(output)) }];
}

/**
 * A tool's result with text added as its last part: what the model reads
 * after the tool's own words (F29). A new object; the one given is not
 * changed.
 *
 * Last, as Claude Code placed it, after the result. Open Code cuts the tail
 * of a result over 2000 lines or 51200 bytes after this hook unless the tool
 * cut it itself (F34); the results of write, edit and patch are a line per
 * file (F43), so that is a patch of thousands of files.
 *
 * On a line of its own. A provider may hand the model the parts of one
 * result run together: a model on OpenAI's, repeating a patch's result
 * verbatim, ran the last file the tool named into the first word of the text
 * (F263). So after the tool's words, the part starts with a line break.
 *
 * @template {{content?: unknown, output?: unknown}} R
 * @param {R} result
 * @param {string} text
 * @returns {R & {content: unknown[]}}
 */
export function withText(result, text) {
  const parts = partsOf(result);
  return { ...result, content: [...parts, { type: 'text', text: parts.length > 0 ? `\n${text}` : text }] };
}
