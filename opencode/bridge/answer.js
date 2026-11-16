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
// refuse the call, let it through — and lists what has no way to anyone
// here. A row per pdkit event the bridge carries; pure.
//
// What has no way: before a tool runs, Open Code gives a plugin a throw and
// nothing else — no text that reaches the model beside a call it lets through,
// and no line for the person (the plugin has no notice channel, D12). Claude
// Code did no better with a message on PreToolUse: plain stdout from a hook
// that exits 0 went to its debug log, which neither the model nor the person
// sees. So a pre-hook's message and any notice are `dropped` — listed, not
// lost silently — and the bridge writes them where it writes its own failures.

/** @typedef {import('../../lib/hooks/runner.js').Decision} Decision */

/**
 * @typedef {{kind: 'refuse', text: string} | {kind: 'pass'}} Action
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

/** @type {Record<string, (decision: Decision) => Answer>} */
const ANSWERS = {
  // A refusal is a throw, whose text the model gets as the call's error and
  // the person sees under the failed call. runner.decide has already made a
  // run that gave no answer into a refusal (FAIL_CLOSED).
  'pre-bash': (decision) => ({
    action: decision.block ? { kind: 'refuse', text: decision.reason } : PASS,
    dropped: unheard(decision, ['message', 'notice']),
  }),
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
