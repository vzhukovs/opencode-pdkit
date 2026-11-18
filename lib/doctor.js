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

import { execFile } from 'node:child_process';
import { constants as FS } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { dirname, join, resolve as absolute } from 'node:path';
import { promisify } from 'node:util';

import { start as startTask } from './active.js';
import { DEFAULTS_PATH, definedIn, expandTilde, get, layers, load, paths, resolveHome, trustedValue } from './config.js';
import * as git from './git.js';
import { SESSION_VARIABLE, isOwnRun } from './harness.js';
import { HOOK_HANDLERS, REGISTERED_VARIABLE } from './hooks/events.js';
import { NODE_VARIABLE, invoke, readNodeLabel } from './hooks/runner.js';
import { read as readJournal, resolveSince } from './journal.js';
import * as server from './opencode-api.js';
import { modelRef, modelText, readOptions, unavailable } from './opencode-models.js';
import { databasePath, readSubagentRuns } from './opencode-sessions.js';
import {
  SERVER_VERSION_VARIABLE,
  checkOpenCode,
  cliVersion,
  compareVersions,
  minimumVersion,
  parseRelease,
  unavailableSummary,
} from './opencode-version.js';
import { UNKNOWN_LAYER, resolveRepoRoot } from './repo.js';
import { checkedProgram } from './reveal.js';
import { COMMAND_PREFIX, skillDescription, skillModel } from './session-model.js';
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
      'is no longer read (deleted before 0.1.0). The eligible states live in state.GATE_ELIGIBLE, keyed by push ' +
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
 * @property {Array<Record<string, string>>} [table] rows printed under the line, one column per key
 */

/**
 * Run a command just to see whether it is there and working.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {Record<string, string|undefined>} [env] the command's environment, PATH included; this process's when not given
 * @returns {Promise<{ok: boolean, stdout: string, error?: string}>}
 */
async function probe(command, args, env) {
  try {
    const { stdout } = await run(command, args, { encoding: 'utf8', timeout: 15000, ...(env ? { env } : {}) });
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

/** Where the version the `opencode` line holds to the minimum came from. */
const HOST_SOURCES = {
  server: 'the Open Code server’s, which runs this session',
  terminal: 'the CLI’s (opencode --version) — the Open Code server that runs the plugin can be another version, which /pd:doctor shows',
  unlabeled: `the CLI’s (opencode --version) — this session’s commands carry no ${SERVER_VERSION_VARIABLE}, so the server’s is not known (see hooks)`,
};

/**
 * What the `opencode` line says for each place checkOpenCode gives the host:
 * its status, and the detail after the version and where it came from.
 *
 * @type {Record<'ok'|'below'|'unreleased'|'unknown', (said: string, version: string, minimum: string) => ['ok'|'fail'|'skip', string]>}
 */
const HOST_VERDICTS = {
  // No upper bound (D9): a newer Open Code is not a warning, and the line says
  // which one opencode-pdkit is tested on.
  ok: (said, version, minimum) => ['ok', compareVersions(version, minimum) > 0 ? `${said}; opencode-pdkit is tested on ${minimum}` : said],
  // Open Code 1 is another line, which takes another command (F236, F242).
  below: (said, version, minimum) => [
    'fail',
    parseRelease(version)[0] === 1
      ? `${said}. Open Code 1 is not supported — move to Open Code 2 with: opencode upgrade --major`
      : `${said}. Below ${minimum}, the minimum, opencode-pdkit runs the gate alone and every /pd: command refuses — update it with: opencode upgrade`,
  ],
  unreleased: (said, version, minimum) => ['skip', `${said}. Not a release build: it cannot be compared with the minimum, ${minimum}`],
  unknown: (said) => ['skip', `cannot tell: ${said} — not a version it can read`],
};

/**
 * The Open Code that runs the plugin, against package.json engines.opencode.
 *
 * Open Code checks no plugin against itself: it installs and loads one on any
 * version, whatever engines.opencode says (F241). The plugin compares at load,
 * and below the minimum registers the gate alone and commands that refuse
 * (D9) — this line is where a person sees why.
 *
 * The version that counts is the server's, which runs the plugin; the CLI on
 * the PATH can be another one (F240). The plugin puts the server's on every
 * shell command (SERVER_VERSION_VARIABLE), so from a session it is read there.
 * Without it — a terminal, a session whose server runs the plugin below its
 * minimum, where the plugin sets nothing, or one that does not run it — the
 * version is the CLI's, from `opencode --version`, and the detail says whose
 * it is. Not `opencode api`, which can start a server to ask.
 *
 * A build off the release line (`0.0.0-<channel>-<n>`, `local`) is skip: it
 * cannot be placed against the minimum, and skip is not pass.
 *
 * @param {unknown} range engines.opencode as package.json has it
 * @param {{env?: Record<string, string|undefined>, cli?: () => Promise<{ok: boolean, stdout: string, error?: string}>}} [options]
 *   `env` is the doctor's environment, process.env when not given; `cli` runs
 *   `opencode --version` with it unless a test stands in
 * @returns {Promise<Check>}
 */
export async function checkOpenCodeVersion(range, options = {}) {
  const env = options.env ?? process.env;
  const minimum = minimumVersion(range);
  if (minimum === null) {
    return check('opencode', 'required', 'fail', `package.json engines.opencode is ${JSON.stringify(range)}, not ">=X.Y.Z"`);
  }

  let version = env[SERVER_VERSION_VARIABLE];
  let source = HOST_SOURCES.server;
  if (typeof version !== 'string' || version === '') {
    const cli = await (options.cli ?? (() => probe('opencode', ['--version'], env)))();
    if (!cli.ok) {
      return check(
        'opencode',
        'required',
        'fail',
        cli.error === 'not found' ? `opencode: not found; need Open Code >= ${minimum}` : `opencode --version: ${cli.error}`,
      );
    }
    version = cliVersion(cli.stdout);
    if (version === undefined) {
      const line = cli.stdout.split('\n').map((entry) => entry.trim()).find(Boolean) ?? '';
      return check('opencode', 'required', 'skip', `cannot tell: opencode --version printed ${JSON.stringify(line)}, not a version`);
    }
    source = inSession(env) ? HOST_SOURCES.unlabeled : HOST_SOURCES.terminal;
  }

  const [status, detail] = HOST_VERDICTS[checkOpenCode({ version }, minimum).status](`${version}, ${source}`, version, minimum);
  return check('opencode', 'required', status, detail);
}

/**
 * Required external tools: Node and Open Code against the package's engines,
 * then the programs pdkit runs.
 *
 * @param {{node?: unknown, opencode?: unknown}} engines package.json's
 * @param {Record<string, string|undefined>} env the doctor's
 * @returns {Promise<Check[]>}
 */
async function checkTools(engines, env) {
  const checks = [checkNode(engines.node), await checkOpenCodeVersion(engines.opencode, { env })];

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
 * What goes off with an event the plugin did not register, for the ones that
 * guard something. The rest add context, and say nothing when they are gone.
 */
const UNGUARDED = {
  'pre-bash': 'no gate on writes upstream',
  'pre-write': 'no check of writes against the task’s Owns',
  'subagent-stop': 'no receipt gate, and no agent-done is written',
};

/**
 * Whether the doctor runs in a session: the shell tool names one on every
 * command the model runs. A command a person types with `!` in the TUI, and a
 * terminal, carry none.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {boolean}
 */
const inSession = (env) => typeof env[SESSION_VARIABLE] === 'string' && env[SESSION_VARIABLE] !== '';

/**
 * The hook events against the handlers that run them, and against what the
 * plugin registered.
 *
 * Under Claude Code this read hooks/hooks.json, a second list of the events
 * that the host ran, and held it to the table. The plugin for Open Code keeps
 * no such list: it registers every event of the table itself, inside the
 * server, where nothing outside can look. Two sides are left to look at. The
 * table's, from anywhere: every event has its module, which a partial install
 * can lack. And the plugin's, from a session: it says on every shell command
 * which events stood (REGISTERED_VARIABLE), so a point Open Code refused is a
 * failure here and not a silence.
 *
 * What it cannot see is a point Open Code renamed. Open Code 2.3.0 takes a
 * hook of any name and calls only the ones it has (F304), so the plugin's
 * registration of a hook a later version calls something else stands, and is
 * never called. The experimental one subagent-stop stands on is the likely
 * one; that shows as runs without their agent-done (checkAgentRuns).
 *
 * In a session whose commands carry no such word, the plugin is not running
 * there, or runs below its minimum Open Code, where it registers the gate
 * alone and says nothing. Outside a session there is nothing to read, and the
 * check says so rather than passing it over.
 *
 * @param {string} pluginRoot
 * @param {Record<string, string|undefined>} [env] the doctor's environment
 * @returns {Promise<Check[]>}
 */
export async function checkHooks(pluginRoot, env = process.env) {
  const events = Object.keys(HOOK_HANDLERS);
  const problems = [];

  for (const [event, handler] of Object.entries(HOOK_HANDLERS)) {
    try {
      await stat(join(pluginRoot, 'lib', 'hooks', handler));
    } catch {
      problems.push(`${event} -> lib/hooks/${handler} is missing`);
    }
  }

  const label = env[REGISTERED_VARIABLE];
  if (typeof label === 'string') {
    const stood = new Set(label.split(',').filter(Boolean));
    const missing = events.filter((event) => !stood.has(event));
    if (missing.length > 0) {
      const named = missing.map((event) => (UNGUARDED[event] ? `${event} (${UNGUARDED[event]})` : event));
      problems.push(
        `not registered in this session: ${named.join(', ')} — the Open Code server’s stderr says why ` +
          '("opencode-pdkit: cannot register its hooks (…)")',
      );
    }
  } else if (inSession(env)) {
    problems.push(
      `this session’s commands carry no ${REGISTERED_VARIABLE}: opencode-pdkit is not running here, and neither is ` +
        'the gate on writes upstream — or it runs below its minimum Open Code, with the gate alone (see plugin, opencode)',
    );
  }

  if (problems.length > 0) return [check('hooks', 'required', 'fail', problems.join('; '))];
  return [
    check(
      'hooks',
      'required',
      'ok',
      typeof label === 'string'
        ? `${events.length} events, every one has a handler and is registered in this session`
        : `${events.length} events, every one has a handler; which ones the plugin registered shows only in a session (/pd:doctor)`,
    ),
  ];
}

/**
 * The `node` the hooks start, against package.json engines.node.
 *
 * Every hook is `node bin/pdkit hook <event>`, started by the plugin inside
 * the Open Code server, with the server's environment: its PATH is whoever
 * started the server's, not the session's, and none of the doctor's own. With
 * no `node` there, every call that carries a command is refused (pre-bash
 * fails closed). The plugin asks that `node` its version once and says it on
 * every shell command (NODE_VARIABLE), so this is a check from a session only.
 * The minimum is the one `node` is held to: under Claude Code the hooks ran on
 * the `node` of the session's own PATH, which that check saw.
 *
 * @param {unknown} range engines.node
 * @param {Record<string, string|undefined>} [env]
 * @returns {Check}
 */
export function checkHookNode(range, env = process.env) {
  const label = env[NODE_VARIABLE];
  if (typeof label !== 'string') {
    return check(
      'hooks:node',
      'required',
      'skip',
      inSession(env)
        ? 'opencode-pdkit set nothing on this session’s commands (see hooks)'
        : 'shows only in a session (/pd:doctor): the hooks run on the node of the Open Code server’s PATH, which no terminal sees',
    );
  }

  const minimum = minimumVersion(range);
  const said = readNodeLabel(label);
  if ('none' in said) {
    return check(
      'hooks:node',
      'required',
      'fail',
      `no node the hooks can start on the Open Code server’s PATH (${said.none}): every command the model runs is refused. ` +
        `Restart the server from a shell whose PATH has node${minimum ? ` >= ${minimum}` : ''}`,
    );
  }
  const where = `${said.version} on the Open Code server’s PATH, which every hook runs with`;
  if (minimum === null) return check('hooks:node', 'required', 'fail', `${where}; package.json engines.node is ${JSON.stringify(range)}, not ">=X.Y.Z"`);
  return compareVersions(said.version.slice(1), minimum) >= 0
    ? check('hooks:node', 'required', 'ok', where)
    : check('hooks:node', 'required', 'fail', `${where}; need >= ${minimum}`);
}

/**
 * Whether Open Code runs the plugin for the directory: without it, no hook
 * runs, the gate on writes upstream included (§13 DV1), and Open Code says
 * nothing — a plugin the config turns off is not reported as failed, it is
 * simply not there (F213).
 *
 * From a session the plugin answers for itself: its labels are on the very
 * command that runs this. Elsewhere — a terminal, or a session it is not
 * running in — the server is asked: the plugins it runs for the directory,
 * and, when this one is not among them, where the config turns it off.
 *
 * A published version newer than the one running is a warning with the
 * command that installs it: Open Code marks the plugin outdated, and installs
 * nothing by itself (F220). From a session the server is asked once for that
 * mark alone; what it does not answer changes nothing.
 *
 * @param {{
 *   id: string,
 *   directory: string,
 *   env?: Record<string, string|undefined>,
 *   ask?: (path: string) => Promise<import('./opencode-api.js').Answer>,
 *   wait?: number,
 *   pause?: (ms: number) => Promise<unknown>,
 *   now?: () => number,
 * }} options  `id` is the plugin's, which is also its package's name
 * @returns {Promise<Check>}
 */
export async function checkPlugin(options) {
  const { id, directory } = options;
  const env = options.env ?? process.env;
  const ask = options.ask ?? server.askRunning({ directory });
  const update = 'a newer version is published — update it with: opencode plugin update';

  if (typeof env[REGISTERED_VARIABLE] === 'string') {
    const here = `${id} runs in this session: it labels every command here`;
    const listed = await ask('/api/plugin');
    const mine = listed.ok ? server.plugins(listed.data).find((record) => record.id === id) : undefined;
    return mine?.outdated ? check('plugin', 'required', 'warn', `${here}; ${update}`) : check('plugin', 'required', 'ok', here);
  }

  const wait = options.wait ?? server.WAIT_MS;
  // The list is empty until the server has loaded the directory; Open Code's
  // own plugins are always in it after that.
  const listed = await server.waitFor(() => ask('/api/plugin'), (body) => server.plugins(body).length > 0, {
    wait,
    pause: options.pause,
    now: options.now,
  });
  if (!listed.ok) return check('plugin', 'required', 'skip', `cannot tell: ${listed.error}`);
  if (!listed.settled) {
    return check(
      'plugin',
      'required',
      'skip',
      `cannot tell: Open Code listed no plugin for ${directory} within ${Math.round(wait / 1000)} s — run pdkit doctor again`,
    );
  }

  const records = server.plugins(listed.data);
  const at = records.findIndex((record) => record.id === id);
  const mine = records[at];
  const off = 'no plugin, no gate on writes upstream';

  if (mine?.status === 'active') {
    const after = records.slice(at + 1).filter((record) => !record.builtin);
    const later =
      after.length === 0
        ? ''
        : `; after it, ${after.map((record) => record.id ?? record.source).join(', ')} — whose hooks see a command after its gate, and can change it`;
    const active = `${id} is active in Open Code for ${directory} (${mine.source}${mine.version ? ` ${mine.version}` : ''})${later}`;
    return mine.outdated ? check('plugin', 'required', 'warn', `${active}; ${update}`) : check('plugin', 'required', 'ok', active);
  }

  const failed = mine ? [mine] : records.filter((record) => !record.builtin && record.status === 'failed' && record.source.includes(id));
  if (failed.length > 0 && failed.every((record) => record.status === 'failed')) {
    const why = failed.map((record) => `${record.source}: ${record.error ?? 'failed'}${record.ref ? ` (${record.ref} in the server’s log)` : ''}`);
    return check('plugin', 'required', 'fail', `Open Code failed to load ${id} for ${directory} — ${off}: ${why.join('; ')}`);
  }
  if (mine) return check('plugin', 'required', 'skip', `cannot tell: Open Code reports ${id} ${mine.status || 'with no status'}`);

  const documents = await ask('/api/config');
  if (!documents.ok) {
    return check('plugin', 'required', 'fail', `Open Code does not load ${id} for ${directory} — ${off}; its config could not be read (${documents.error})`);
  }
  const { removed, denied, added } = server.turnedOff(documents.data, id);
  const causes = [
    ...removed.map((document) => `"-${id}" in the plugins of ${document}`),
    ...denied.map((rule) => `a plugin.use policy in ${rule.document} denies ${rule.target} (${rule.resource})`),
  ];
  if (causes.length === 0) {
    causes.push(
      added.length > 0
        ? `${added.map((entry) => `${entry.target} in the plugins of ${entry.document}`).join(', ')}, and nothing there turns it off — ` +
            '`opencode plugin list` and the server’s log may say more'
        : `no config document it reads names ${id}. Add it with: opencode plugin add ${id}`,
    );
  }
  return check('plugin', 'required', 'fail', `Open Code does not load ${id} for ${directory} — ${off}: ${causes.join('; ')}`);
}

/** How far back the `agent-done` liveness check looks. */
export const AGENT_RUNS_WINDOW = '30d';

/**
 * Has the subagent hook fired recently?
 *
 * The other half of `checkHooks`. That one proves every event has a handler
 * that exists, and from a session that the plugin registered it; it cannot
 * prove the host ever sends the event the handler is registered on. In the
 * Claude Code version, for four months it did not — the receipt gate sat on
 * `TaskCompleted`, which subagents never raise, and every check here stayed
 * green. A hook that never connected leaves the same trace as a hook with
 * nothing to catch, which is none (the note() in lib/hooks/dispatch.js is the
 * same failure on the gate). `agent-done` is written on every subagent finish, refused or not, so
 * its absence over weeks of work means the wiring.
 *
 * Only this harness's entries count (isOwnRun). The journal is shared with
 * the Claude Code version of the plugin, whose entries look the same but for
 * the run's ID, and weeks of them would vouch for a hook here that never ran.
 *
 * The journal alone cannot tell a hook that is not called from a month with
 * no subagents. Open Code's session database can: it records every subagent
 * as a child session, with the agent it ran as and how it ended
 * (lib/opencode-sessions.js). A subagent that finished — not one that failed
 * or was interrupted, which Open Code ends without calling the hook — and
 * left no agent-done is the hook not running, measured. Open Code 2.3.0 takes
 * a hook of any name (F304), so this is where a later version that renames
 * the one subagent-stop stands on shows. Only the plugin's own agents count:
 * one of them ran only where the plugin was loaded, with its hook registered,
 * while any other agent can have run before the plugin was installed. And
 * only those started after the latest agent-done of this harness's: each
 * writes its entry after it started, so one started later that finished and
 * wrote nothing is certain, while how many entries an earlier one wrote is
 * not (every stop the receipt gate refuses writes one more).
 *
 * That is a failure, as a subagent-stop the plugin could not register is in
 * checkHooks: the receipt gate is off either way. The two things the doctor
 * cannot rule out are said with it — the server's hooks writing to another
 * home than the one read here, or having no node to run on. Without the
 * database, or outside the clone, the journal is read alone, and a month of
 * nothing is a warning, as before: a fresh install, or a month with no issue
 * work, has no history to show and nothing wrong with it.
 *
 * @param {string} home
 * @param {number} [now] milliseconds, for tests
 * @param {object} [opencode] where to look for the subagents that ran; the journal alone without a clone
 * @param {string|null} [opencode.db]        Open Code's database; databasePath() when not given
 * @param {string|null} [opencode.repoRoot]  the clone
 * @param {object} [opencode.config]         for `worktrees.root`
 * @param {string[]} [opencode.agents]       the IDs of the plugin's agents
 * @param {(file: string) => Promise<object>} [opencode.open]  opens the database, for tests
 * @returns {Promise<Check[]>}
 */
export async function checkAgentRuns(home, now = Date.now(), opencode = {}) {
  const since = resolveSince(AGENT_RUNS_WINDOW, now);
  let runs;
  try {
    runs = await readJournal({ event: 'agent-done', since: since.at }, { home });
  } catch (error) {
    return [check('hooks:agent-done', 'optional', 'warn', `cannot read the journal (${error.code ?? error.message})`)];
  }

  const own = runs.filter(isOwnRun);
  const others = runs.length - own.length;
  const uncounted = others === 0 ? '' : `${others} more not counted: Claude Code’s, or with no run ID`;
  const latest = own.at(-1)?.at ?? null;

  const sessions = await pluginSubagents(opencode, Date.parse(since.at));
  const source = sessions.skip ? `Open Code’s sessions were not read: ${sessions.skip.reason}` : `read from ${sessions.db}`;

  // An entry's time is to the second, so a run started within the second of
  // the latest entry may be the one that wrote it.
  const after = latest === null ? -Infinity : Date.parse(latest);
  const silent = sessions.runs.filter((run) => run.stopped && Math.floor(Date.parse(run.created) / 1000) * 1000 > after);

  if (silent.length > 0) {
    const last = silent.at(-1);
    return [
      check(
        'hooks:agent-done',
        'required',
        'fail',
        (latest === null
          ? `${silent.length} of the plugin’s subagents stopped in Open Code in this clone in the last ${AGENT_RUNS_WINDOW}, ` +
            `and none of them wrote an agent-done to ${home}${uncounted ? ` (${uncounted})` : ''}: `
          : `${silent.length} of the plugin’s subagents started in Open Code in this clone after the latest agent-done ` +
            `of Open Code’s (${latest}) and stopped, and none of them wrote one to ${home}: `) +
          'Open Code does not call the subagent-stop hook, so the receipt gate is off — unless the server’s hooks write ' +
          `to another PDKIT_HOME, or cannot run node (see hooks:node). Latest: ${last.agent}, started ${seconds(last.created)}; ` +
          source,
      ),
    ];
  }

  if (own.length === 0) {
    const ended = sessions.runs.filter((run) => !run.stopped && run.outcome !== null).length;
    return [
      check(
        'hooks:agent-done',
        'optional',
        'warn',
        `no agent-done of Open Code’s in the journal for ${AGENT_RUNS_WINDOW}${uncounted ? ` (${uncounted})` : ''}. ` +
          (sessions.skip
            ? 'If subagents ran in Open Code in that time, the subagent-stop hook is not connected and the receipt gate is ' +
              `off; run any subagent, then \`pdkit journal --event agent-done\`. ${source}`
            : 'None of the plugin’s subagents stopped in Open Code in this clone in that time either' +
              `${ended > 0 ? ` (${ended} failed or were interrupted, which ends one without a stop)` : ''}, so nothing ` +
              'shows yet that the subagent-stop hook runs; run any subagent, then `pdkit journal --event agent-done` ' +
              `(${source})`),
      ),
    ];
  }

  return [
    check(
      'hooks:agent-done',
      'optional',
      'ok',
      `${own.length} in the last ${AGENT_RUNS_WINDOW}, latest ${latest}${uncounted ? `; ${uncounted}` : ''}; ` +
        (sessions.skip ? source : `of the plugin’s subagents started in this clone since, none stopped without one (${source})`),
    ),
  ];
}

/**
 * The plugin's subagents that ran in the clone since a time, from Open Code's
 * database; none, and why, when there is nothing to look in or with.
 *
 * @param {{db?: string|null, repoRoot?: string|null, config?: object, agents?: string[], open?: (file: string) => Promise<object>}} opencode
 * @param {number} since milliseconds
 * @returns {Promise<{db?: string|null, runs: import('./opencode-sessions.js').SubagentRun[], skip: {reason: string}|null}>}
 */
async function pluginSubagents(opencode, since) {
  if (!opencode.repoRoot) return { runs: [], skip: { reason: 'not run inside the clone' } };
  const agents = new Set(opencode.agents ?? []);
  if (agents.size === 0) return { runs: [], skip: { reason: 'the plugin’s agents could not be read' } };

  const db = opencode.db === undefined ? databasePath() : opencode.db;
  try {
    const read = await readSubagentRuns({ db, repoRoot: opencode.repoRoot, config: opencode.config, since, open: opencode.open });
    return { ...read, runs: read.runs.filter((run) => agents.has(run.agent)) };
  } catch (error) {
    return { runs: [], skip: { reason: `the Open Code database at ${db} could not be read: ${error.message}` } };
  }
}

/**
 * An ISO time to the second, the way the journal writes one.
 *
 * @param {string} at
 * @returns {string}
 */
function seconds(at) {
  return `${at.slice(0, 19)}Z`;
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
  // verified the endpoint; until 2026-08-02, in the Claude Code version, it
  // verified the name and said so in the same breath.
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

  const ask = options.ask ?? server.askRunning({ directory: options.directory });
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

/** A prompt file's frontmatter block, found as the registrars find it (opencode/prompts.js). */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * A prompt file's frontmatter as YAML reads it, or null: no file, no block, or
 * not YAML.
 *
 * @param {string} path
 * @returns {Promise<Record<string, unknown>|null>}
 */
async function frontmatter(path) {
  try {
    const block = FRONTMATTER.exec(await readFile(path, 'utf8'));
    return block ? (parse(block[1]) ?? {}) : null;
  } catch {
    return null;
  }
}

/**
 * The names under a directory of the plugin, sorted; none when it cannot be read.
 *
 * @param {string} dir
 * @returns {Promise<import('node:fs').Dirent[]>}
 */
async function entriesOf(dir) {
  try {
    return (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return [];
  }
}

/**
 * @typedef {object} ShippedCommand
 * @property {string} id `pd:<skill>`
 * @property {string} skill the directory under skills/
 * @property {string} file skills/<skill>/SKILL.md
 * @property {unknown} declared `model:` as written
 * @property {import('./opencode-models.js').ModelRef|undefined} ref the model skillModel reads
 * @property {string|undefined} description the command's, as the registrar builds it (skillDescription)
 * @property {boolean} loadable a skill as well, under the same ID: not `disable-model-invocation: true`
 */

/**
 * Every agent the plugin ships, by its `name:`, which is the ID the agents'
 * registrar gives it and the agent Open Code records on its sessions.
 *
 * @param {string} pluginRoot
 * @returns {Promise<Array<{id: string, file: string, declared: unknown}>>}
 */
async function readShippedAgents(pluginRoot) {
  const agents = [];
  const ids = new Set();
  for (const entry of await entriesOf(join(pluginRoot, 'agents'))) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const data = await frontmatter(join(pluginRoot, 'agents', entry.name));
    const id = data?.name;
    if (typeof id !== 'string' || id === '' || ids.has(id)) continue;
    ids.add(id);
    agents.push({ id, file: `agents/${entry.name}`, declared: data.model });
  }
  return agents;
}

/**
 * Every agent and command the plugin ships, read as the registrars read them:
 * the defaults of the models, and what a command and a skill are registered
 * with. An agent is agents/<file>.md by its `name:`; a command is
 * `/pd:<skill>`, whose model is the one skillModel reads and whose
 * description the one skillDescription builds — the command registrar's own
 * readers.
 *
 * @param {string} pluginRoot
 * @returns {Promise<{
 *   agents: Array<{id: string, file: string, declared: unknown}>,
 *   commands: ShippedCommand[],
 * }>}
 */
async function readShipped(pluginRoot) {
  const agents = await readShippedAgents(pluginRoot);

  const commands = [];
  for (const entry of await entriesOf(join(pluginRoot, 'skills'))) {
    if (!entry.isDirectory()) continue;
    const file = `skills/${entry.name}/SKILL.md`;
    const data = await frontmatter(join(pluginRoot, file));
    if (data === null) continue;
    commands.push({
      id: `${COMMAND_PREFIX}${entry.name}`,
      skill: entry.name,
      file,
      declared: data.model,
      ref: modelRef(await skillModel(entry.name, pluginRoot)),
      description: (await skillDescription(entry.name, pluginRoot)) ?? undefined,
      loadable: data['disable-model-invocation'] !== true,
    });
  }
  return { agents, commands };
}

/** What the table says of a model Open Code lists for the directory. */
const LISTED = 'in the catalog';

/** The table's mark for a cell that has nothing in it. */
const NONE = '—';

/**
 * @param {import('./opencode-models.js').ModelRef|null|undefined} a
 * @param {import('./opencode-models.js').ModelRef|null|undefined} b
 * @returns {boolean}
 */
const sameModel = (a, b) => (a ?? null) === (b ?? null) || (Boolean(a && b) && modelText(a) === modelText(b));

/**
 * The model each of the plugin's agents and commands runs on in the
 * directory, where that model comes from, and whether Open Code lists it.
 *
 * Open Code checks none of this before a call: an agent on a model it cannot
 * use is registered, and fails when it is called (F107); `agents.<id>.model`
 * with a typo is dropped without a word (F229) — its answers leave the entry
 * out too (F315), so all the doctor can show of one is the model the agent
 * runs on all the same; and nothing in it shows a command with its model. A
 * command checks its own when it runs, and refuses — which is late to learn
 * the model was never there. So the answers come from the server,
 * as the plugin's order has it (D5): the map in the plugin's options, over
 * the frontmatter; for an agent, `agents.<id>.model` of Open Code's config
 * over both, which Open Code applies itself. The agents' models are the ones
 * Open Code reports; a command's is the one its options and frontmatter
 * give, since Open Code reports none.
 *
 * What is reported is facts — which model, from where, listed or not; how
 * strong a model is, is not the doctor's to say.
 *
 * @param {{
 *   pluginRoot: string,
 *   id: string,
 *   directory: string,
 *   plugin?: Check,
 *   ask?: (path: string) => Promise<import('./opencode-api.js').Answer>,
 *   wait?: number,
 *   pause?: (ms: number) => Promise<unknown>,
 *   now?: () => number,
 * }} options  `id` is the plugin's, also its package's name; `plugin` is the `plugin` line, when there is one
 * @returns {Promise<Check>}
 */
export async function checkModels(options) {
  const { pluginRoot, id, directory } = options;
  const ask = options.ask ?? server.askRunning({ directory });
  const wait = options.wait ?? server.WAIT_MS;
  const cannot = (why) => check('models', 'optional', 'skip', `cannot tell: ${why}`);

  // Without the plugin there is nothing to run on any model, and the plugin
  // line says why.
  if (options.plugin?.status === 'fail') return cannot(`Open Code does not run ${id} for ${directory} — see plugin`);

  const shipped = await readShipped(pluginRoot);
  const agentIds = new Set(shipped.agents.map((agent) => agent.id));

  const documents = await ask('/api/config');
  if (!documents.ok) return cannot(documents.error);
  const listed = await server.waitFor(
    () => ask('/api/agent'),
    (body) => [...server.agentModels(body).keys()].some((agent) => agentIds.has(agent)),
    { wait, pause: options.pause, now: options.now },
  );
  if (!listed.ok) return cannot(listed.error);
  if (!listed.settled) {
    return cannot(`none of ${id}'s agents is registered for ${directory} within ${Math.round(wait / 1000)} s — see plugin, or run pdkit doctor again`);
  }
  const models = await ask('/api/model');
  if (!models.ok) return cannot(models.error);

  const known = server.catalog(models.data);
  const final = server.agentModels(listed.data);
  const configured = server.configuredAgents(documents.data);
  const { entry, unread } = server.pluginEntry(documents.data, id);
  const settings = readOptions(entry?.options);
  const optionsIn = entry ? `options.models in ${entry.document}` : 'options.models';

  /** @type {string[]} */
  const findings = [];
  for (const line of settings.dropped) findings.push(`${line}, in ${entry.document}`);
  for (const ignored of unread) findings.push(`the options of ${ignored.target} in ${ignored.document} are not read: ${ignored.why}`);

  // The map as the registrars read it: a key names an agent or a command, and
  // its value is a model in Open Code's grammar, or it is dropped.
  const names = new Set([...agentIds, ...shipped.commands.map((command) => command.id)]);
  const chosen = new Map();
  for (const [key, text] of Object.entries(settings.models)) {
    const ref = modelRef(text);
    if (!names.has(key)) findings.push(`options.models.${key} names no agent or command of ${id}, so it does nothing`);
    else if (!ref) findings.push(`options.models.${key}: ${JSON.stringify(text)} is not provider/model#variant, so ${key} keeps its default`);
    else chosen.set(key, ref);
  }

  /** @type {Array<{id: string, model: string, source: string, catalog: string}>} */
  const table = [];
  const listedOrWhy = (ref) => unavailable(known, ref) ?? LISTED;
  const configDocuments = new Set();

  for (const agent of shipped.agents) {
    const mapped = chosen.get(agent.id);
    const declared = modelRef(agent.declared);
    const plugin = mapped ? { ref: mapped, source: 'options.models' } : declared ? { ref: declared, source: 'frontmatter' } : undefined;
    const config = configured.get(agent.id);

    if (!final.has(agent.id)) {
      const off = config?.disabled ? `: agents.${agent.id}.disabled in ${config.disabled}` : '';
      findings.push(`${agent.id} is not registered for ${directory}${off}`);
      table.push({ id: agent.id, model: NONE, source: 'not registered', catalog: NONE });
      continue;
    }

    const ran = final.get(agent.id);
    let source;
    if (config?.model && sameModel(ran, config.model.ref)) {
      source = 'agents.<id>.model';
      configDocuments.add(config.model.document);
      if (mapped) findings.push(`options.models.${agent.id} does nothing: agents.${agent.id}.model in ${config.model.document} wins over it`);
    } else if (sameModel(ran, plugin?.ref)) {
      source = plugin?.source ?? 'none';
    } else {
      source = 'unknown';
      const given = config?.model
        ? `${modelText(config.model.ref)} of agents.${agent.id}.model in ${config.model.document}`
        : plugin
          ? `${modelText(plugin.ref)} from ${plugin.source === 'frontmatter' ? agent.file : optionsIn}, and no config document sets agents.${agent.id}.model — ` +
            `an agent file ${agent.id}.md in an Open Code config directory, or another plugin, changed it`
          : `no model, as the plugin left it — an agent file ${agent.id}.md in an Open Code config directory, or another plugin, set one`;
      findings.push(`Open Code runs ${agent.id} on ${ran ? modelText(ran) : "its caller's model"}, not ${given}`);
    }
    table.push({
      id: agent.id,
      model: ran ? modelText(ran) : NONE,
      source,
      catalog: ran ? listedOrWhy(ran) : "none: it runs on its caller's",
    });
  }

  const sessions = [];
  for (const command of shipped.commands) {
    const mapped = chosen.get(command.id);
    const ref = mapped ?? command.ref;
    if (!ref) {
      if (command.declared === undefined) sessions.push(command.id);
      else findings.push(`${command.file}: model ${JSON.stringify(command.declared)} is not provider/model#variant, so /${command.id} runs on the session's model`);
      continue;
    }
    table.push({ id: command.id, model: modelText(ref), source: mapped ? 'options.models' : 'frontmatter', catalog: listedOrWhy(ref) });
  }

  const count = (source) => table.filter((row) => row.source === source).length;
  const sources = [
    [count('frontmatter'), 'by their frontmatter'],
    [count('options.models'), `by ${optionsIn}`],
    [count('agents.<id>.model'), `by agents.<id>.model in ${[...configDocuments].join(', ')}`],
    [count('unknown'), 'by something after the plugin'],
    [count('none'), "by none: they run on their caller's"],
    [count('not registered'), 'not registered'],
  ].filter(([n]) => n > 0);
  const missing = table.filter((row) => row.catalog !== LISTED && row.model !== NONE).length;
  const parts = [
    `${table.length} agents and commands: ${sources.map(([n, how]) => `${n} ${how}`).join(', ')}`,
    missing === 0
      ? `every model is in Open Code's catalog for ${directory}`
      : `${missing} not in Open Code's catalog for ${directory}, as the table says — an agent on such a model fails when it is called, a command refuses to run`,
    ...(sessions.length > 0 ? [`${sessions.join(', ')} set no model and run on the session's`] : []),
    ...findings,
  ];
  const result = check('models', 'optional', missing > 0 || findings.length > 0 ? 'warn' : 'ok', parts.join('; '));
  result.table = table;
  return result;
}

/**
 * Whether two paths name one file: as written, or once links are followed.
 *
 * @param {string} a
 * @param {string} b
 * @returns {Promise<boolean>}
 */
async function sameFile(a, b) {
  if (absolute(a) === absolute(b)) return true;
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
  }
}

/**
 * Whether what Open Code offers under the plugin's names is the plugin's:
 * each `/pd:<skill>` command, and each `pd:<name>` skill the model may load.
 *
 * Under Claude Code a plugin's commands lived in a namespace of its own. Open
 * Code keeps one command per name and one skill per ID, and the last to add
 * one wins, without a word (F100, F230, F121): a markdown command of the name
 * in a commands directory of its config, `command."<name>"` with a template in
 * a config document, or a plugin after this one in `plugins` replaces the
 * command whole; a SKILL.md of the ID in a skills directory replaces the
 * skill. Whoever types `/pd:sync` then runs that text instead — on no model of
 * the plugin's, without the label the prompt hook reads — and nothing says so.
 *
 * Nothing in Open Code's answers says whose an entry is. A command is the
 * plugin's when Open Code shows the description the registrar gives it
 * (skillDescription, which both read); a skill, when it is read from the
 * plugin's own SKILL.md. Below its minimum Open Code the plugin registers
 * every command as a refusal under one description, and no skill: those are
 * its own, and named as what they are.
 *
 * @param {{
 *   pluginRoot: string,
 *   id: string,
 *   directory: string,
 *   minimum?: string|null,
 *   plugin?: Check,
 *   ask?: (path: string) => Promise<import('./opencode-api.js').Answer>,
 *   wait?: number,
 *   pause?: (ms: number) => Promise<unknown>,
 *   now?: () => number,
 * }} options  `id` is the plugin's; `minimum` is engines.opencode's, `X.Y.Z`; `plugin` is the `plugin` line, when there is one
 * @returns {Promise<Check>}
 */
export async function checkCommands(options) {
  const { pluginRoot, id, directory } = options;
  const ask = options.ask ?? server.askRunning({ directory });
  const wait = options.wait ?? server.WAIT_MS;
  const timing = { wait, pause: options.pause, now: options.now };
  const cannot = (why) => check('commands', 'optional', 'skip', `cannot tell: ${why}`);

  // Without the plugin there is nothing of its to find, and the plugin line says why.
  if (options.plugin?.status === 'fail') return cannot(`Open Code does not run ${id} for ${directory} — see plugin`);

  const { commands } = await readShipped(pluginRoot);
  if (commands.length === 0) return cannot(`${pluginRoot} has no skills/ to compare with`);
  const loadable = commands.filter((command) => command.loadable);

  // The plugin's commands come about half a second after the first question
  // about a directory, all of them at once (F318).
  const listed = await server.waitFor(
    () => ask('/api/command'),
    (body) => {
      const names = server.commands(body);
      return commands.every((command) => names.has(command.id));
    },
    timing,
  );
  if (!listed.ok) return cannot(listed.error);
  const offered = server.commands(listed.data);
  const runs = options.plugin?.status === 'ok' || options.plugin?.status === 'warn';
  if (!runs && !commands.some((command) => offered.has(command.id))) {
    return cannot(`none of ${id}'s commands is listed for ${directory} within ${Math.round(wait / 1000)} s — see plugin, or run pdkit doctor again`);
  }

  const refusal = typeof options.minimum === 'string' ? unavailableSummary(id, options.minimum) : undefined;
  const refusing = commands.filter((command) => refusal !== undefined && offered.get(command.id) === refusal);

  /** @type {Map<string, {path: string}>} */
  let found = new Map();
  if (loadable.length > 0 && refusing.length === 0) {
    const answer = await server.waitFor(
      () => ask('/api/skill'),
      (body) => {
        const ids = server.skills(body);
        return loadable.every((command) => ids.has(command.id));
      },
      timing,
    );
    if (!answer.ok) return cannot(answer.error);
    found = server.skills(answer.data);
  }

  const missing = [];
  const replaced = [];
  for (const command of commands) {
    if (!offered.has(command.id)) missing.push(`/${command.id}`);
    else if (refusing.includes(command)) continue;
    else if (offered.get(command.id) !== command.description) {
      const shown = offered.get(command.id);
      replaced.push(`/${command.id} is not the plugin's: Open Code shows it ${shown === undefined ? 'with no description' : `as ${JSON.stringify(shown)}`}`);
    }
  }
  const elsewhere = [];
  if (refusing.length === 0) {
    for (const command of loadable) {
      const skill = found.get(command.id);
      if (skill === undefined) missing.push(`${command.id} (skill)`);
      else if (!(await sameFile(skill.path, join(pluginRoot, 'skills', command.skill, 'SKILL.md')))) {
        elsewhere.push(`the skill ${command.id} is not the plugin's: Open Code reads it from ${skill.path}`);
      }
    }
  }

  const findings = [];
  if (missing.length > 0) {
    findings.push(
      `not registered for ${directory}: ${missing.join(', ')} — see plugin; what the plugin could not register, it names on the Open Code server's stderr ("${id}: cannot …")`,
    );
  }
  if (replaced.length > 0) {
    findings.push(
      ...replaced,
      `a markdown command of the name in a commands directory of Open Code's config, command."<name>" with a template in a config document, ` +
        `or a plugin after ${id} in plugins replaces the plugin's command without a word, and runs its own text: on no model of the plugin's, ` +
        "without the label pdkit's prompt hook reads",
    );
  }
  if (elsewhere.length > 0) {
    findings.push(
      ...elsewhere,
      "a SKILL.md of the same ID in a skills directory — ~/.config/opencode, ~/.claude, ~/.agents, or the project's .opencode, .claude, " +
        ".agents — or under the skills key of a config document replaces the plugin's skill whole, and the model loads that one",
    );
  }
  if (refusing.length > 0) {
    const which = refusing.length === commands.length ? `all ${commands.length}` : refusing.map((command) => `/${command.id}`).join(', ');
    findings.push(`${which} refuse: Open Code shows them as ${JSON.stringify(refusal)} — ${id} runs below its minimum Open Code, with the gate alone, and adds no skills`);
  }

  const counted = `${commands.length} commands and ${loadable.length} skills of ${id}`;
  return findings.length === 0
    ? check('commands', 'optional', 'ok', `${counted} are registered for ${directory}, each as the plugin made it`)
    : check('commands', 'optional', 'warn', `${counted}: ${findings.join('; ')}`);
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
 * The session a doctor run from a session's shell belongs to, which the hook
 * bridge would name in every payload of that session; none from a terminal.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {string|undefined}
 */
const sessionOf = (env) => (inSession(env) ? env[SESSION_VARIABLE] : undefined);

/**
 * What the hook bridge gives `pdkit hook pre-bash` for a command the model
 * runs in `cwd`: preBash of opencode/bridge/payload.js, which lib/ does not
 * import. test/doctor.test.js holds the two to one shape.
 *
 * @param {string} command
 * @param {string} cwd
 * @param {string|undefined} session
 */
const shellPayload = (command, cwd, session) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command },
  cwd,
  session_id: session,
});

/**
 * What the hook bridge gives `pdkit hook pre-write` for a write tool that
 * would create `file`: preWrite of opencode/bridge/payload.js, held to it the
 * same way.
 *
 * @param {string} file  absolute, as the bridge makes it
 * @param {string} cwd
 * @param {string|undefined} session
 */
const writePayload = (file, cwd, session) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: { file_path: file },
  cwd,
  session_id: session,
});

/**
 * Exercise the push gate the way the hook bridge runs it.
 *
 * Every probe goes through invoke() of lib/hooks/runner.js, the call the
 * bridge makes on each command a session runs, with the payload it builds:
 * `node` from the PATH of the environment given, <plugin>/bin/pdkit hook
 * pre-bash, the deadline, and the fail-closed policy. Starting the process
 * rather than importing the handler is the whole point: this is the one check
 * where "the code is correct" is not the question. What is being tested is
 * that the hook a session starts sees the command and answers — a `node` that
 * is not there, a bin/pdkit that does not reach the handler, or a handler that
 * stopped loading all produce a plugin that looks installed and either gates
 * nothing or, failing closed, refuses everything. Whether Open Code runs the
 * plugin's hooks at all is not this check's to see: that is `hooks`, from a
 * session.
 *
 * So a probe counts by what decided it. A forbidden command passes only when
 * the hook refused it: refused for want of an answer is the policy standing in
 * for a hook that did not run, and here that is a failure. An ordinary command
 * passes only when it is let through: under Claude Code a hook that exited 1
 * let the command run, and the bridge refuses it like any other no-answer.
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
 * `env` is what the hook is started with, PDKIT_HOME aside: the doctor's own,
 * which in a session's shell is the Open Code server's, PATH and all (F93);
 * process.env when not given.
 *
 * @param {{pluginRoot: string, env?: Record<string, string|undefined>}} options
 * @returns {Promise<Check[]>}
 */
export async function gateSelftest(options) {
  const env = options.env ?? process.env;
  const session = sessionOf(env);
  const home = await mkdtemp(join(tmpdir(), 'pdkit-selftest-'));
  const hook = { root: options.pluginRoot, env: { ...env, PDKIT_HOME: home } };
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
      const decision = await invoke('pre-bash', shellPayload(probe.command, probe.outside ? outside : inside, session), hook);
      const entry = { probe: `${probe.command}  (${probe.why})`, undecided: decision.undecided };

      if (probe.deny && (!decision.block || decision.undecided)) missed.push({ ...entry, outcome: 'allowed' });
      if (!probe.deny && decision.block) overblocked.push(entry);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }

  const denies = GATE_PROBES.filter((probe) => probe.deny).length;
  const allows = GATE_PROBES.length - denies;

  return [
    ...(await ownsSelftest({ pluginRoot: options.pluginRoot, env })),
    missed.length === 0
      ? check('gate:selftest', 'required', 'ok', `${denies} forbidden commands all refused, through ${join(options.pluginRoot, 'bin', 'pdkit')}`)
      : check(
          'gate:selftest',
          'required',
          'fail',
          `THE GATE DOES NOT SEE ${missed.length} of ${denies} forbidden commands:\n      ${listed(missed)}`,
        ),
    overblocked.length === 0
      ? check('gate:allows', 'required', 'ok', `${allows} ordinary commands all allowed`)
      : check(
          'gate:allows',
          'required',
          'fail',
          `refuses ordinary work, which is how a gate gets switched off:\n      ${listed(overblocked)}`,
        ),
  ];
}

/**
 * Probes, one to a line, each with what became of it. Why the hook gave no
 * answer is said once, after them, when it is one reason for all of them — a
 * hook that never started says so once, not once a probe; with more than one,
 * each probe carries its own.
 *
 * @param {{probe: string, outcome?: string, undecided?: string}[]} entries
 * @returns {string}
 */
function listed(entries) {
  const reasons = new Set(entries.map((entry) => entry.undecided).filter(Boolean));
  const once = reasons.size === 1;
  const lines = entries.map(({ probe, outcome, undecided }) => {
    if (undecided) return `${probe} — no answer${once ? '' : `: ${undecided}`}`;
    return outcome ? `${probe} — ${outcome}` : probe;
  });
  if (once) lines.push(`the hook gave no answer: ${[...reasons][0]}`);
  return lines.join('\n      ');
}

/**
 * Exercise the ownership hook the same way: through invoke(), with the
 * payload the bridge gives `pre-write`.
 *
 * Same argument as the gate: the failure worth catching is not a wrong
 * decision, it is a hook that does not answer. pre-write fails open, so a
 * handler that stopped loading, or a hook that never started, leaves the
 * ownership map looking enforced while every write goes through. A write the
 * hook gave no answer on was not checked, which is not the same as allowed by
 * a rule, and either way the map is not enforced.
 *
 * @param {{pluginRoot: string, env: Record<string, string|undefined>}} options
 * @returns {Promise<Check[]>}
 */
async function ownsSelftest(options) {
  const home = await mkdtemp(join(tmpdir(), 'pdkit-owns-selftest-'));
  const repo = await mkdtemp(join(tmpdir(), 'pdkit-owns-selftest-repo-'));
  const hook = { root: options.pluginRoot, env: { ...options.env, PDKIT_HOME: home } };

  try {
    const tree = await realpath(repo);
    await git.text(['init', '-q', '-b', 'main'], { cwd: tree });
    await mkdir(join(tree, 'owned'), { recursive: true });
    await mkdir(join(tree, 'other'), { recursive: true });

    await setOwns(4242, 'T1', ['owned/**'], { home });
    await startTask({ issue: 4242, taskId: 'T1', worktree: tree, home });

    const probe = (file) => invoke('pre-write', writePayload(join(tree, file), tree, sessionOf(options.env)), hook);
    const outside = await probe('other/x.ts');
    const inside = await probe('owned/x.ts');

    const unanswered = [outside, inside].find((decision) => decision.undecided);
    if (unanswered) {
      return [check('owns:selftest', 'required', 'fail', `writes go through unchecked — the hook gave no answer: ${unanswered.undecided}`)];
    }
    if (!outside.block) {
      const said = outside.diagnostic ? ` (${outside.diagnostic})` : '';
      return [check('owns:selftest', 'required', 'fail', `a write outside the active task's files was allowed — the ownership map is not enforced${said}`)];
    }
    if (inside.block) {
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
 * `askServer` stands in for the running Open Code server, which the plugin,
 * models, commands and MCP checks ask about the directory; without it, they
 * ask Open Code's background service — when it runs, and not otherwise:
 * starting it would take over every session another server is in the middle
 * of a turn in, this one too when it runs here (askRunning in
 * lib/opencode-api.js). One look at the service serves every check.
 * `exec` runs `opencode` for that look and those questions; execFile when not
 * given.
 * `env` is the doctor's environment, where a session's shell puts what the
 * plugin says about itself, and the one `opencode --version` runs with when it
 * says no version; process.env when not given.
 * `db` is Open Code's session database, which the agent-done check reads the
 * subagents from; the one `env` names when not given.
 *
 * @param {{cwd?: string, home?: string, pluginRoot: string, gateSelftest?: boolean, askServer?: (path: string) => Promise<import('./opencode-api.js').Answer>, exec?: Function, env?: Record<string, string|undefined>, db?: string|null}} options
 * @returns {Promise<{status: 'ok'|'warn'|'fail', checks: Check[], home: string, repo: string|null}>}
 */
export async function diagnose(options) {
  const cwd = options.cwd;
  const env = options.env ?? process.env;
  const pkg = JSON.parse(await readFile(join(options.pluginRoot, 'package.json'), 'utf8'));
  const engines = pkg.engines ?? {};

  /** @type {Check[]} */
  const checks = [...(await checkTools(engines, env))];

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
  const directory = repo.root ?? absolute(cwd ?? '.');
  const ask = options.askServer ?? server.askRunning({ directory, exec: options.exec });
  checks.push(...(await checkHooks(options.pluginRoot, env)));
  checks.push(checkHookNode(engines.node, env));
  const plugin = await checkPlugin({ id: pkg.name, directory, env, ask });
  checks.push(plugin);
  checks.push(await checkModels({ pluginRoot: options.pluginRoot, id: pkg.name, directory, plugin, ask }));
  checks.push(
    await checkCommands({
      pluginRoot: options.pluginRoot,
      id: pkg.name,
      directory,
      minimum: minimumVersion(engines.opencode),
      plugin,
      ask,
    }),
  );
  checks.push(
    ...(await checkAgentRuns(home, Date.now(), {
      db: options.db === undefined ? databasePath(env) : options.db,
      repoRoot: repo.root,
      config,
      agents: (await readShippedAgents(options.pluginRoot)).map((agent) => agent.id),
    })),
  );
  checks.push(...(await checkMcp(config, { directory, ask })));
  // The home as given, not as a repository moved it: the binary is read the
  // way validate launch reads it.
  checks.push(...(await checkValidationTarget({ repoRoot: repo.root ?? null, home: options.home })));

  if (options.gateSelftest) {
    checks.push(...(await gateSelftest({ pluginRoot: options.pluginRoot, env })));
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

/**
 * A check's table, under its line: one row per entry, a column per key, each
 * column as wide as its widest cell.
 *
 * @param {Array<Record<string, string>>} rows
 * @returns {string[]}
 */
function tableLines(rows) {
  if (rows.length === 0) return [];
  const keys = Object.keys(rows[0]);
  const widths = keys.map((key) => Math.max(...rows.map((row) => String(row[key] ?? '').length)));
  return rows.map((row) =>
    `      ${keys.map((key, at) => (at === keys.length - 1 ? String(row[key] ?? '') : String(row[key] ?? '').padEnd(widths[at]))).join('  ')}`.trimEnd(),
  );
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
      if (entry.table) lines.push(...tableLines(entry.table));
    }
    lines.push('');
  }

  if (report.status === 'fail') lines.push('Fix the ✘ items above; the rest of pdkit assumes them.');

  return `${lines.join('\n')}\n`;
}
