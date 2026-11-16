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
// handler reads, runs the handler in a child process, and turns its answer back
// into what Open Code understands — a throw, text added to a tool result, a
// message to the session.
//
// It is the one module of the bridge the entry point loads, and it loads the
// rest itself. The entry point registers the gate's callback before loading
// anything, and hands each shell command to preBash() once this module has
// loaded; if it fails to load, the entry point refuses every shell command on
// its own, so a broken bridge cannot leave the gate open.
//
// For now nothing is bridged: preBash() lets every command through, and the
// one other callback changes nothing.

/**
 * The bridge for one loaded instance of the plugin. Open Code loads the plugin
 * once per project directory and calls setup() for each, so whatever the
 * bridge remembers between callbacks lives here, per instance, and goes away
 * with cleanup().
 *
 * @param {object} ctx the plugin context setup() received
 * @param {{root: string, settings: {models: Readonly<Record<string, string>>}, log: (line: string) => void}} plugin
 * @returns {{
 *   preBash: (event: {tool: string, input?: object}) => Promise<void>,
 *   register: () => Promise<void>,
 *   cleanup: () => Promise<void>,
 * }}
 */
export function createBridge(ctx, plugin) {
  void plugin;

  return {
    /**
     * pre-bash, for one shell command. Throwing refuses it; the message is
     * what the model and the person see.
     */
    async preBash() {
      // TODO(T4.5): run the pre-bash handler; refuse what it blocks and anything it cannot decide.
    },

    /** Register every hook but the gate, which the entry point owns. */
    async register() {
      // TODO(T4.6–T4.14): one registration per pdkit hook event.
      await ctx.tool.hook('execute.after', () => {});
    },

    async cleanup() {},
  };
}
