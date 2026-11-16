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

// The text of a call to Open Code's patch tool, read the way the tool reads it.
//
// Open Code hands some models — those whose ID names a GPT model — a single
// tool for writing files, `patch`, in place of write and edit. Its input is one
// string, and the files it adds, changes, moves and deletes are named only
// inside that string. A hook that checks which files a call writes has to read
// them out of it.
//
// The tool reads the text with a parser of its own (Patch.parse in Open Code's
// @opencode/util), which a plugin cannot import: the host supplies a plugin
// with its plugin API and nothing else. This module is that parser, ported
// from Open Code 2.3.0 rather than written to the format's description, and it
// is deliberately as strict and as lenient as the original. A reading that
// accepted less would let a patch the tool applies past the check; one that
// accepted more would find a file in a line the tool treats as content — a
// context line that happens to look like a header — and refuse an honest
// patch. So where the tool gives up, this gives up too, and the tool then
// writes nothing.
//
// Only the reading. Applying the hunks to a file is the tool's business.

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const ENVIRONMENT = '*** Environment ID:';
const ADD = '*** Add File: ';
const DELETE = '*** Delete File: ';
const UPDATE = '*** Update File: ';
const MOVE = '*** Move to: ';
const END_OF_FILE = '*** End of File';

/**
 * @typedef {{oldLines: string[], newLines: string[], changeContext?: string, endOfFile?: boolean}} Chunk
 * @typedef {{type: 'add', path: string, contents: string}
 *   | {type: 'delete', path: string}
 *   | {type: 'update', path: string, movePath: string|undefined, chunks: Chunk[]}} Hunk
 * @typedef {{hunks: Hunk[]} | {error: string}} Parsed
 */

/**
 * A patch wrapped as a shell heredoc — `cat <<'EOF'` … `EOF` — unwrapped, as
 * models sometimes send it and the tool accepts it.
 *
 * @param {string} input
 * @returns {string}
 */
const stripHeredoc = (input) => input.match(/^(?:cat\s+)?<<(['"]?)(\w+)\1\s*\n([\s\S]*?)\n\2\s*$/)?.[3] ?? input;

/**
 * Whether a line starts the next hunk or ends the patch.
 *
 * @param {string} line
 * @returns {boolean}
 */
function isBoundary(line) {
  return line === END || line.startsWith(ADD) || line.startsWith(DELETE) || line.startsWith(UPDATE);
}

/**
 * Read a patch's text into its hunks, or say why the tool would not.
 *
 * @param {string} patchText
 * @returns {Parsed}
 */
export function parse(patchText) {
  const lines = stripHeredoc(patchText.trim())
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  const begin = lines[0]?.trim() === BEGIN ? 0 : -1;
  const end = lines.at(-1)?.trim() === END ? lines.length - 1 : -1;
  if (begin === -1) return { error: `The first line of the patch must be '${BEGIN}'` };
  if (end === -1 || begin >= end) return { error: `The last line of the patch must be '${END}'` };

  const hunks = [];
  let index = begin + 1;
  while (index < end) {
    const header = lines[index].trim();

    if (index === begin + 1 && header.startsWith(ENVIRONMENT) && header.slice(ENVIRONMENT.length).trim()) {
      index++;
      continue;
    }

    if (header.startsWith(ADD)) {
      const path = header.slice(ADD.length).trim();
      const parsed = parseAdd(lines, index + 1, end, path);
      if ('error' in parsed) return parsed;
      hunks.push({ type: 'add', path, contents: parsed.content });
      index = parsed.next;
      continue;
    }

    if (header.startsWith(DELETE)) {
      const path = header.slice(DELETE.length).trim();
      const next = lines[index + 1]?.trim();
      if (index + 1 < end && next !== undefined && !isBoundary(next)) {
        return { error: `Invalid hunk at line ${index + 2}: unexpected line after Delete File '${path}': '${next}'` };
      }
      hunks.push({ type: 'delete', path });
      index++;
      continue;
    }

    if (header.startsWith(UPDATE)) {
      const path = header.slice(UPDATE.length).trim();
      let next = index + 1;
      let movePath;
      while (lines[next]?.trimEnd() === END_OF_FILE) next++;
      // Unlike a hunk header, the line naming a move is not trimmed at its
      // start: indented, it is a context line of the first chunk.
      const move = lines[next]?.trimEnd();
      if (move === MOVE.trimEnd() || move?.startsWith(MOVE)) {
        movePath = move.slice(MOVE.length).trim();
        if (!movePath) return { error: `Invalid hunk at line ${next + 1}: move destination for '${path}' must not be empty` };
        next++;
      }
      const parsed = parseUpdate(lines, next, end, path, index);
      if ('error' in parsed) return parsed;
      hunks.push({ type: 'update', path, movePath, chunks: parsed.chunks });
      index = parsed.next;
      continue;
    }

    return { error: `Invalid hunk at line ${index + 1}: '${header}' is not a valid hunk header` };
  }
  return { hunks };
}

/**
 * The body of an added file: lines that each start with `+`.
 *
 * @param {string[]} lines
 * @param {number} start
 * @param {number} end
 * @param {string} path
 * @returns {{content: string, next: number} | {error: string}}
 */
function parseAdd(lines, start, end, path) {
  const content = [];
  let index = start;
  while (index < end && !isBoundary(lines[index].trim())) {
    if (!lines[index].startsWith('+')) {
      return { error: `Invalid hunk at line ${index + 1}: invalid Add File line for '${path}': '${lines[index].trim()}'` };
    }
    content.push(lines[index].slice(1));
    index++;
  }
  return { content: content.join('\n'), next: index };
}

/**
 * The chunks of an updated file: `@@` markers, and lines of context (` `),
 * removal (`-`) and addition (`+`), each chunk optionally closed by
 * `*** End of File`.
 *
 * @param {string[]} lines
 * @param {number} start
 * @param {number} end
 * @param {string} path
 * @param {number} hunk  the index of the hunk's header line
 * @returns {{chunks: Chunk[], next: number} | {error: string}}
 */
function parseUpdate(lines, start, end, path, hunk) {
  const chunks = [];
  const invalid = (index, why) => ({ error: `Invalid hunk at line ${index + 1}: ${why}` });
  let index = start;
  let afterEndOfFile = false;
  while (index < end) {
    const line = lines[index];
    const updateLine = line.trimEnd();

    if (afterEndOfFile) {
      if (updateLine === '') {
        index++;
        continue;
      }
      if (updateLine === '@@' || updateLine.startsWith('@@ ')) afterEndOfFile = false;
      else if (isBoundary(updateLine)) break;
      else return invalid(index, `expected update hunk to start with a @@ context marker, got: '${line}'`);
    }

    if (updateLine === END_OF_FILE) {
      const chunk = chunks.at(-1);
      if (chunk && chunk.oldLines.length === 0 && chunk.newLines.length === 0) return invalid(index, 'update hunk does not contain any lines');
      if (chunk) {
        chunk.endOfFile = true;
        afterEndOfFile = true;
      }
      index++;
      continue;
    }

    if (isBoundary(updateLine)) break;

    if (updateLine === '@@' || updateLine.startsWith('@@ ')) {
      const previous = chunks.at(-1);
      if (previous && previous.oldLines.length === 0 && previous.newLines.length === 0) {
        return invalid(index, `unexpected line found in update hunk: '${line}'`);
      }
      chunks.push({ oldLines: [], newLines: [], changeContext: updateLine === '@@' ? undefined : updateLine.slice('@@ '.length) });
      index++;
      continue;
    }

    if (chunks.length === 0) chunks.push({ oldLines: [], newLines: [] });
    const chunk = chunks.at(-1);
    if (line === '') {
      chunk.oldLines.push('');
      chunk.newLines.push('');
    } else if (line.startsWith(' ')) {
      chunk.oldLines.push(line.slice(1));
      chunk.newLines.push(line.slice(1));
    } else if (line.startsWith('-')) {
      chunk.oldLines.push(line.slice(1));
    } else if (line.startsWith('+')) {
      chunk.newLines.push(line.slice(1));
    } else {
      return invalid(index, `unexpected line found in update hunk: '${line}'`);
    }
    index++;
  }

  if (chunks.length === 0) return invalid(hunk, `update file hunk for path '${path}' is empty`);
  const last = chunks.at(-1);
  if (last.oldLines.length === 0 && last.newLines.length === 0) return invalid(index, 'update hunk does not contain any lines');
  return { chunks, next: index };
}

/**
 * Every file a patch changes, as the patch names it, in the order it names
 * them: an added file, an updated one, a deleted one, and both ends of a move
 * — the file that goes away as much as the one that appears.
 *
 * `created` tells a file the patch brings into being (added, or the target of
 * a move) from one that already has to exist.
 *
 * @param {Hunk[]} hunks
 * @returns {{path: string, created: boolean}[]}
 */
export function touched(hunks) {
  return hunks.flatMap((hunk) => {
    if (hunk.type === 'add') return [{ path: hunk.path, created: true }];
    if (hunk.type === 'update' && hunk.movePath) {
      return [
        { path: hunk.path, created: false },
        { path: hunk.movePath, created: true },
      ];
    }
    return [{ path: hunk.path, created: false }];
  });
}
