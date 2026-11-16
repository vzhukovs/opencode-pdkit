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

// The host's side of `pdkit hook <event>`: run it in a child process and say
// what it decided.
//
// runHook in lib/cli.js is the handler's side of a small protocol — a payload
// on stdin; exit 2 with the reason on stderr to refuse; JSON or text on stdout
// to add context; exit 0 otherwise. The host that read it used to be Claude
// Code. Now the plugin's server part is the host, and this module is the half
// of it that knows only the protocol: it starts the process, bounds it, and
// reads exit code and output back into the object the handler's handle()
// returned, with the fail-closed policy of lib/hooks/events.js applied. The
// hook bridge turns that object into what the harness understands; the
// doctor's self-test calls the same invoke(), so what it checks is the path a
// session takes rather than a copy of it.
//
// It is loaded into the server, so it is a leaf: node:* and the hook table and
// nothing else of lib/ (test/invariants.test.js holds it to that). The rest of
// lib/ runs in the child, under Node, as it does in tests, in CI and from the
// CLI.

import { spawn as spawnProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { FAIL_CLOSED } from './events.js';

/**
 * How long a hook may take before it is stopped and counted as no answer.
 *
 * The gate's answer costs about 80ms from a cold start — `node` itself is half
 * of it — plus a few `git` calls when a rule matches. The deadline is there for
 * a hook that hangs, not one that is slow, so it is set where a machine busy
 * with a build is still well inside it: a refusal of an ordinary command
 * because the CPU was loaded is the failure that gets a gate switched off. The
 * host waits on a hook without any limit of its own, so without this a hung
 * handler would hold the command, and the turn, until somebody interrupted it.
 */
export const DEADLINE_MS = 10_000;

/** The exit code by which a handler refuses: runHook's EXIT.BLOCK. */
const BLOCK = 2;

/**
 * Names the child does not inherit from the environment it is given.
 *
 * The environment a hook is run with is whatever started the process that runs
 * it, and that is often a shell inside a Claude Code session, whose variables
 * stay behind. One of them is still read by a hook: Claude Code's process ID,
 * which prompt-submit follows to that session's transcript to see its model.
 * Here it would lead to some other session's transcript, so it is not passed on.
 * TODO(T7.4): empty once prompt-submit no longer reads it.
 */
const NOT_INHERITED = ['CLAUDE_PID'];

/**
 * The advice every refusal for want of an answer ends with. Word for word what
 * runHook writes, so that a handler that cannot run reads the same whether the
 * child or this module found out; a test compares the two.
 */
const ADVICE =
  'This hook guards writes to the upstream repository, so it refuses rather than allows when it cannot run. ' +
  'Fix the plugin or disable it — do not work around this by rephrasing the command.';

/**
 * Why a run produced no answer.
 *
 * @typedef {object} Failure
 * @property {'spawn'|'cwd'|'deadline'|'signal'} kind
 * @property {string} detail
 */

/**
 * What one run of `pdkit hook <event>` did.
 *
 * @typedef {object} Outcome
 * @property {number|null} code  the exit code; null when there was none
 * @property {string} stdout
 * @property {string} stderr
 * @property {Failure|null} failure  set when the process gave no answer at all
 */

/**
 * What the handler decided, read back from the process: the object handle()
 * returned, as far as the protocol carries it, and two fields of this module's
 * own.
 *
 * @typedef {object} Decision
 * @property {boolean} block
 * @property {string} [reason]      why it refused, for the model
 * @property {string} [message]     context for the model
 * @property {string} [notice]      for the person
 * @property {string} [undecided]   why there is no decision: the process did not start, did not answer in
 *   time, died or exited with a code the protocol does not have. On a fail-closed event `block` is then true
 * @property {string} [diagnostic]  what a run that let the call through wrote to stderr — runHook's
 *   "…; allowing" for a handler that could not run
 */

/**
 * The environment the child gets: the one it is given, less what it must not
 * inherit.
 *
 * @param {Record<string, string|undefined>} base
 * @returns {Record<string, string|undefined>}
 */
export function childEnv(base) {
  const env = { ...base };
  for (const name of NOT_INHERITED) delete env[name];
  return env;
}

/**
 * The refusal for a fail-closed event that got no answer, in runHook's words.
 *
 * @param {string} event
 * @param {string} problem  what went wrong, phrased to follow the event's name
 * @returns {string}
 */
export function refusal(event, problem) {
  return `pdkit: hook "${event}" ${problem}. ${ADVICE}`;
}

/**
 * What is wrong with the working directory the payload names, or null.
 *
 * Checked before the process is started: `spawn` answers a missing directory
 * with ENOENT, the same code as a missing `node`, and the two need different
 * fixes.
 *
 * @param {unknown} cwd
 * @returns {Promise<string|null>}
 */
async function unusable(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return 'the payload names no working directory';
  if (!isAbsolute(cwd)) return `its working directory is not an absolute path: ${cwd}`;
  try {
    if (!(await stat(cwd)).isDirectory()) return `its working directory is not a directory: ${cwd}`;
    return null;
  } catch (error) {
    if (error?.code === 'ENOENT') return `its working directory does not exist: ${cwd}`;
    return `its working directory cannot be read: ${cwd} (${error?.code ?? error?.message})`;
  }
}

/**
 * @param {string} node
 * @param {unknown} error
 * @returns {Failure}
 */
function notStarted(node, error) {
  const code = /** @type {{code?: string}} */ (error)?.code;
  if (code === 'ENOENT') {
    return {
      kind: 'spawn',
      detail: `cannot run: "${node}" was not found on the PATH of the process that runs hooks (ENOENT); pdkit's hooks need Node.js 22 or later there`,
    };
  }
  return { kind: 'spawn', detail: `cannot run: "${node}" did not start (${code ?? (error instanceof Error ? error.message : String(error))})` };
}

/**
 * Stop the child and everything it started.
 *
 * On POSIX the child leads a process group of its own (`detached`), and the
 * whole group goes: a handler stopped while `git` or `gh` waits on something
 * would otherwise leave them running. On Windows only the child is stopped.
 * TODO(T10.10): the process tree on Windows.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {boolean} group
 */
function stop(child, group) {
  try {
    if (group && child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}

/**
 * Run `pdkit hook <event>` with a payload and wait for it, bounded.
 *
 * Never rejects: whatever goes wrong comes back as `failure`, so the caller
 * decides what it means, and on the event that guards writes upstream it means
 * no.
 *
 * `node` is looked up on the PATH of the environment the child gets, not taken
 * from process.execPath: inside the Open Code server that is the server's own
 * binary. The process runs in the payload's working directory, and its stdin
 * is closed as soon as the payload is written, so runHook reads it without
 * waiting.
 *
 * @param {string} event  a key of HOOK_HANDLERS
 * @param {object} payload  what the handler reads; `cwd` is required
 * @param {{
 *   root: string,
 *   env?: Record<string, string|undefined>,
 *   deadlineMs?: number,
 *   node?: string,
 *   spawn?: typeof spawnProcess,
 * }} options  `root` is the plugin directory, whose bin/pdkit is run
 * @returns {Promise<Outcome>}
 */
export async function run(event, payload, options) {
  const { root, env = process.env, deadlineMs = DEADLINE_MS, node = 'node', spawn = spawnProcess } = options;
  const result = (fields) => ({ code: null, stdout: '', stderr: '', failure: null, ...fields });

  const cwd = payload?.cwd;
  const wrongDirectory = await unusable(cwd);
  if (wrongDirectory) return result({ failure: { kind: 'cwd', detail: `cannot run: ${wrongDirectory}` } });

  let input;
  try {
    input = JSON.stringify(payload);
  } catch (error) {
    return result({ failure: { kind: 'spawn', detail: `cannot run: its payload is not JSON (${error.message})` } });
  }

  const group = process.platform !== 'win32';

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(node, [join(root, 'bin', 'pdkit'), 'hook', event], {
        cwd,
        env: childEnv(env),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: group,
        windowsHide: true,
      });
    } catch (error) {
      resolve(result({ failure: notStarted(node, error) }));
      return;
    }

    const out = [];
    const err = [];
    let settled = false;
    let timer;
    const settle = (fields) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(
        result({
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          ...fields,
        }),
      );
    };

    timer = setTimeout(() => {
      stop(child, group);
      settle({ failure: { kind: 'deadline', detail: `gave no answer within ${deadlineMs / 1000}s and was stopped` } });
    }, deadlineMs);

    child.stdout?.on('data', (chunk) => out.push(chunk));
    child.stderr?.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => {
      if (settled) return;
      stop(child, group);
      settle({ failure: notStarted(node, error) });
    });
    child.on('close', (code, signal) => {
      settle(signal ? { failure: { kind: 'signal', detail: `was killed by ${signal}` } } : { code });
    });

    // A child that exits before reading — no node, a crash on load — closes
    // the pipe under the write; that is its exit to report, not an error here.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

/**
 * The part of a crash worth quoting: the error line, and the Node.js version
 * Node prints after an uncaught one, which is what tells a too-old `node`.
 *
 * @param {string} stderr
 * @returns {string}
 */
function excerpt(stderr) {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const error = lines.find((line) => /^[\w.]*(Error|Exception)\b/.test(line)) ?? lines[0];
  const runtime = lines.find((line) => /^Node\.js v\d/.test(line));
  return [...new Set([error, runtime].filter(Boolean))].join('; ').slice(0, 400);
}

/**
 * Why the outcome is not an answer, or null when it is one.
 *
 * @param {Outcome} outcome
 * @returns {string|null}
 */
function problemOf(outcome) {
  if (outcome.failure) return outcome.failure.detail;
  if (outcome.code === 0 || outcome.code === BLOCK) return null;
  const said = excerpt(outcome.stderr);
  return `exited with code ${outcome.code}${said ? ` (${said})` : ' and wrote nothing to stderr'}`;
}

/**
 * The protocol's JSON on stdout, or null when stdout is a message in plain
 * text.
 *
 * @param {string} text
 * @returns {{systemMessage?: unknown, hookSpecificOutput?: {additionalContext?: unknown}}|null}
 */
function structured(text) {
  if (!text.startsWith('{')) return null;
  try {
    const value = JSON.parse(text);
    const shaped = value && typeof value === 'object' && !Array.isArray(value);
    return shaped && ('systemMessage' in value || 'hookSpecificOutput' in value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * What a run that allowed said: runHook's three shapes of stdout, read back.
 *
 * @param {string} stdout
 * @returns {{message?: string, notice?: string}}
 */
function said(stdout) {
  const text = stdout.trimEnd();
  if (text.trim() === '') return {};

  const json = structured(text.trim());
  if (!json) return { message: text };

  const fields = {};
  if (typeof json.systemMessage === 'string') fields.notice = json.systemMessage;
  const context = json.hookSpecificOutput?.additionalContext;
  if (typeof context === 'string') fields.message = context;
  return fields;
}

/**
 * Read an outcome back into a decision: runHook in reverse, plus the policy for
 * a run that did not answer.
 *
 * Exit 2 is a refusal with stderr as the reason — the handler's, or runHook's
 * own when the handler could not run; for the caller the two are the same.
 * Exit 0 is an answer that allows. Anything else — no process, no answer in
 * time, a signal, a code the protocol does not have — is no answer, and what no
 * answer means is FAIL_CLOSED's to say: a refusal in runHook's words on the
 * event that guards writes upstream, a pass that says why on every other.
 *
 * @param {string} event
 * @param {Outcome} outcome
 * @returns {Decision}
 */
export function decide(event, outcome) {
  const problem = problemOf(outcome);
  if (problem !== null) {
    if (FAIL_CLOSED.includes(event)) return { block: true, reason: refusal(event, problem), undecided: problem };
    return { block: false, undecided: problem, diagnostic: `pdkit: hook "${event}" ${problem}; allowing` };
  }

  if (outcome.code === BLOCK) {
    return { block: true, reason: outcome.stderr.trimEnd() || `pdkit: hook "${event}" refused without saying why` };
  }

  const decision = { block: false, ...said(outcome.stdout) };
  const diagnostic = outcome.stderr.trim();
  if (diagnostic) decision.diagnostic = diagnostic;
  return decision;
}

/**
 * Run the hook and read its decision: what the bridge and the doctor's
 * self-test both call.
 *
 * @param {string} event
 * @param {object} payload
 * @param {Parameters<typeof run>[2]} options
 * @returns {Promise<Decision>}
 */
export async function invoke(event, payload, options) {
  return decide(event, await run(event, payload, options));
}
