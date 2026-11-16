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

// The agents: agents/*.md registered with Open Code, each on its own model.
//
// Claude Code read agents/ from the plugin directory by itself. Open Code
// reads agent files only from its own config directories, so the plugin adds
// its agents through ctx.agent.transform instead.
//
// A transform callback must not throw: Open Code disables a plugin whose
// transform fails, and with it the gate.

/**
 * @param {object} ctx the plugin context setup() received
 * @param {{root: string, settings: {models: Readonly<Record<string, string>>}, log: (line: string) => void}} plugin
 */
export async function registerAgents(ctx, plugin) {
  void plugin;
  // TODO(T5.A): add agents/*.md with their models.
  await ctx.agent.transform(() => {});
}
