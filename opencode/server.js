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

// The server part of the Open Code plugin: the package's "." export, loaded
// inside the Open Code server rather than run as a separate process.
//
// Everything that knows about Open Code lives under opencode/. lib/ stays the
// harness-free core it was under Claude Code, and this directory is the glue
// between the two.
//
// This file is thin on purpose, and its order is the point of it. A plugin
// that throws while loading — on import or in setup() — is simply not loaded:
// Open Code starts the session without it and runs every command, so the gate
// on writes upstream would be off without anyone being told. setup() therefore
//
//   1. registers the gate's execute.before callback before anything that can
//      fail, so that from then on there is a callback to refuse with;
//   2. loads the rest — the hook bridge, the registrars, the settings, the
//      version check — inside one try. If any of it fails, the gate refuses
//      every command, in text written here: the module a shared text would
//      come from may be the one that failed. Every other hook is left
//      unregistered, which is how the other hooks fail: open;
//   3. compares the running Open Code with engines.opencode in package.json,
//      the one place the minimum is written (Open Code ignores the field);
//   4. registers hooks, the shell environment that puts `pdkit` on PATH,
//      the answer that keeps the plugin's own files readable, agents,
//      commands and skills — or, below the minimum, only `/pd:*` commands
//      that refuse and say which version to install.
//
// Nothing after step 1 throws out of setup(). A registrar that fails is
// reported and skipped; the gate does not depend on it.
//
// The imports in step 2 are literal on purpose: Open Code reloads a plugin when
// a module it imports changes, and it only sees an import whose specifier is a
// string literal.
//
// The default export is a plain `{ id, setup }` object, not a call to
// `Plugin.define` from `@opencode/plugin`. `define` returns its argument
// unchanged, and the host loads a plain object the same way. The import would
// resolve inside Open Code, which supplies the package itself, and nowhere else:
// the plugin ships zero dependencies, so plain Node — `node --test` included —
// would refuse to load this file with ERR_MODULE_NOT_FOUND.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** One name for the repository, the npm package and the plugin. */
const ID = 'opencode-pdkit';

/** The plugin's root: the package directory, one level above this file. */
const ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * @param {unknown} error
 * @returns {string}
 */
const reason = (error) => (error instanceof Error ? error.message : String(error));

/**
 * One line to the server's stderr. The plugin API has no log of its own:
 * `opencode serve` run in a terminal prints the line there (with
 * `--print-logs`, among its own log lines); it never reaches the server's log
 * files, and the background service's stderr reaches no one.
 *
 * @param {string} line
 */
function log(line) {
  console.error(`${ID}: ${line}`);
}

/**
 * What the gate says when the plugin could not load. Worded like the refusal
 * `pdkit hook pre-bash` gives when its handler cannot run, since it is the
 * same failure one step earlier; a test holds the two to the same advice.
 *
 * @param {string} cause
 * @returns {string}
 */
function refusal(cause) {
  return (
    `pdkit: hook "pre-bash" cannot run: the ${ID} plugin failed to load (${cause}). This hook guards writes to ` +
    'the upstream repository, so it refuses rather than allows when it cannot run. Fix the plugin or disable it ' +
    '— do not work around this by rephrasing the command.'
  );
}

/**
 * Step 2: everything past the gate's callback. Never throws; a failure comes
 * back as `{ failure }`.
 *
 * @param {object} ctx
 */
async function load(ctx) {
  try {
    const { createBridge } = await import('./bridge/hooks.js');
    const { registerEnvironment } = await import('./environment.js');
    const { registerAccess } = await import('./access.js');
    const { registerAgents } = await import('./agents.js');
    const { registerCommands, registerRefusals } = await import('./commands.js');
    const { readOptions } = await import('./options.js');
    const { checkOpenCode, minimumVersion } = await import('../lib/opencode-version.js');

    const plugin = { root: ROOT, settings: readOptions(ctx.options), log };
    return {
      plugin,
      bridge: createBridge(ctx, plugin),
      registerEnvironment,
      registerAccess,
      registerAgents,
      registerCommands,
      registerRefusals,
      checkOpenCode,
      minimumVersion,
    };
  } catch (error) {
    return { failure: reason(error) };
  }
}

/** engines.opencode from package.json, or undefined when it cannot be read. */
async function minimumRange() {
  try {
    return JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).engines?.opencode;
  } catch {
    return undefined;
  }
}

export default {
  id: ID,

  async setup(ctx) {
    let settle;
    const loading = new Promise((resolve) => {
      settle = resolve;
    });

    // Step 1. Open Code waits for setup() to finish before it runs a tool, so
    // the wait on `loading` is for safety, not for a race seen in practice.
    //
    // Every call that carries a command, not only the shell tool's. The shell
    // tool is what runs commands here, and a call to `bash` reaches this
    // callback already renamed to `shell`; but a tool from an MCP server or
    // another plugin can take a command too, and Claude Code's gate, which
    // matched on its Bash tool alone, never saw those. Checking them is
    // stricter than it was, and harmless where the command is not one the gate
    // has a rule for.
    //
    // pre-bash's row in the bridge's table of points (WIRING in
    // bridge/hooks.js) names this callback as the entry point's; the bridge
    // registers every other event.
    await ctx.tool.hook('execute.before', async (event) => {
      if (typeof event?.input?.command !== 'string') return;
      const loaded = await loading;
      if (loaded.failure !== undefined) throw new Error(refusal(loaded.failure));
      await loaded.bridge.preBash(event);
    });

    // Step 2.
    const loaded = await load(ctx);
    settle(loaded);

    const cleanups = [];
    let cleaned = false;
    // Open Code disposes every registration itself when it unloads the plugin
    // (on a reload, on an update, when the server stops); what is left to
    // release is the plugin's own state.
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      for (const release of cleanups.reverse()) {
        try {
          await release();
        } catch (error) {
          log(`cleanup failed: ${reason(error)}`);
        }
      }
    };

    if (loaded.failure !== undefined) {
      log(`failed to load (${loaded.failure}); every command is refused until it loads`);
      return cleanup;
    }
    cleanups.push(() => loaded.bridge.cleanup());

    const register = async (what, registration) => {
      try {
        await registration();
      } catch (error) {
        log(`cannot register its ${what} (${reason(error)}); the gate and the rest are unaffected`);
      }
    };

    // Step 3.
    const host = loaded.checkOpenCode(ctx.app, loaded.minimumVersion(await minimumRange()));
    if (host.status === 'unknown') log(`${host.detail}; loading in full`);

    // Step 4.
    if (host.status === 'below') {
      const update = `${ID} requires Open Code >= ${host.minimum}, running ${host.version}. Update it with: opencode upgrade`;
      log(`${update}. Until then only the upstream gate runs, and every /pd:* command refuses.`);
      await register('refusing commands', () =>
        loaded.registerRefusals(ctx, loaded.plugin, {
          summary: `Unavailable: ${ID} requires Open Code >= ${host.minimum}`,
          refusal: update,
        }),
      );
      return cleanup;
    }

    await register('hooks', () => loaded.bridge.register());
    await register('shell environment', () => loaded.registerEnvironment(ctx, loaded.plugin));
    await register('access to its own files', () => loaded.registerAccess(ctx, loaded.plugin));
    await register('agents', () => loaded.registerAgents(ctx, loaded.plugin));
    await register('commands and skills', () => loaded.registerCommands(ctx, loaded.plugin));
    return cleanup;
  },
};
