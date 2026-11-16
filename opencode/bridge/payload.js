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

// Open Code events, as the payloads pdkit's hook handlers read.
//
// The handlers in lib/hooks/ were written against Claude Code's hook payload,
// and they stay that way: what changed is the host, not the rules. So the
// bridge hands each handler the payload Claude Code would have sent for the
// same moment, built here from the event Open Code passes to the plugin's
// callback. Pure functions: whatever needs the host is passed in as data.
//
// Three fields are always set. `hook_event_name`, because runHook shapes its
// output by it. `cwd`, because a handler that is given none falls back to its
// own working directory, and the bridge's process runs where the server was
// started, not where the session works. `session_id`, as Claude Code sent it.
// `transcript_path` never: Open Code keeps no transcript file to point at.

import { isAbsolute, resolve } from 'node:path';

/**
 * The directory a command runs in: the shell tool's `workdir`, which Open
 * Code resolves against the session's directory, or that directory itself.
 * Undefined when neither names one, which the runner refuses to guess at.
 *
 * @param {string|undefined} directory  the plugin instance's ctx.location.directory
 * @param {unknown} workdir
 * @returns {string|undefined}
 */
function workingDirectory(directory, workdir) {
  const given = typeof workdir === 'string' && workdir !== '' ? workdir : undefined;
  if (given && isAbsolute(given)) return given;
  if (typeof directory !== 'string' || directory === '') return undefined;
  return given ? resolve(directory, given) : directory;
}

/**
 * The payload for `pdkit hook pre-bash`: Claude Code's PreToolUse on Bash.
 *
 * `tool_name` is `Bash` whatever the tool is called here. The entry point hands
 * the gate every call that carries a command (opencode/server.js says why), and
 * dispatch.js lets through anything not named Bash — the name is the matcher
 * Claude Code applied before the handler ran, and here the entry point has
 * applied it already.
 *
 * @param {{tool?: string, sessionID?: string, input: {command: string, workdir?: unknown}}} event
 *   execute.before's event
 * @param {string|undefined} directory  ctx.location.directory
 * @returns {{hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {command: string}, cwd?: string, session_id?: string}}
 */
export function preBash(event, directory) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: event.input.command },
    // `workdir` is the shell tool's; another tool's field of that name means
    // whatever that tool says it means.
    cwd: workingDirectory(directory, event.tool === 'shell' ? event.input.workdir : undefined),
    session_id: event.sessionID,
  };
}
