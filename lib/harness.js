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

// The identifiers the harness gives the things pdkit records.
//
// A few values pdkit stores come from the harness, not from pdkit: the session
// a task was started in, the ID of an agent's run. Their names and formats are
// the harness's, and they changed when the harness did, so they live here and
// nowhere else in lib/ — test/invariants.test.js holds that. Everything else
// reads them through this module and does not know which harness set them.
//
// A leaf: it imports nothing.

/**
 * The environment variable that names the session a shell command runs in.
 *
 * Open Code's shell tool sets it on every command the model runs, after the
 * plugin's own hook on the command's environment has run, so the plugin can
 * neither set nor change it. A subagent's commands carry the subagent's own
 * session, not the one that started it. A command a person types with `!` in
 * the TUI carries none.
 *
 * `CLAUDE_CODE_SESSION_ID` is not read. Under Open Code it can only be left
 * over from an environment Claude Code started — the client's, or the
 * server's — and it names a session of the other harness.
 */
export const SESSION_VARIABLE = 'OPENCODE_SESSION_ID';
