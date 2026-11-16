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
