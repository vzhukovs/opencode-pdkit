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

// post-read handler, after the read and grep tools: a read that stopped
// inside a block.
//
// post-bash catches `grep -A60` and `sed -n a,bp` in the shell, and files are
// read with the read and grep tools too — Claude Code told its model to
// prefer its Read and Grep over the shell. Those cut too: Open Code's read
// returns at most 2000 lines and 50 KB of a file unless told otherwise, and
// the extension API declarations run past 4500 lines, so a plain read of them
// ends long before the newest namespace members; grep stops at its `limit` of
// matches. A hook on the shell alone would miss every read made with a tool.
//
// Same two facts as post-bash: the tool reported a window, and the output
// ends with more `{` opened than closed (cut.js). The window is the tool's own
// report, not guessed, and reaches this handler in the payload it was written
// against — Claude Code's PostToolUse on Read or Grep, which the hook bridge
// builds (opencode/bridge/payload.js): which lines a read returned, out of how
// many the file has, and the limit a grep cut its matches at. A read does not
// report the count for a page with lines after it; the bridge counts them on
// disk, as the tool does. The payload's other window, Grep's context lines
// (`-A`/`-B`/`-C`), was Claude Code's: Open Code's grep has none, and the
// bridge never sets them.
//
// Not scoped to podman-desktop, for the same reason as post-bash.

import { cutDecision } from './cut.js';

const CONTEXT_OPTIONS = ['-A', '-B', '-C', 'context'];

/**
 * The window a Read returned, or null when it returned the whole file.
 *
 * @param {{content?: string, startLine?: number, numLines?: number, totalLines?: number, truncatedByTokenCap?: boolean}} file
 * @returns {string|null}
 */
export function readWindow(file) {
  const start = Number(file?.startLine ?? 1);
  const count = Number(file?.numLines ?? 0);
  const total = Number(file?.totalLines ?? 0);
  if (!count || !total) return null;
  const end = start + count - 1;
  if (start <= 1 && end >= total && !file.truncatedByTokenCap) return null;
  return `Read lines ${start}-${end} of ${total}`;
}

/**
 * The windows a Grep applied: context around matches, and a cap on the output.
 *
 * @param {Record<string, unknown>} input
 * @param {{appliedLimit?: number}} response
 * @returns {string[]}
 */
export function grepWindows(input, response) {
  const found = [];
  for (const option of CONTEXT_OPTIONS) {
    const value = Number(input?.[option] ?? 0);
    if (value > 0) found.push(`Grep ${option === 'context' ? '-C' : option} ${value}`);
  }
  // The cap by the name Open Code's grep tool gives it, because the rule tells
  // the model to widen the window, and the tool drops a parameter it does not
  // have: Claude Code's `head_limit` would come back with the same matches.
  // The context options above are Claude Code's; Open Code's grep has none.
  if (response?.appliedLimit != null) found.push(`grep limit ${response.appliedLimit}`);
  return found;
}

/**
 * Say so when a read or a grep stopped inside a block.
 *
 * @param {{tool_name?: string, tool_input?: Record<string, unknown>, tool_response?: any}|null} payload
 * @param {{event: string, pluginRoot: string}} context
 * @returns {Promise<import('./dispatch.js').Decision>}
 */
export async function handle(payload, context) {
  const response = payload?.tool_response;
  if (payload?.tool_name === 'Read') {
    const window = readWindow(response?.file);
    return cutDecision(window ? [window] : [], String(response?.file?.content ?? ''), context?.pluginRoot);
  }
  if (payload?.tool_name === 'Grep') {
    if (typeof response?.content !== 'string') return { block: false };
    return cutDecision(grepWindows(payload.tool_input, response), response.content, context?.pluginRoot);
  }
  return { block: false };
}
