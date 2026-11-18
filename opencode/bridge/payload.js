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
// callback. Pure functions: whatever needs the host is passed in — as data,
// and, for the one fact a payload needs that no event carries (how many lines
// a file has, for post-read), as a function the caller gives.
//
// Three fields are always set. `hook_event_name`, because runHook shapes its
// output by it. `cwd`, because a handler that is given none falls back to its
// own working directory, and the bridge's process runs where the server was
// started, not where the session works. `session_id`, as Claude Code sent it.
// `transcript_path` never: Open Code keeps no transcript file to point at.

import { isAbsolute, posix, resolve, win32 } from 'node:path';

import { parse as parsePatch, touched } from './patch.js';

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

/**
 * A drive path as a POSIX shell spells it on Windows — `/c/…`, `/cygdrive/c/…`,
 * `/mnt/c/…` — as Windows spells it, the way Open Code rewrites a path before
 * it resolves one (FSUtil.windowsPath). Nothing to do anywhere else.
 *
 * @param {string} path
 * @returns {string}
 */
function windowsPath(path) {
  const drive = (_, letter) => `${letter.toUpperCase()}:/`;
  return path
    .replace(/^\/([a-zA-Z]):(?:[\\/]|$)/, drive)
    .replace(/^\/([a-zA-Z])(?:\/|$)/, drive)
    .replace(/^\/cygdrive\/([a-zA-Z])(?:\/|$)/, drive)
    .replace(/^\/mnt\/([a-zA-Z])(?:\/|$)/, drive);
}

/**
 * The file a path a model wrote names, worked out as Open Code works it out
 * before a write tool touches the disk (FileAccess's resolvePath): `~` and
 * `~/…` from the home directory, anything else from the session's directory.
 * Not from the process's: the server's is wherever it was started — for the
 * background service, the home directory.
 *
 * Undefined when the path is relative and there is no directory to take it
 * from.
 *
 * @param {string|undefined} directory  ctx.location.directory
 * @param {string} given  the path as the model wrote it
 * @param {{home: string, platform?: string}} host
 * @returns {string|undefined}
 */
export function hostPath(directory, given, { home, platform = process.platform }) {
  const windows = platform === 'win32';
  const path = windows ? win32 : posix;
  const normalized = windows ? windowsPath(given) : given;
  const expanded =
    normalized === '~' ? home : normalized.startsWith('~/') || (windows && normalized.startsWith('~\\')) ? path.join(home, normalized.slice(2)) : normalized;
  if (typeof directory === 'string' && directory !== '') return path.resolve(directory, expanded);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : undefined;
}

/** The write tools that name one file, as Claude Code's tool of the same job. */
const ONE_FILE = { write: 'Write', edit: 'Edit' };

/**
 * The files a patch leaves on disk, each with whether it is new there: a file
 * it adds, and a file it updates — at the path it moves it to, when it moves
 * it. Not a file it deletes, and not the path a file was moved from: there is
 * nothing there any more to look at.
 *
 * @param {import('./patch.js').Hunk[]} hunks
 * @returns {{path: string, created: boolean}[]}
 */
function written(hunks) {
  return hunks.flatMap((hunk) => {
    if (hunk.type === 'add') return [{ path: hunk.path, created: true }];
    if (hunk.type === 'update') return [hunk.movePath ? { path: hunk.movePath, created: true } : { path: hunk.path, created: false }];
    return [];
  });
}

/**
 * Files of one call of a write tool, as the model named them, each with the
 * Claude Code tool that would have made that change: Write for a file that
 * comes into being, Edit for one that exists already. Empty for any other
 * tool, and for a call whose input names nothing the tool would accept.
 *
 * write and edit name one file. Which files of a patch count is the caller's
 * to say: every file it touches, before it runs (touched); the files it leaves
 * behind, after (written).
 *
 * The input is as the model sent it — Open Code checks it against the tool's
 * schema only after execute.before (F38). So a path that is missing or not a
 * string is no path: the tool would refuse the call anyway. A patch the tool
 * cannot read is refused by the tool before it writes anything, and is no
 * file here.
 *
 * @param {{tool?: string, input?: unknown}|undefined} event
 * @param {(hunks: import('./patch.js').Hunk[]) => {path: string, created: boolean}[]} filesOfPatch
 * @returns {{path: string, tool_name: 'Write'|'Edit'}[]}
 */
function changes(event, filesOfPatch) {
  const input = event?.input;
  if (input === null || typeof input !== 'object') return [];

  if (Object.hasOwn(ONE_FILE, event?.tool)) {
    return typeof input.path === 'string' && input.path !== '' ? [{ path: input.path, tool_name: ONE_FILE[event.tool] }] : [];
  }

  if (event.tool === 'patch' && typeof input.patchText === 'string') {
    const parsed = parsePatch(input.patchText);
    if ('error' in parsed) return [];
    return filesOfPatch(parsed.hunks).map(({ path, created }) => ({ path, tool_name: created ? 'Write' : 'Edit' }));
  }

  return [];
}

/**
 * One payload for each file, with `file_path` absolute and a file named twice
 * once.
 *
 * @template {'PreToolUse'|'PostToolUse'} E
 * @param {E} hookEventName
 * @param {{path: string, tool_name: 'Write'|'Edit'}[]} files
 * @param {{sessionID?: string}|undefined} event
 * @param {{directory: string|undefined, home: string, platform?: string}} host
 * @returns {Array<{hook_event_name: E, tool_name: 'Write'|'Edit', tool_input: {file_path: string}, cwd?: string, session_id?: string}>}
 */
function payloadsFor(hookEventName, files, event, host) {
  const payloads = [];
  const seen = new Set();
  for (const { path, tool_name } of files) {
    const file = hostPath(host.directory, path, host) ?? path;
    if (seen.has(file)) continue;
    seen.add(file);
    payloads.push({
      hook_event_name: hookEventName,
      tool_name,
      tool_input: { file_path: file },
      cwd: workingDirectory(host.directory, undefined),
      session_id: event?.sessionID,
    });
  }
  return payloads;
}

/**
 * The payloads for `pdkit hook pre-write`: Claude Code's PreToolUse on Write
 * or Edit, one for each file the call would change — every one of them has to
 * be the active task's to write.
 *
 * write and edit name one file. patch names any number, and all of them count:
 * a file it adds or updates, a file it deletes, and both ends of a file it
 * moves — taking a file away from where another task owns it is as much a
 * collision as editing it (decided with T4.6). A file named twice is checked
 * once.
 *
 * `file_path` is absolute, worked out as the tool works it out (hostPath):
 * owns.js takes a relative one from `cwd`, and has no `~`.
 *
 * @param {{tool?: string, sessionID?: string, input?: unknown}} event  execute.before's event
 * @param {{directory: string|undefined, home: string, platform?: string}} host
 *   ctx.location.directory, and the home directory Open Code expands `~` to
 * @returns {Array<{hook_event_name: 'PreToolUse', tool_name: 'Write'|'Edit', tool_input: {file_path: string}, cwd?: string, session_id?: string}>}
 */
export function preWrite(event, host) {
  return payloadsFor('PreToolUse', changes(event, touched), event, host);
}

/**
 * The payloads for `pdkit hook post-write`: Claude Code's PostToolUse on Write
 * or Edit, one for each file a call of a write tool left on disk.
 *
 * Only after a call that succeeded: Claude Code ran PostToolUse when a tool
 * had done its work, and a failed one went to PostToolUseFailure, which pdkit
 * never registered. A patch is applied whole or not at all (F40), so a
 * completed one wrote every file it names; of those, post-write looks at the
 * ones still there — added, updated, and moved to — and not at a file deleted
 * or at the path one was moved from.
 *
 * No `tool_response`. post-write reads `file_path` alone, and reads the file
 * from disk: the result of a write tool here carries none of the file's text
 * (F43), and what is on disk is what a formatter left there (F44).
 *
 * @param {{tool?: string, sessionID?: string, status?: string, input?: unknown}} event  execute.after's event
 * @param {{directory: string|undefined, home: string, platform?: string}} host
 *   ctx.location.directory, and the home directory Open Code expands `~` to
 * @returns {Array<{hook_event_name: 'PostToolUse', tool_name: 'Write'|'Edit', tool_input: {file_path: string}, cwd?: string, session_id?: string}>}
 */
export function postWrite(event, host) {
  if (event?.status !== 'completed') return [];
  return payloadsFor('PostToolUse', changes(event, written), event, host);
}

/**
 * The payload for `pdkit hook post-bash`: Claude Code's PostToolUse on Bash,
 * for a command the shell tool ran to an exit of 0, with what it printed. At
 * most one: a call is one command.
 *
 * Only the shell tool, as the matcher was Bash alone. Not every call that
 * carries a command, as the gate reads (§13 DV5): that is where a write
 * upstream could hide, and post-bash guards none.
 *
 * Only a command that exited 0. Claude Code ran PostToolUse when a tool
 * succeeded, and a Bash command that exited otherwise was a tool that failed
 * — PostToolUseFailure, which pdkit never registered. Open Code reports such a
 * command as a call that completed, with its exit code in the output (F264),
 * so the bridge reads the code where Claude Code read the outcome. A command
 * moved to the background has no code yet, and is not looked at either.
 *
 * `tool_response.stdout` is the shell tool's own output, where post-bash reads
 * it: the command's stdout and stderr in one stream, as Claude Code's Bash put
 * them in its `stdout` (F264); its `stderr` held notices of the tool's own,
 * which have no counterpart here. Not the result's text parts: those are the
 * output as well, for a command that exited 0, and whatever another plugin
 * added to it. What Open Code puts there for a command that printed nothing,
 * `(no output)`, is passed on as it is: no block opens in it.
 *
 * `cwd` is where the command ran, as pre-bash takes it; post-bash itself
 * reads no path.
 *
 * @param {{tool?: string, sessionID?: string, status?: string, input?: unknown, result?: unknown}} event  execute.after's event
 * @param {{directory: string|undefined}} host  ctx.location.directory
 * @returns {Array<{hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {command: string}, tool_response: {stdout: string}, cwd?: string, session_id?: string}>}
 */
export function postBash(event, host) {
  if (event?.tool !== 'shell' || event.status !== 'completed') return [];
  const input = event.input;
  if (input === null || typeof input !== 'object' || typeof input.command !== 'string' || input.command === '') return [];
  const output = event.result?.output;
  if (output === null || typeof output !== 'object' || output.exitCode !== 0 || typeof output.output !== 'string') return [];
  return [
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: input.command },
      tool_response: { stdout: output.output },
      cwd: workingDirectory(host.directory, input.workdir),
      session_id: event.sessionID,
    },
  ];
}

/** Where a handler reads the text a call wrote: a Write's whole file, an Edit's new text. */
const TEXT_FIELD = { Write: 'content', Edit: 'new_string' };

/**
 * The text one call of a write tool wrote, file by file, as the model named
 * the files, each with the Claude Code tool whose payload carries it: Write
 * for the whole of a file, Edit for new text in one. Empty for any other tool,
 * and for a call whose input names nothing the tool would accept.
 *
 * write writes its `content`, whole. edit writes its `newString`, Edit's
 * `new_string` (F38). A patch writes, for a file it adds, its contents, and
 * for a file it updates — where it moves it to, when it moves it — the lines
 * its chunks add (`addedLines`): not a line of context, which was there
 * before, and not a line it removes. A file it deletes it writes nothing in.
 *
 * @param {{tool?: string, input?: unknown}|undefined} event
 * @returns {{path: string, tool_name: 'Write'|'Edit', text: string}[]}
 */
function texts(event) {
  const input = event?.input;
  if (input === null || typeof input !== 'object') return [];
  const text = (value) => (typeof value === 'string' ? value : '');

  if (Object.hasOwn(ONE_FILE, event?.tool)) {
    if (typeof input.path !== 'string' || input.path === '') return [];
    return [{ path: input.path, tool_name: ONE_FILE[event.tool], text: text(event.tool === 'write' ? input.content : input.newString) }];
  }

  if (event.tool === 'patch' && typeof input.patchText === 'string') {
    const parsed = parsePatch(input.patchText);
    if ('error' in parsed) return [];
    return parsed.hunks.flatMap((hunk) => {
      if (hunk.type === 'add') return [{ path: hunk.path, tool_name: 'Write', text: hunk.contents }];
      if (hunk.type === 'update') return [{ path: hunk.movePath ?? hunk.path, tool_name: 'Edit', text: hunk.chunks.flatMap((chunk) => chunk.addedLines).join('\n') }];
      return [];
    });
  }

  return [];
}

/**
 * The payloads for `pdkit hook post-claim`: Claude Code's PostToolUse on Write
 * or Edit, one for each markdown file a call of a write tool wrote text in,
 * with that text — a Write's `content`, an Edit's `new_string` — which is
 * where post-claim reads the claims it checks.
 *
 * Only after a call that succeeded, as post-write. Only markdown: post-claim's
 * own first test is a `file_path` ending in `.md`, and a run for any other
 * file would be a process that says nothing — the bridge filters what it can
 * before a run (D7). The test is the handler's, on the same path, so the two
 * cannot disagree; the handler still makes it.
 *
 * `file_path` is absolute (hostPath), and that matters here: post-claim leaves
 * the file it was given out of its search, and takes a relative path for one
 * from the repository's root, not from `cwd` — wrong for a session in a
 * subdirectory (T1.4). A file a patch names twice is one payload, with the
 * text of each hunk in the order of the patch.
 *
 * @param {{tool?: string, sessionID?: string, status?: string, input?: unknown}} event  execute.after's event
 * @param {{directory: string|undefined, home: string, platform?: string}} host
 *   ctx.location.directory, and the home directory Open Code expands `~` to
 * @returns {Array<{hook_event_name: 'PostToolUse', tool_name: 'Write'|'Edit', tool_input: {file_path: string, content?: string, new_string?: string}, cwd?: string, session_id?: string}>}
 */
export function postClaim(event, host) {
  if (event?.status !== 'completed') return [];
  /** @type {Map<string, ReturnType<typeof postClaim>[number]>} */
  const payloads = new Map();
  for (const { path, tool_name, text } of texts(event)) {
    const file = hostPath(host.directory, path, host) ?? path;
    if (!file.endsWith('.md')) continue;
    const known = payloads.get(file);
    if (known) {
      const field = TEXT_FIELD[known.tool_name];
      known.tool_input[field] = `${known.tool_input[field]}\n${text}`;
      continue;
    }
    payloads.set(file, {
      hook_event_name: 'PostToolUse',
      tool_name,
      tool_input: { file_path: file, [TEXT_FIELD[tool_name]]: text },
      cwd: workingDirectory(host.directory, undefined),
      session_id: event?.sessionID,
    });
  }
  return [...payloads.values()];
}

/**
 * A page of a text file, as the read tool reports one (F48): what it read, the
 * line it started at, and whether lines follow it. Not a whole file (`file`,
 * which is never a window), a directory (`list-page`), or an image or a PDF.
 *
 * @param {unknown} output  the read tool's result.output
 * @returns {boolean}
 */
function isPage(output) {
  return (
    output !== null &&
    typeof output === 'object' &&
    output.type === 'text-page' &&
    typeof output.content === 'string' &&
    Number.isInteger(output.offset) &&
    output.offset >= 1 &&
    typeof output.truncated === 'boolean'
  );
}

/**
 * The payload for `pdkit hook post-read` after a read: Claude Code's
 * PostToolUse on Read, with the part of the file it returned — which lines,
 * out of how many. Empty for a read of a whole file.
 *
 * The window is the read tool's own report (F48): a page that starts past the
 * first line, or one with lines after it. A file read with neither offset nor
 * limit comes back whole, however many lines it has, while it is under 50 KB:
 * no window — the model saw all of it.
 *
 * Claude Code's Read said how many lines the file has; the read tool says it
 * only of a page that reaches the end, whose last line is the file's. For a
 * page with lines after it, the bridge counts the lines of the file on disk
 * (`host.lines`), as the tool counts them, in the file the tool read: the
 * path as the model wrote it, worked out as the tool works it out (hostPath,
 * F265). A file it cannot count — not on disk, gone, or shorter by now than
 * the page says it is — is a failure of the bridge: no payload, and post-read
 * fails open with a line in the log (§13 DV9). The count is never made up:
 * post-read's text names it.
 *
 * `content` is the page's text without the line numbers the model sees beside
 * it, as Claude Code's `file.content` was (F50).
 *
 * @param {{sessionID?: string, input: {path?: unknown}, result?: {output?: unknown}}} event
 * @param {{directory: string|undefined, home: string, platform?: string, lines: (file: string) => Promise<number>}} host
 * @returns {Promise<Array<{hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {file_path: string}, tool_response: {type: 'text', file: {filePath: string, content: string, startLine: number, numLines: number, totalLines: number}}, cwd?: string, session_id?: string}>>}
 */
async function readPayloads(event, host) {
  const { input } = event;
  if (typeof input.path !== 'string' || input.path === '') return [];
  const page = event.result?.output;
  if (!isPage(page) || !(page.offset > 1 || page.truncated)) return [];
  // As the tool counts the lines it shows the model (toModelContent): none in an empty page.
  const numLines = page.content === '' ? 0 : page.content.split('\n').length;
  if (numLines === 0) return [];

  const resolved = hostPath(host.directory, input.path, host);
  const file = resolved ?? input.path;
  const end = page.offset + numLines - 1;
  let totalLines = end;
  if (page.truncated) {
    if (resolved === undefined) throw new Error(`cannot tell which file "${input.path}" is: the session has no directory`);
    totalLines = await host.lines(resolved);
    // The page says a line follows it. A file that has none by now is not the
    // file that was read, and its count would name a window that never was.
    const follows = Number.isInteger(page.next) ? page.next : end + 1;
    if (totalLines < follows) throw new Error(`${resolved} has ${totalLines} lines now, and the read showed it had at least ${follows}`);
  }
  return [
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: file },
      tool_response: { type: 'text', file: { filePath: file, content: page.content, startLine: page.offset, numLines, totalLines } },
      cwd: workingDirectory(host.directory, undefined),
      session_id: event.sessionID,
    },
  ];
}

/**
 * The payload for `pdkit hook post-read` after a grep: Claude Code's
 * PostToolUse on Grep in its content mode — the only one the grep tool has —
 * with the cap it applied, when the cap cut the matches short. Empty for a
 * search that returned every match.
 *
 * Claude Code's Grep set `appliedLimit` when there were more matches than its
 * limit; the grep tool says so with `truncated`, and a search it cut returns
 * exactly its limit of matches (F265). Its other window, context around a
 * match (`-A`/`-B`/`-C`), the grep tool does not have, and Open Code strips
 * those keys from the input before any hook (F51, F265): there is nothing to
 * pass. A model that wants context reads it through the shell, which is
 * post-bash's.
 *
 * `content` is the lines that matched, in order — what was read. Claude Code
 * prefixed each with a file and a line number, and the result here has
 * absolute paths and a count around them; none of it is the file's text.
 *
 * @param {{sessionID?: string, input: {pattern?: unknown}, result?: {output?: unknown, metadata?: unknown}}} event
 * @param {{directory: string|undefined}} host
 * @returns {Array<{hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_input: {pattern: string}, tool_response: {mode: 'content', content: string, appliedLimit: number}, cwd?: string, session_id?: string}>}
 */
function grepPayloads(event, host) {
  const { input } = event;
  if (typeof input.pattern !== 'string' || input.pattern === '') return [];
  const matches = event.result?.output;
  if (!Array.isArray(matches) || event.result?.metadata?.truncated !== true) return [];
  return [
    {
      hook_event_name: 'PostToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: input.pattern },
      tool_response: { mode: 'content', content: matches.map((match) => (typeof match?.text === 'string' ? match.text : '')).join(''), appliedLimit: matches.length },
      cwd: workingDirectory(host.directory, undefined),
      session_id: event.sessionID,
    },
  ];
}

/**
 * The payload for `pdkit hook post-read`: Claude Code's PostToolUse on Read or
 * Grep, for a read or a search that returned part of what there was — a
 * window — with what it returned. At most one: a call is one read.
 *
 * Only after a call that succeeded. Claude Code ran PostToolUse when a tool
 * had done its work, and a Read or a Grep that failed — no such file, a
 * binary one, a pattern that does not parse — went to PostToolUseFailure,
 * which pdkit never registered. Open Code reports such a call with
 * `status: "error"` and no result (F32, F265).
 *
 * Only through a window: the tool reports one, and a read without one has
 * nothing for post-read — the bridge filters what it can before a run (D7).
 * Whether what came back ends inside a block is the handler's to say.
 *
 * @param {{tool?: string, sessionID?: string, status?: string, input?: unknown, result?: unknown}} event  execute.after's event
 * @param {{directory: string|undefined, home: string, platform?: string, lines: (file: string) => Promise<number>}} host
 *   ctx.location.directory, the home directory Open Code expands `~` to, and
 *   how many lines a file on disk has, counted as the read tool counts them
 * @returns {Promise<object[]>}
 */
export async function postRead(event, host) {
  if (event?.status !== 'completed') return [];
  if (event.input === null || typeof event.input !== 'object') return [];
  if (event.tool === 'read') return readPayloads(event, host);
  if (event.tool === 'grep') return grepPayloads(event, host);
  return [];
}

/**
 * The payload for `pdkit hook subagent-stop`: Claude Code's SubagentStop, for
 * a child session that has finished its model work and is about to go idle —
 * experimental.idle, which Open Code calls for every session, top-level ones
 * included (F57). At most one: a session that has no parent is no subagent,
 * and gets none, so no process is started for it.
 *
 * Each field from where Open Code keeps it (F54, F57, F58):
 *
 * - `agent_id` is the child session's ID. It names the run, and stays the same
 *   across every stop of it, held or not, and across later rounds: the stall
 *   limit counts a run's stops by it, and the doctor tells this harness's
 *   entries in the journal from Claude Code's by its shape (D10).
 * - `agent_type` is the agent the child runs, by the ID it was registered
 *   under. A child with none — never seen: Open Code records the agent of
 *   every child — gets no field, which task-completed.js reads as a host that
 *   stopped saying, and holds to the receipt: the gate's default. Not the
 *   empty string, which is Claude Code saying "one of the host's own" and is
 *   let through uncounted.
 * - `session_id` is the session at the top of the chain of parents, the one a
 *   person drives: the caller resolves it (`root`). What started the task is
 *   that session's shell command.
 * - `cwd` is the child's directory, which is its parent's when it was made.
 * - `stop_hook_active` is the bridge's to say (`held`): Open Code does not
 *   tell a plugin whether it held a session before.
 *
 * `transcript_path`, `agent_transcript_path` and `last_assistant_message` are
 * not set: Open Code keeps no transcript file, and task-completed.js reads
 * none of them.
 *
 * @param {{sessionID?: string}} event  experimental.idle's event
 * @param {{session: {parentID?: unknown, agent?: unknown, location?: {directory?: unknown}}|undefined, root: string|undefined, held: boolean}} host
 *   the session's record (ctx.session.get), the session at the top of its
 *   chain, and whether the bridge held this session's last stop
 * @returns {Array<{hook_event_name: 'SubagentStop', agent_id: string, agent_type?: string, session_id: string, cwd?: string, stop_hook_active: boolean}>}
 */
export function subagentStop(event, host) {
  const { session } = host;
  if (typeof event?.sessionID !== 'string' || event.sessionID === '') return [];
  if (typeof session?.parentID !== 'string' || session.parentID === '') return [];
  const directory = session.location?.directory;
  return [
    {
      hook_event_name: 'SubagentStop',
      agent_id: event.sessionID,
      ...(typeof session.agent === 'string' && session.agent !== '' ? { agent_type: session.agent } : {}),
      session_id: typeof host.root === 'string' && host.root !== '' ? host.root : session.parentID,
      cwd: typeof directory === 'string' && directory !== '' ? directory : undefined,
      stop_hook_active: host.held === true,
    },
  ];
}

/**
 * Whether a session has never run: no execution started (`time.busy`), none
 * ended (`time.idle`, `outcome`), and not a fork, which carries the turns of
 * the session it was forked from. Its prompt is then the first one, which is
 * where Claude Code's SessionStart fell for a new session: before the first
 * prompt (F67 — in Open Code a new session, and one after /new or /clear,
 * exists only from its first prompt). Read from the session's record, not
 * from session.created: the event comes before the plugin is loaded in a
 * directory no session has run in yet, and that instance never sees it (F270).
 *
 * @param {{fork?: unknown, outcome?: unknown, time?: {busy?: unknown, idle?: unknown}}|undefined} session
 *   the session's record (ctx.session.get)
 * @returns {boolean}
 */
export function startsSession(session) {
  if (session === null || typeof session !== 'object') return false;
  if (session.fork !== undefined && session.fork !== null) return false;
  if (session.outcome !== undefined && session.outcome !== null) return false;
  return session.time?.busy === undefined && session.time?.idle === undefined;
}

/**
 * The payload for `pdkit hook session-start`: Claude Code's SessionStart, for
 * a session a person drives that starts, is forked, or was compacted. At most
 * one: a session with a parent is a subagent's, and Claude Code ran no
 * SessionStart for those, so none is built and no process started for it.
 *
 * `source` is Claude Code's word for why: `startup` for a session's first
 * prompt (Open Code tells a new session from one after /clear no more than
 * the handler needs to), `resume` for a fork — Claude Code's fork was a
 * resumed session under a new ID — and `compact` after a compaction. A
 * session continued as it is has no event in Open Code, and gets no payload
 * (§13). session-start.js reads only `cwd`; the rest is there because Claude
 * Code sent it.
 *
 * @param {{sessionID?: string}} event  the hook's event, or the event's data
 * @param {{session: {parentID?: unknown, location?: {directory?: unknown}}|undefined, source: 'startup'|'resume'|'compact'}} host
 *   the session's record (ctx.session.get), and why the summary is asked for
 * @returns {Array<{hook_event_name: 'SessionStart', source: string, session_id: string, cwd?: string}>}
 */
export function sessionStart(event, host) {
  const { session } = host;
  if (typeof event?.sessionID !== 'string' || event.sessionID === '') return [];
  if (session === null || typeof session !== 'object') return [];
  if (typeof session.parentID === 'string' && session.parentID !== '') return [];
  const directory = session.location?.directory;
  return [
    {
      hook_event_name: 'SessionStart',
      source: host.source,
      session_id: event.sessionID,
      cwd: typeof directory === 'string' && directory !== '' ? directory : undefined,
    },
  ];
}

/**
 * The payload for `pdkit hook pre-compact`: Claude Code's PreCompact, for a
 * session about to be compacted — any session, a subagent's included: Open
 * Code compacts a subagent's session as it compacts a person's, and the
 * handler writes the same entry whichever it is (the active task of the
 * directory).
 *
 * - `session_id` is the session being compacted. For a subagent's, Claude Code
 *   would have sent its parent's: finding that takes a lookup, which the
 *   compaction would wait on, and session-start.js reads only `cwd`.
 * - `cwd` is the plugin instance's directory: the compaction hook's event
 *   names none, and Open Code calls it in the instance of the session's
 *   directory (F72, F137).
 *
 * `trigger` and `custom_instructions` are not set: the hook's event carries
 * neither whether the compaction was asked for nor any words for it, and the
 * handler reads neither.
 *
 * @param {{sessionID?: string}} event  the compaction hook's event
 * @param {string|undefined} directory  ctx.location.directory
 * @returns {Array<{hook_event_name: 'PreCompact', session_id: string, cwd?: string}>}
 */
export function preCompact(event, directory) {
  if (typeof event?.sessionID !== 'string' || event.sessionID === '') return [];
  return [
    {
      hook_event_name: 'PreCompact',
      session_id: event.sessionID,
      cwd: typeof directory === 'string' && directory !== '' ? directory : undefined,
    },
  ];
}

/**
 * Who labeled a prompt as a pdkit command's: the plugin, by its ID. The
 * registrar puts the label on the prompt each command sends (D6); this is
 * where it is read.
 */
export const LABEL_SOURCE = 'opencode-pdkit';

/** A pdkit command's name as its label carries it: `pd:<skill>`, as the person typed it after the slash. */
const COMMAND = /^pd:[a-z][a-z-]*$/;

/**
 * The payload for `pdkit hook prompt-submit`: Claude Code's UserPromptSubmit,
 * for the prompt a pdkit command sends, with the command as the person typed
 * it — `/pd:<skill> <arguments>`. At most one.
 *
 * Open Code's prompt hook never sees what the person typed (F76, F77): the TUI
 * runs the command, whose execute builds the prompt itself, and the hook gets
 * that. So a pdkit command labels the prompt it sends —
 * `metadata: { source: "opencode-pdkit", command: "pd:<skill>", arguments }`
 * (D6, F80) — and the line is put back together from the label: the shape
 * prompt-submit.js reads as typed.
 *
 * Any other prompt has no label and gets no payload: what a person types, a
 * subagent's first task, another plugin's prompt, a command that is not
 * pdkit's. prompt-submit looks at nothing but a `/pd:` command and runs on
 * every prompt, so everything else returns before anything is read (D6). That
 * includes a `/pd:` line that arrives as text, which is a command that did not
 * run: Open Code sends one as it is where no command is run — `opencode run`,
 * a name the TUI does not have (F76, F78).
 *
 * `cwd` is the session's directory: the hook's event names none, and Open Code
 * calls it in the plugin instance of the directory the session is in — after
 * a move, the one it moved to (F75, F275). Read only for a labeled prompt:
 * `host.directory` may be a getter. `transcript_path` is not set: Open Code
 * keeps no transcript file, and the handler reads none.
 *
 * @param {{sessionID?: string, metadata?: unknown}} event  the prompt hook's event
 * @param {{directory: string|undefined}} host  ctx.location.directory
 * @returns {Array<{hook_event_name: 'UserPromptSubmit', prompt: string, session_id: string, cwd?: string}>}
 */
export function promptSubmit(event, host) {
  if (typeof event?.sessionID !== 'string' || event.sessionID === '') return [];
  const label = event.metadata;
  if (label === null || typeof label !== 'object' || label.source !== LABEL_SOURCE) return [];
  if (typeof label.command !== 'string' || !COMMAND.test(label.command)) return [];
  const given = typeof label.arguments === 'string' ? label.arguments : '';
  const directory = host.directory;
  return [
    {
      hook_event_name: 'UserPromptSubmit',
      prompt: given.trim() === '' ? `/${label.command}` : `/${label.command} ${given}`,
      session_id: event.sessionID,
      cwd: typeof directory === 'string' && directory !== '' ? directory : undefined,
    },
  ];
}
