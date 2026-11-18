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

// The environment check behind `/pd:doctor`.
//
// Two rules shape every check here. Nothing is reported as available without
// being exercised — a doctor that trusts a config file tells the user what
// they wrote, not what they have. And a missing optional dependency is
// reported together with what degrades because of it: "no Playwright" is not
// actionable, "no Playwright, so /pd:validate produces a checklist and never
// sets PASS" is.

import { execFile, spawn } from 'node:child_process';
import { constants as FS } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { dirname, extname, join, resolve as absolute } from 'node:path';
import { promisify } from 'node:util';

import { start as startTask } from './active.js';
import { DEFAULTS_PATH, definedIn, expandTilde, get, layers, load, paths, resolveHome, trustedValue } from './config.js';
import * as git from './git.js';
import { HOOK_HANDLERS } from './hooks/events.js';
import { read as readJournal, resolveSince } from './journal.js';
import * as server from './opencode-api.js';
import { compareVersions, minimumVersion } from './opencode-version.js';
import { UNKNOWN_LAYER, resolveRepoRoot } from './repo.js';
import { checkedProgram } from './reveal.js';
import { setOwns } from './state.js';
import { list as listWorktrees, rootFor } from './worktree.js';
import { parse } from './yaml.js';

const run = promisify(execFile);

/**
 * What "can this be launched" means to `access`.
 *
 * `X_OK` is a POSIX permission bit. Windows has none, and `access` there
 * succeeds for any file that exists whatever mode is asked for — so asking for
 * `X_OK` and reporting the answer as "executable" would be reporting on a
 * question the platform never answered.
 */
const EXECUTABLE = platform() === 'win32' ? FS.F_OK : FS.X_OK;

/** Levels, in the order they are printed. */
export const LEVELS = ['required', 'optional', 'later'];

/**
 * Config keys the plugin stopped reading, and what to say about each.
 *
 * A list rather than a chain of ifs because there will be more: `init` copies
 * the shipped file whole, so every key retired after somebody ran it lives on
 * in their config, indistinguishable from a setting they meant.
 */
export const RETIRED_KEYS = [
  {
    key: 'gates.require_states',
    why:
      'is no longer read (deleted in 0.6). The eligible states live in state.GATE_ELIGIBLE, keyed by push ' +
      'and reply — a config key could only widen them. Delete the key.',
  },
];

/**
 * One thing the environment was asked about, and what came back.
 *
 * `level` is what separates a broken install from a narrower plugin: `required`
 * failing means nothing works, `optional` failing means something degrades and
 * the detail says what. Nothing is reported `ok` without being exercised — a
 * doctor that reads config tells you what you wrote, not what you have.
 *
 * @typedef {object} Check
 * @property {string} id
 * @property {'required'|'optional'|'later'} level
 * @property {'ok'|'warn'|'fail'|'skip'} status
 * @property {string} detail
 */

/**
 * Run a command just to see whether it is there and working.
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<{ok: boolean, stdout: string, error?: string}>}
 */
async function probe(command, args) {
  try {
    const { stdout } = await run(command, args, { encoding: 'utf8', timeout: 15000 });
    return { ok: true, stdout: stdout.trim() };
  } catch (error) {
    return { ok: false, stdout: (error.stdout ?? '').trim(), error: error.code === 'ENOENT' ? 'not found' : error.message.split('\n')[0] };
  }
}

/**
 * @param {string} id
 * @param {'required'|'optional'|'later'} level
 * @param {'ok'|'warn'|'fail'|'skip'} status
 * @param {string} detail
 * @returns {Check}
 */
function check(id, level, status, detail) {
  return { id, level, status, detail };
}

/**
 * The running Node against package.json engines.node.
 *
 * Compared to the patch, not by major: `node:sqlite`, which `pdkit cost` reads
 * Open Code's sessions with, needs no flag only from 22.13.0, so a 22.12 is
 * as short of the minimum as a 20.
 *
 * @param {unknown} range engines.node as package.json has it
 * @returns {Check}
 */
export function checkNode(range) {
  const minimum = minimumVersion(range);
  if (minimum === null) {
    return check('node', 'required', 'fail', `${process.version}; package.json engines.node is ${JSON.stringify(range)}, not ">=X.Y.Z"`);
  }
  return compareVersions(process.versions.node, minimum) >= 0
    ? check('node', 'required', 'ok', `${process.version}`)
    : check('node', 'required', 'fail', `${process.version}, need >= ${minimum}`);
}

/**
 * Required external tools.
 *
 * @param {unknown} nodeRange engines.node
 * @returns {Promise<Check[]>}
 */
async function checkTools(nodeRange) {
  const checks = [checkNode(nodeRange)];

  for (const [id, command, args] of [
    ['git', 'git', ['--version']],
    ['pnpm', 'pnpm', ['--version']],
    ['gh', 'gh', ['--version']],
  ]) {
    const result = await probe(command, args);
    checks.push(
      result.ok
        ? check(id, 'required', 'ok', result.stdout.split('\n')[0])
        : check(id, 'required', 'fail', `${command}: ${result.error}`),
    );
  }

  const auth = await probe('gh', ['auth', 'status']);
  checks.push(
    auth.ok
      ? check('gh-auth', 'required', 'ok', 'authenticated')
      : check('gh-auth', 'required', 'fail', 'gh is not authenticated — run `gh auth login`'),
  );

  if (auth.ok) {
    // REST auth is not GraphQL auth. Review threads, their resolution state and
    // the reply mutation are GraphQL-only, and a token minted without the scope
    // fails at the one point where the failure is expensive: mid-sync, with
    // half the feedback read. Asking a trivial query costs one request.
    const graphql = await probe('gh', ['api', 'graphql', '-f', 'query=query { viewer { login } }']);
    checks.push(
      graphql.ok
        ? check('gh-graphql', 'required', 'ok', 'review threads are readable')
        : check(
            'gh-graphql',
            'required',
            'fail',
            `gh can authenticate but cannot query GraphQL, which is where review threads live: ${graphql.error}`,
          ),
    );
  }

  return checks;
}

/**
 * The configuration layers, and whether each one loads.
 *
 * @param {{repoRoot?: string, home: string}} options
 * @returns {Promise<Check[]>}
 */
async function checkConfig(options) {
  const checks = [];

  for (const layer of layers(options)) {
    try {
      await stat(layer.path);
    } catch {
      checks.push(
        layer.required
          ? check(`config:${layer.name}`, 'required', 'fail', `missing: ${layer.path}`)
          : check(`config:${layer.name}`, 'optional', 'skip', `not present: ${layer.path}`),
      );
      continue;
    }
    checks.push(check(`config:${layer.name}`, 'required', 'ok', layer.path));
  }

  try {
    const config = await load(options);
    checks.push(check('config:merge', 'required', 'ok', 'all present layers parse and merge'));

    // Keys nobody reads any more. `init` copies the whole shipped file, so a
    // key retired later survives in personal configs looking exactly like a
    // setting somebody chose — and in both cases below, looking like it does
    // something it has not done since the version named.
    const retired = RETIRED_KEYS.filter((entry) => get(config, entry.key) !== undefined);
    checks.push(
      retired.length === 0
        ? check('config:gates', 'optional', 'ok', 'no retired keys')
        : check('config:gates', 'optional', 'warn', retired.map((entry) => `${entry.key} ${entry.why}`).join(' ')),
    );
    checks.push(...(await checkPinnedArrays(options)));
  } catch (error) {
    checks.push(check('config:merge', 'required', 'fail', error.message));
  }

  return checks;
}

/**
 * Every dotted path in an object whose value is an array.
 *
 * @param {unknown} node
 * @param {string} [prefix]
 * @returns {string[]}
 */
function arrayPaths(node, prefix = '') {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return [];

  const found = [];
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(value)) found.push(path);
    else found.push(...arrayPaths(value, path));
  }

  return found;
}

/**
 * Arrays a personal config copied from the defaults and then stopped tracking.
 *
 * Arrays replace wholesale rather than merging (lib/config.js), which is right:
 * a list the user edited must not be silently re-extended. The cost is that a
 * list they never edited — copied verbatim by `pdkit init` — freezes at the
 * shipped value of that day, and every later change to the default reaches
 * everyone except them.
 *
 * Found by running `pdkit knowledge check` on a real machine: the layer order
 * decision 27 extended in stage 3 had never taken effect here, because
 * $PDKIT_HOME/config.yaml still held the stage-0 copy. Nothing else could have
 * noticed — every command reads the merged value and it was a perfectly valid
 * list.
 *
 * @param {{repoRoot?: string, home?: string}} options
 * @returns {Promise<Check[]>}
 */
async function checkPinnedArrays(options) {
  const stale = [];

  let defaults;
  let effective;
  try {
    defaults = parse(await readFile(DEFAULTS_PATH, 'utf8'));
    effective = await load(options);
  } catch {
    return [check('config:arrays', 'optional', 'skip', 'the defaults or the merged configuration could not be read')];
  }

  // Every array in the defaults, not a list of four written down once. The
  // check said "no list has fallen behind the shipped defaults" while looking
  // at slicing.layer_order, quickfix.forbid_paths, validation-related lists and
  // worktrees.copy_files — so `review.bots_collapsed`, which had frozen at its
  // stage-0 value of [coderabbitai], passed it. codecov's comment was then
  // counted as a human's, on a real pull request. A check whose message is
  // wider than its measurement is the failure this plugin keeps finding in
  // itself; the fix is to make the measurement match the sentence.
  for (const path of arrayPaths(defaults)) {
    const shipped = get(defaults, path);
    const current = get(effective, path);

    if (!Array.isArray(shipped) || !Array.isArray(current)) continue;

    const missing = shipped.filter((entry) => !current.includes(entry));
    if (missing.length > 0) stale.push(`${path} is missing ${missing.join(', ')}`);
  }

  if (stale.length === 0) return [check('config:arrays', 'optional', 'ok', 'no list has fallen behind the shipped defaults')];

  return [
    check(
      'config:arrays',
      'optional',
      'warn',
      `${stale.join('; ')}. Arrays replace rather than merge, so a list copied by \`pdkit init\` and never edited ` +
        'stays at the value shipped that day. Delete the key to follow the default again, or extend it deliberately.',
    ),
  ];
}

/**
 * $PDKIT_HOME and everything `pdkit init` is supposed to have put in it.
 *
 * @param {string} home
 * @param {string|null} repoRoot
 * @returns {Promise<Check[]>}
 */
async function checkHome(home, repoRoot) {
  const layout = paths(home);
  const checks = [];

  try {
    await stat(layout.home);
    checks.push(check('home', 'required', 'ok', layout.home));
  } catch {
    return [check('home', 'required', 'fail', `${layout.home} does not exist — run \`pdkit init\``)];
  }

  let mapStat = null;
  try {
    mapStat = await stat(layout.packageMap);
    checks.push(check('package-map', 'required', 'ok', layout.packageMap));
  } catch {
    checks.push(check('package-map', 'required', 'fail', 'no package map — run `pdkit init`'));
  }

  // A map older than the workspace file describes packages that may no longer
  // exist. Not fatal — every command still runs — but every layer decision it
  // feeds is made from a stale list.
  if (mapStat && repoRoot) {
    try {
      const workspace = await stat(join(repoRoot, 'pnpm-workspace.yaml'));
      checks.push(
        workspace.mtimeMs <= mapStat.mtimeMs
          ? check('package-map:fresh', 'required', 'ok', 'newer than pnpm-workspace.yaml')
          : check('package-map:fresh', 'optional', 'warn', 'pnpm-workspace.yaml changed since the map was built — run `pdkit init`'),
      );
    } catch {
      checks.push(check('package-map:fresh', 'required', 'fail', 'the repository has no pnpm-workspace.yaml'));
    }
  }

  if (mapStat) {
    const map = JSON.parse(await readFile(layout.packageMap, 'utf8'));
    const unclaimed = Object.entries(map.packages)
      .filter(([, entry]) => entry.layer === UNKNOWN_LAYER)
      .map(([name]) => name);

    // Naming the file that decides the list is the point of the second line.
    // `pdkit init` copies the whole defaults file into $PDKIT_HOME, so a
    // layer_order the plugin has since extended goes on being shadowed by that
    // copy — and the warning then looks like a defect in the shipped defaults.
    const source = definedIn('slicing.layer_order', { repoRoot: repoRoot ?? undefined, home: layout.home });

    checks.push(
      unclaimed.length === 0
        ? check('package-map:layers', 'optional', 'ok', 'every package belongs to a layer')
        : check(
            'package-map:layers',
            'optional',
            'warn',
            `no layer claims ${unclaimed.join(', ')} — extend slicing.layer_order in ${source?.path ?? 'the config'} ` +
              'and re-run `pdkit init`, or accept that the merge order of those packages is decided by nothing',
          ),
    );
  }

  return checks;
}

/**
 * Working trees: where they go, and whether git still believes in them.
 *
 * Slice verification builds in one of these, so a root that cannot be written
 * or a tree git has lost track of turns into a verification failure that looks
 * like a failing slice. Worth a line in the report rather than a surprise mid
 * flow.
 *
 * @param {{repoRoot: string|null, config: import('./config.js').Config}} options
 * @returns {Promise<Check[]>}
 */
async function checkWorktrees(options) {
  if (!options.repoRoot) return [];

  const root = await rootFor({ repoRoot: options.repoRoot, config: options.config });
  const checks = [];

  // Checked, not created. A diagnostic that makes the thing it is diagnosing
  // reports on its own side effects, and the first time this ran it left an
  // empty directory in a workspace nobody asked it to touch.
  try {
    await access(root, FS.W_OK);
    checks.push(check('worktrees:root', 'optional', 'ok', root));
  } catch {
    try {
      await access(dirname(root), FS.W_OK);
      checks.push(check('worktrees:root', 'optional', 'ok', `${root} (not there yet; the parent is writable)`));
    } catch (error) {
      checks.push(check('worktrees:root', 'optional', 'warn', `cannot write ${root} (${error.code ?? error.message})`));
      return checks;
    }
  }

  const trees = await listWorktrees(options.repoRoot);
  const missing = [];
  for (const tree of trees.filter((entry) => !entry.main)) {
    try {
      await access(tree.path);
    } catch {
      missing.push(tree.path);
    }
  }

  checks.push(
    missing.length === 0
      ? check('worktrees:registered', 'optional', 'ok', `${trees.length} tree(s), all present`)
      : check(
          'worktrees:registered',
          'optional',
          'warn',
          `git lists ${missing.length} tree(s) that are not on disk (${missing.join(', ')}) — run \`git worktree prune\``,
        ),
  );

  return checks;
}

/**
 * The repository this run would act on.
 *
 * @param {{cwd?: string, config: import('./config.js').Config}} options
 * @returns {Promise<{checks: Check[], root: string|null}>}
 */
async function checkRepo(options) {
  const repo = await resolveRepoRoot(options);

  if (!repo.root) {
    return { checks: [check('repo', 'required', 'fail', repo.problems.join('; '))], root: null };
  }
  if (!repo.matches) {
    return {
      checks: [check('repo', 'required', 'fail', `${repo.root}: ${repo.problems.join('; ')}`)],
      root: repo.root,
    };
  }

  return { checks: [check('repo', 'required', 'ok', `${repo.root} (${Object.keys(repo.remotes).join(', ')})`)], root: repo.root };
}

/**
 * The hook events against the handlers that run them: every event of the
 * table has its module in the plugin.
 *
 * Under Claude Code this read hooks/hooks.json, a second list of the events
 * that the host ran, and held it to the table. The plugin for Open Code keeps
 * no such list: it registers every event of the table itself, and only those
 * — a test holds it to that — so what is left to look at from here is the
 * table's side, the modules a partial install can lack.
 *
 * TODO(T7.6): and that the plugin in the session that runs the doctor
 * registered each event, from what it says there.
 *
 * @param {string} pluginRoot
 * @returns {Promise<Check[]>}
 */
export async function checkHooks(pluginRoot) {
  const problems = [];

  for (const [event, handler] of Object.entries(HOOK_HANDLERS)) {
    try {
      await stat(join(pluginRoot, 'lib', 'hooks', handler));
    } catch {
      problems.push(`${event} -> lib/hooks/${handler} is missing`);
    }
  }

  return [
    problems.length === 0
      ? check('hooks', 'required', 'ok', `${Object.keys(HOOK_HANDLERS).length} events, every one has a handler`)
      : check('hooks', 'required', 'fail', problems.join('; ')),
  ];
}

/** How far back the `agent-done` liveness check looks. */
export const AGENT_RUNS_WINDOW = '30d';

/**
 * Has the subagent hook fired recently?
 *
 * The other half of `checkHooks`. That one proves every event has a handler
 * that exists; it cannot prove the host ever sends the event the handler is
 * registered on, and for four months it did not — the receipt gate sat on
 * `TaskCompleted`, which subagents never raise, and every check here stayed
 * green. A hook that never connected leaves the same trace as a hook with
 * nothing to catch, which is none (the note() in lib/hooks/dispatch.js is the
 * same failure on the Bash gate). `agent-done` is written on every subagent
 * finish, refused or not, so its absence over weeks of work means the wiring.
 *
 * A warning, not a failure: a fresh install, or a month with no issue work, has
 * no history to show and nothing wrong with it.
 *
 * @param {string} home
 * @param {number} [now] milliseconds, for tests
 * @returns {Promise<Check[]>}
 */
export async function checkAgentRuns(home, now = Date.now()) {
  const since = resolveSince(AGENT_RUNS_WINDOW, now);
  let runs;
  try {
    runs = await readJournal({ event: 'agent-done', since: since.at }, { home });
  } catch (error) {
    return [check('hooks:agent-done', 'optional', 'warn', `cannot read the journal (${error.code ?? error.message})`)];
  }

  if (runs.length === 0) {
    return [
      check(
        'hooks:agent-done',
        'optional',
        'warn',
        `no agent-done in the journal for ${AGENT_RUNS_WINDOW}. If subagents ran in that time, the SubagentStop ` +
          'hook is not connected and the receipt gate is off; run any subagent, then `pdkit journal --event agent-done`',
      ),
    ];
  }

  return [check('hooks:agent-done', 'optional', 'ok', `${runs.length} in the last ${AGENT_RUNS_WINDOW}, latest ${runs.at(-1).at}`)];
}

/**
 * The command that connects Playwright the way pdkit needs it.
 *
 * `--global`, because without it `opencode mcp add` writes the server into the
 * opencode.json of the directory it runs in, and a worktree is another
 * directory: none would see it.
 *
 * @param {number} port
 * @returns {string}
 */
function addPlaywright(port) {
  return `opencode mcp add playwright --global -- npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:${port}`;
}

/**
 * Whether a Playwright server is pointed at the port pdkit will use.
 *
 * Two ways to be connected and useless, and both read as healthy without this:
 * no `--cdp-endpoint` at all, and one aimed at a different port from
 * `validation.app.debug_port`. `validate launch` refuses a port something else
 * already answers on rather than picking another, so the endpoint is allowed to
 * be a constant — which is exactly why a stale one stays wrong.
 *
 * @param {string} command
 * @param {number} port
 * @returns {{ok: boolean, detail: string}}
 */
export function playwrightCdp(command, port) {
  const flag = /--cdp-endpoint[= ]+(\S+)/.exec(command);
  if (!flag) {
    return {
      ok: false,
      detail:
        'connected, but with no --cdp-endpoint: it will start a browser of its own and never see the ' +
        `application. Re-add it as: ${addPlaywright(port)}`,
    };
  }

  const endpoint = flag[1];
  const aimed = Number(/:(\d+)/.exec(endpoint)?.[1]);
  if (Number.isInteger(aimed) && aimed !== port) {
    return {
      ok: false,
      detail: `connected to ${endpoint}, but validation.app.debug_port is ${port}, so it will attach to nothing pdkit starts`,
    };
  }

  return { ok: true, detail: `attaches to ${endpoint}` };
}

/** What stops working without each server, so the report is actionable. */
const DEGRADES = {
  playwright: '/pd:validate produces a checklist instead of a run and never sets PASS',
  context7: 'library documentation lookups fall back to the model’s own knowledge',
  basic_memory: 'notes are not written to the vault',
  github: 'PR data comes from the gh CLI only',
};

/** The agent that drives the application through Playwright: the one whose tools decide whether validation runs. */
const VALIDATOR = 'pd-validator';

/**
 * The name a config gives a server pdkit expects, if it has one. `basic_memory`
 * is also found as `basic-memory`, and case is not looked at.
 *
 * @param {Map<string, unknown>} servers
 * @param {string} name
 * @returns {string|undefined}
 */
function nameIn(servers, name) {
  for (const candidate of [name.replaceAll('_', '-'), name]) {
    const found = [...servers.keys()].find((key) => key.toLowerCase() === candidate.toLowerCase());
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Whether pd-validator can use the Playwright server's tools, from the rules
 * Open Code gave it in this directory.
 *
 * The plugin allows it the six Playwright tools its agent file names, and no
 * other. Open Code then appends the rules of every config document, so a
 * top-level `permissions` in the person's config — `playwright_* deny`, meant
 * for the main session — lands after the plugin's and takes the tools away.
 * Nothing says so: the validator is simply not offered them, and validation
 * falls back to a checklist.
 *
 * @param {(path: string) => Promise<import('./opencode-api.js').Answer>} ask
 * @param {string} serverName as the config names it: the tools are named after it
 * @param {object} timing for server.waitFor
 * @returns {Promise<{checked: false, why: string} | {checked: true, prefix: string, tools: string[], taken: Array<{tool: string, rule: {action: string, resource: string, effect: string}}>}>}
 */
async function validatorTools(ask, serverName, timing) {
  const answer = await server.waitFor(() => ask('/api/agent'), (body) => server.agentRules(body, VALIDATOR) !== undefined, timing);
  if (!answer.ok) return { checked: false, why: answer.error };

  const rules = server.agentRules(answer.data, VALIDATOR);
  if (rules === undefined) return { checked: false, why: `${VALIDATOR} is not registered in this directory` };

  const prefix = server.toolPrefix(serverName);
  const tools = [
    ...new Set(
      rules
        .filter((rule) => rule.effect === 'allow' && typeof rule.action === 'string' && rule.action.startsWith(prefix) && !/[*?]/.test(rule.action))
        .map((rule) => rule.action),
    ),
  ];
  const taken = tools.flatMap((tool) => {
    const rule = server.takenBy(tool, rules);
    return rule ? [{ tool, rule }] : [];
  });

  return { checked: true, prefix, tools, taken };
}

/**
 * The Playwright line once the server is connected: aimed at pdkit's port, and
 * usable by the one agent that drives it.
 *
 * @param {{command: string, name: string, port: number, ask: Function, timing: object}} options
 * @returns {Promise<Check>}
 */
async function checkPlaywright({ command, name, port, ask, timing }) {
  // Present is not the same as pointed at us. Section 8.2 said this check
  // verified the endpoint; until 0.21 it verified the name and said so in the
  // same breath.
  const wiring = playwrightCdp(command, port);
  if (!wiring.ok) return check('mcp:playwright', 'optional', 'warn', wiring.detail);

  const validator = await validatorTools(ask, name, timing);
  if (!validator.checked) {
    return check('mcp:playwright', 'optional', 'ok', `${wiring.detail}; whether ${VALIDATOR} can use it was not checked: ${validator.why}`);
  }
  if (validator.tools.length === 0) {
    return check(
      'mcp:playwright',
      'optional',
      'warn',
      `${wiring.detail}, but ${VALIDATOR}'s rules allow none of its tools (${validator.prefix}*), so ${DEGRADES.playwright}`,
    );
  }
  if (validator.taken.length > 0) {
    const rules = [...new Set(validator.taken.map(({ rule }) => `${rule.action} ${rule.resource} ${rule.effect}`))];
    return check(
      'mcp:playwright',
      'optional',
      'warn',
      `${wiring.detail}, but ${VALIDATOR} is not offered ${validator.taken.length} of its ${validator.tools.length} tools ` +
        `(${validator.taken.map(({ tool }) => tool).join(', ')}): a later rule takes them, ${rules.map((rule) => `\`${rule}\``).join(', ')}. ` +
        'A top-level `permissions` in an Open Code config is added to every agent’s rules, the plugin’s included, ' +
        `so ${DEGRADES.playwright}. Remove the rule, or allow the tools again under agents.${VALIDATOR}.permissions in the same config`,
    );
  }

  return check('mcp:playwright', 'optional', 'ok', `${wiring.detail}; ${VALIDATOR} is offered all ${validator.tools.length} of its tools`);
}

/**
 * MCP servers the config expects, against what Open Code reports for the
 * directory.
 *
 * The plugin declares no MCP server on purpose (section 8), so this is a check
 * on the user's own Open Code configuration and it degrades to "cannot tell"
 * rather than guessing. Three answers of the server make it up: the config
 * documents (whether a server is turned on, and its command line — nothing
 * else carries that), the servers' status, and the rules pd-validator ends up
 * with.
 *
 * @param {import('./config.js').Config} config
 * @param {{directory: string, ask?: (path: string) => Promise<import('./opencode-api.js').Answer>, wait?: number, pause?: (ms: number) => Promise<unknown>, now?: () => number}} options
 * @returns {Promise<Check[]>}
 */
export async function checkMcp(config, options) {
  const expected = /** @type {Record<string, string>} */ (get(config, 'mcp') ?? {});
  const wanted = Object.entries(expected).filter(([, mode]) => mode !== 'off' && mode !== false);
  if (wanted.length === 0) return [check('mcp', 'optional', 'skip', 'no servers expected by config')];

  const ask = options.ask ?? ((path) => server.get(path, { directory: options.directory }));
  const now = options.now ?? Date.now;
  const wait = options.wait ?? server.WAIT_MS;
  const deadline = now() + wait;
  // One wait for the whole check: the server loads the directory once.
  const timing = () => ({ wait: Math.max(0, deadline - now()), pause: options.pause, now });
  const waited = `${Math.round(wait / 1000)} s`;

  // The documents are complete on the first answer, even for a directory the
  // server has not loaded yet; the statuses and agents are not.
  const documents = await ask('/api/config');
  if (!documents.ok) return [check('mcp', 'optional', 'skip', `cannot tell: ${documents.error}`)];

  const configured = server.mcpServers(documents.data);
  const port = Number(get(config, 'validation.app.debug_port') ?? 9222);
  const names = new Map(wanted.map(([name]) => [name, nameIn(configured, name)]));
  const expectedNames = [...names.values()].filter((name) => name !== undefined);

  let statuses = new Map();
  if (expectedNames.length > 0) {
    const listed = await server.waitFor(
      () => ask('/api/mcp'),
      (body) => {
        const current = server.mcpStatuses(body);
        return expectedNames.every((name) => current.has(name) && current.get(name).status !== 'pending');
      },
      timing(),
    );
    if (!listed.ok) return [check('mcp', 'optional', 'skip', `cannot tell: ${listed.error}`)];
    statuses = server.mcpStatuses(listed.data);
  }

  const checks = [];
  for (const [name, mode] of wanted) {
    const id = `mcp:${name}`;
    const actual = names.get(name);
    const status = actual === undefined ? undefined : statuses.get(actual);
    const degrades = DEGRADES[name] ?? 'the features that use it are unavailable';

    if (actual === undefined || status?.status === 'disabled') {
      const fix =
        name === 'playwright'
          ? `. Add it with: ${addPlaywright(port)} (--global, not the default: without it the server goes into this ` +
            'directory’s opencode.json, and no worktree would see it)'
          : '';
      checks.push(check(id, 'optional', mode === 'on' ? 'warn' : 'skip', `not configured — ${degrades}${fix}`));
      continue;
    }

    if (status === undefined) {
      checks.push(check(id, 'optional', 'skip', `cannot tell: configured, but Open Code did not list it within ${waited} — run pdkit doctor again`));
      continue;
    }
    if (status.status === 'pending') {
      checks.push(check(id, 'optional', 'skip', `cannot tell: configured, and still starting after ${waited} — run pdkit doctor again`));
      continue;
    }
    // A server that is configured and down is down. Claude Code's version read
    // the name off `claude mcp list` and dropped the status after it, so a
    // server that failed to start was reported like one that had (DV18).
    if (status.status === 'failed' || status.status === 'needs_auth') {
      const error = status.error ? `: ${status.error}` : '';
      checks.push(check(id, 'optional', 'warn', `configured, but Open Code reports it ${status.status}${error} — ${degrades}`));
      continue;
    }
    if (status.status !== 'connected') {
      checks.push(check(id, 'optional', 'skip', `cannot tell: Open Code reports it ${status.status}`));
      continue;
    }

    checks.push(
      name === 'playwright'
        ? await checkPlaywright({ command: configured.get(actual).command, name: actual, port, ask, timing: timing() })
        : check(id, 'optional', 'ok', 'connected'),
    );
  }

  return checks;
}

/**
 * Whether there is an application to validate against.
 *
 * "No Playwright" and "nothing to point Playwright at" are different problems
 * with different fixes, and the second is the one that is invisible: the MCP
 * server can be perfectly configured and /pd:validate still has nothing to
 * drive, because the working tree was never built.
 *
 * @param {{repoRoot: string|null, home?: string}} options
 * @returns {Promise<Check[]>}
 */
async function checkValidationTarget(options) {
  if (!options.repoRoot) return [check('validate:app', 'optional', 'skip', 'no repository to look in')];

  // Read the way validate launch reads them, so this reports what it will run
  // rather than what the merged config says — a repository layer's value is a
  // refusal there, and has to be one here.
  for (const key of ['validation.app.binary', 'validation.app.args']) {
    const read = trustedValue(key, { repoRoot: options.repoRoot, home: options.home });
    if ('error' in read) return [check('validate:app', 'optional', 'warn', `${read.error.split('\n')[0]}, so validate launch refuses to start`)];
  }

  const configured = String(trustedValue('validation.app.binary', { home: options.home }).value ?? '').trim();
  const fromEnv = String(process.env.PODMAN_DESKTOP_BINARY ?? '').trim();

  for (const [source, path] of [
    ['validation.app.binary', configured],
    ['PODMAN_DESKTOP_BINARY', fromEnv],
  ]) {
    if (!path) continue;
    const checked = await checkedProgram(expandTilde(path), { label: source });
    if (!checked.ok) return [check('validate:app', 'optional', 'warn', `${checked.reason}, so validate launch refuses it`)];
    try {
      await access(checked.path, EXECUTABLE);
      return [check('validate:app', 'optional', 'ok', `${path} (${source})`)];
    } catch {
      // Windows has no execute bit, so there the question this could ask is
      // only whether the file is there. Saying "not executable" about a file
      // whose permissions were never consulted would name the wrong problem.
      const why = platform() === 'win32' ? 'which is not there' : 'which is not executable here';
      return [check('validate:app', 'optional', 'warn', `${source} points at ${path}, ${why}`)];
    }
  }

  // The same candidates resolveBinary launches, and for the same reason: on
  // Windows `.bin/electron` is a shell script and the executable beside it is
  // `electron.exe`. Checking only the POSIX name reported electron as missing
  // on a tree that had it installed.
  const electron =
    platform() === 'win32'
      ? join(options.repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
      : join(options.repoRoot, 'node_modules', '.bin', 'electron');
  try {
    await access(electron, EXECUTABLE);
  } catch {
    return [
      check(
        'validate:app',
        'optional',
        'warn',
        'no packaged binary and no node_modules/.bin/electron — install dependencies, or /pd:validate has nothing to drive',
      ),
    ];
  }

  // Electron is there, but `electron .` runs whatever the last build left. An
  // unbuilt tree starts and shows nothing, which looks like a broken
  // application rather than a missing step.
  try {
    await access(join(options.repoRoot, 'packages', 'main', 'dist'));
    return [check('validate:app', 'optional', 'ok', 'node_modules/.bin/electron ., and the tree has been built')];
  } catch {
    return [
      check('validate:app', 'optional', 'warn', 'electron is installed but the tree has no build output — run the build, or `pdkit validate launch --build`'),
    ];
  }
}

/**
 * Commands the gate must refuse, and commands it must not.
 *
 * Both halves matter. A gate that refuses everything is as broken as one that
 * refuses nothing — it just fails in the direction where somebody turns it off.
 *
 * The deny list is every shape of `git push` that has ever been a way past a
 * substring match, the wrapped form included.
 */
export const GATE_PROBES = [
  { command: 'git push', deny: true, why: 'the bare form' },
  { command: 'git push --force origin main', deny: true, why: 'force, refused unconditionally' },
  // A wrapper program stands between the shell and the command it runs, and a
  // global hook installed for another project can put one there without this
  // one being told. The gate has to see through it: what matters is the `git
  // push` inside, not the program that spelled it.
  { command: 'nohup git push', deny: true, why: 'behind a wrapper program' },
  { command: 'pnpm test:unit && git push', deny: true, why: 'chained' },
  { command: '(git push)', deny: true, why: 'in a subshell' },
  { command: 'echo $(git push)', deny: true, why: 'in a substitution' },
  { command: '/usr/bin/git push', deny: true, why: 'named by path' },
  { command: 'git -C . push', deny: true, why: 'behind a global option' },
  { command: 'git add -A', deny: true, why: 'blanket staging' },
  { command: 'git commit --no-verify -m x', deny: true, why: 'skipping the hooks' },
  { command: 'git rebase -i main', deny: true, why: 'interactive rebase' },
  { command: 'gh pr create --base main --head x --title t', deny: true, why: 'opening a pull request' },
  { command: 'gh pr review 17577 --approve', deny: true, why: 'writing to an open pull request' },
  { command: 'gh pr comment 17577 --body x', deny: true, why: 'replying without a reply token' },
  { command: 'gh issue comment 17221 --body x', deny: true, why: 'writing to the tracker, which no state allows' },
  {
    command: 'gh api graphql -f query="mutation { resolveReviewThread(input: {threadId: \\"x\\"}) { thread { id } } }"',
    deny: true,
    why: 'a mutation naming no pull request',
  },

  // The gate, deny rules included, guards podman-desktop and stands aside
  // elsewhere — but only where that can be proven. `outside` probes run in a throwaway repository whose
  // only remote is somebody else's project.
  { command: 'git push origin main', deny: false, outside: true, why: 'a push in a repository that is not podman-desktop' },
  { command: 'git push --force origin main', deny: false, outside: true, why: "force, a house rule of podman-desktop's only" },
  { command: 'git add -A', deny: false, outside: true, why: "blanket staging, a house rule of podman-desktop's only" },
  { command: 'cd ../podman-desktop && git push', deny: true, outside: true, why: 'moving into podman-desktop first' },
  {
    command: 'git push git@github.com:podman-desktop/podman-desktop.git main',
    deny: true,
    outside: true,
    why: 'naming upstream from somewhere else',
  },

  { command: 'git status', deny: false, why: 'reading' },
  { command: 'git add packages/main/src/x.ts', deny: false, why: 'staging an explicit path' },
  { command: 'git commit -m "fix(main): x"', deny: false, why: 'an ordinary commit' },
  { command: 'gh pr view 1', deny: false, why: 'reading a pull request' },
  { command: 'gh api repos/o/r', deny: false, why: 'reading through the API' },
  { command: 'pnpm test:unit', deny: false, why: 'running tests' },
  // The plugin's own publish checks and spends the token itself, in-process.
  // Refused here, /pd:pr step 8 would be unrunnable — and a title that mentions
  // a push is text, not a push.
  {
    command: 'pdkit publish --issue 1 --branch DESKTOP-1/x --title "fix: retry the git push" --body body.md',
    deny: false,
    why: "pdkit's own publish, which checks the token itself",
  },
];

/**
 * How to spawn the handler the manifest declares.
 *
 * `bin/pdkit` is an extensionless script with a shebang, which POSIX executes
 * directly and Windows cannot execute at all — `spawn` there answers EFTYPE,
 * the probe reads it as `-1`, and the self-test reports the gate as broken on a
 * plugin that is fine. Running it through this process's own node is the same
 * program by the same entry point; only the thing that finds the interpreter
 * differs, which on POSIX is the shebang and here is us.
 *
 * Narrow on purpose: a handler with an extension, or one that is not ours, is
 * spawned exactly as written.
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {{command: string, args: string[]}}
 */
export function spawnableHook(command, args) {
  const shebangScript = platform() === 'win32' && extname(command) === '';
  return shebangScript ? { command: process.execPath, args: [command, ...args] } : { command, args };
}

/**
 * Feed one command to the hook exactly as Claude Code would.
 *
 * @param {{command: string, args: string[], commandLine: string, env: Record<string, string>, cwd: string}} input
 * @returns {Promise<number>} exit code
 */
function probeHook(input) {
  return new Promise((resolve) => {
    const spawnable = spawnableHook(input.command, input.args);
    const child = spawn(spawnable.command, spawnable.args, {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      stdio: ['pipe', 'ignore', 'ignore'],
    });

    child.on('error', () => resolve(-1));
    child.on('close', (code) => resolve(code ?? -1));
    child.stdin.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command: input.commandLine }, cwd: input.cwd }));
  });
}

/**
 * Exercise the push gate through the hook the manifest registers.
 *
 * Spawning the registered binary rather than importing the handler is the
 * whole point: this is the one check where "the code is correct" is not the
 * question. What is being tested is that the hook Claude Code will actually
 * run sees the command — a manifest pointing at the wrong file, a matcher on
 * the wrong tool, or a handler that stopped loading all produce a plugin that
 * looks installed and gates nothing.
 *
 * Runs against a throwaway $PDKIT_HOME. A real token for the current branch
 * would make `git push` legitimately allowed, which would read as a failure
 * here and would burn the token on a test.
 *
 * And in throwaway repositories, for the same kind of reason: the gate guards
 * podman-desktop only, so run from anywhere else — this plugin's own checkout
 * — every push probe would be let through and the self-test would report a
 * gate that sees nothing. One tree has podman-desktop as its upstream; the
 * other has only a remote that is not.
 *
 * @param {{pluginRoot: string}} options
 * @returns {Promise<Check[]>}
 */
export async function gateSelftest(options) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(options.pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
  } catch (error) {
    return [check('gate:selftest', 'required', 'fail', `hooks/hooks.json: ${error.message}`)];
  }

  const entry = (manifest.hooks?.PreToolUse ?? []).find((item) => item.matcher === 'Bash');
  const hook = entry?.hooks?.[0];
  if (!hook?.command) {
    return [
      check('gate:selftest', 'required', 'fail', 'hooks.json registers no PreToolUse hook on Bash — nothing guards writes'),
    ];
  }

  const expand = (text) => String(text).replaceAll('${CLAUDE_PLUGIN_ROOT}', options.pluginRoot);
  const command = expand(hook.command);
  const args = (hook.args ?? []).map(expand);

  const home = await mkdtemp(join(tmpdir(), 'pdkit-selftest-'));
  const missed = [];
  const overblocked = [];

  try {
    const inside = join(home, 'podman-desktop');
    const outside = join(home, 'elsewhere');
    for (const [tree, remote] of [
      [inside, 'https://github.com/podman-desktop/podman-desktop.git'],
      [outside, 'https://github.com/example/elsewhere.git'],
    ]) {
      await mkdir(tree, { recursive: true });
      await git.text(['init', '-q', '-b', 'DESKTOP-1/selftest'], { cwd: tree });
      await git.text(['remote', 'add', 'upstream', remote], { cwd: tree });
    }

    for (const probe of GATE_PROBES) {
      const code = await probeHook({
        command,
        args,
        commandLine: probe.command,
        env: { PDKIT_HOME: home },
        cwd: probe.outside ? outside : inside,
      });
      const blocked = code === 2;

      if (probe.deny && !blocked) missed.push(`${probe.command}  (${probe.why}) — exit ${code}`);
      if (!probe.deny && blocked) overblocked.push(`${probe.command}  (${probe.why})`);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }

  const denies = GATE_PROBES.filter((probe) => probe.deny).length;
  const allows = GATE_PROBES.length - denies;

  return [
    ...(await ownsSelftest({ manifest, pluginRoot: options.pluginRoot })),
    missed.length === 0
      ? check('gate:selftest', 'required', 'ok', `${denies} forbidden commands all refused, through ${command}`)
      : check(
          'gate:selftest',
          'required',
          'fail',
          `THE GATE DOES NOT SEE ${missed.length} of ${denies} forbidden commands:\n      ${missed.join('\n      ')}`,
        ),
    overblocked.length === 0
      ? check('gate:allows', 'required', 'ok', `${allows} ordinary commands all allowed`)
      : check(
          'gate:allows',
          'required',
          'fail',
          `refuses ordinary work, which is how a gate gets switched off:\n      ${overblocked.join('\n      ')}`,
        ),
  ];
}

/**
 * Exercise the ownership hook through the manifest, the same way.
 *
 * Same argument as the gate: the failure worth catching is not a wrong
 * decision, it is a hook that is never asked. A matcher naming the wrong tool
 * or a handler that stopped loading leaves the ownership map looking enforced
 * while every write goes through.
 *
 * @param {{manifest: object, pluginRoot: string}} options
 * @returns {Promise<Check[]>}
 */
async function ownsSelftest(options) {
  const entry = (options.manifest.hooks?.PreToolUse ?? []).find((item) => /Write/.test(String(item.matcher ?? '')));
  const hook = entry?.hooks?.[0];
  if (!hook?.command) {
    return [check('owns:selftest', 'required', 'fail', 'hooks.json registers no PreToolUse hook on Write — the ownership map is advisory')];
  }

  const expand = (text) => String(text).replaceAll('${CLAUDE_PLUGIN_ROOT}', options.pluginRoot);
  const home = await mkdtemp(join(tmpdir(), 'pdkit-owns-selftest-'));
  const repo = await mkdtemp(join(tmpdir(), 'pdkit-owns-selftest-repo-'));

  try {
    const tree = await realpath(repo);
    await git.text(['init', '-q', '-b', 'main'], { cwd: tree });
    await mkdir(join(tree, 'owned'), { recursive: true });
    await mkdir(join(tree, 'other'), { recursive: true });

    await setOwns(4242, 'T1', ['owned/**'], { home });
    await startTask({ issue: 4242, taskId: 'T1', worktree: tree, home });

    /**
     * @param {string} file
     * @returns {Promise<number>}
     */
    const probe = (file) =>
      new Promise((resolve) => {
        const spawnable = spawnableHook(expand(hook.command), (hook.args ?? []).map(expand));
        const child = spawn(spawnable.command, spawnable.args, {
          env: { ...process.env, PDKIT_HOME: home },
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        child.on('error', () => resolve(-1));
        child.on('close', (code) => resolve(code ?? -1));
        child.stdin.end(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(tree, file) }, cwd: tree }));
      });

    const outside = await probe('other/x.ts');
    const inside = await probe('owned/x.ts');

    if (outside !== 2) {
      return [check('owns:selftest', 'required', 'fail', `a write outside the active task's files was allowed (exit ${outside}) — the ownership map is not enforced`)];
    }
    if (inside === 2) {
      return [check('owns:selftest', 'required', 'fail', 'a write to an owned file was refused, which is how a hook gets switched off')];
    }

    return [check('owns:selftest', 'required', 'ok', 'writes outside the active task are refused, writes inside are not')];
  } catch (error) {
    return [check('owns:selftest', 'required', 'fail', `could not be run: ${error.message}`)];
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
}

/**
 * Run every check.
 *
 * `askServer` stands in for the running Open Code server, which the MCP check
 * asks about the directory; without it, `opencode api` is run.
 *
 * @param {{cwd?: string, home?: string, pluginRoot: string, gateSelftest?: boolean, askServer?: (path: string) => Promise<import('./opencode-api.js').Answer>}} options
 * @returns {Promise<{status: 'ok'|'warn'|'fail', checks: Check[], home: string, repo: string|null}>}
 */
export async function diagnose(options) {
  const cwd = options.cwd;
  const engines = JSON.parse(await readFile(join(options.pluginRoot, 'package.json'), 'utf8')).engines ?? {};

  /** @type {Check[]} */
  const checks = [...(await checkTools(engines.node))];

  let config = {};
  try {
    config = await load({ repoRoot: cwd });
  } catch {
    // checkConfig reports it; carrying on with an empty config keeps the rest
    // of the report useful instead of ending it at the first bad file.
  }

  const repo = await checkRepo({ cwd, config });
  checks.push(...repo.checks);

  const home = options.home ?? resolveHome({ repoRoot: repo.root ?? undefined });

  // Reloaded now that the home is known. The first load could not name it —
  // it runs before the repository is resolved — so every check after this one
  // would otherwise read a config missing its middle layer, and report on
  // settings the user does not actually have.
  try {
    config = await load({ repoRoot: repo.root ?? undefined, home });
  } catch {
    // Already reported by checkConfig below.
  }

  checks.push(...(await checkConfig({ repoRoot: repo.root ?? undefined, home })));
  checks.push(...(await checkHome(home, repo.root)));
  checks.push(...(await checkWorktrees({ repoRoot: repo.root, config })));
  checks.push(...(await checkHooks(options.pluginRoot)));
  checks.push(...(await checkAgentRuns(home)));
  checks.push(...(await checkMcp(config, { directory: repo.root ?? absolute(cwd ?? '.'), ask: options.askServer })));
  // The home as given, not as a repository moved it: the binary is read the
  // way validate launch reads it.
  checks.push(...(await checkValidationTarget({ repoRoot: repo.root ?? null, home: options.home })));

  if (options.gateSelftest) {
    checks.push(...(await gateSelftest({ pluginRoot: options.pluginRoot })));
  } else {
    // Not run by default: it spawns the hook once per probe, which is slower
    // than every other check here put together. Named rather than omitted, so
    // "I ran doctor" does not quietly mean "I did not check the gate".
    checks.push(
      check('gate:selftest', 'optional', 'skip', 'run `pdkit doctor --gate-selftest` — it spawns the hook once per probe'),
    );
  }

  const failed = checks.some((entry) => entry.level === 'required' && entry.status === 'fail');
  const warned = checks.some((entry) => entry.status === 'warn');

  return { status: failed ? 'fail' : warned ? 'warn' : 'ok', checks, home, repo: repo.root };
}

/** Symbols, chosen so the report is readable without color. */
const MARK = { ok: '✔', warn: '!', fail: '✘', skip: '·' };

/**
 * Render a report for a terminal.
 *
 * @param {Awaited<ReturnType<typeof diagnose>>} report
 * @param {{version: string}} meta
 * @returns {string}
 */
export function format(report, meta) {
  const lines = [`pdkit ${meta.version} — ${report.status}`, ''];

  for (const level of LEVELS) {
    const group = report.checks.filter((entry) => entry.level === level);
    if (group.length === 0) continue;

    lines.push(`${level}:`);
    for (const entry of group) {
      lines.push(`  ${MARK[entry.status]} ${entry.id.padEnd(22)} ${entry.detail}`);
    }
    lines.push('');
  }

  if (report.status === 'fail') lines.push('Fix the ✘ items above; the rest of pdkit assumes them.');

  return `${lines.join('\n')}\n`;
}
