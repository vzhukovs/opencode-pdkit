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

// Tests for opencode/bridge/patch.js: the text of a patch call, read the way
// Open Code's patch tool reads it.
//
// Every expectation here is what Open Code 2.3.0's own parser gives for the
// same text: a file this reading missed would be written past pre-write, and
// one it invented would refuse an honest patch. Both directions are asserted —
// what is a file, what only looks like one, and what the tool gives up on
// (and then writes nothing).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parse, touched } from '../opencode/bridge/patch.js';

/** The files a patch text changes, or 'rejected'. */
function files(text) {
  const parsed = parse(text);
  return 'error' in parsed ? 'rejected' : touched(parsed.hunks);
}

const added = (path) => ({ path, created: true });
const changed = (path) => ({ path, created: false });

/** Lines into a patch text. */
const patch = (...lines) => lines.join('\n');

describe('the files a patch changes', () => {
  // As a model sent it in a live session: one call, two files.
  test('an added file and an updated one', () => {
    const text = patch('*** Begin Patch', '*** Add File: notes/added.txt', '+added by patch', '+second line', '*** Update File: notes/update.txt', '@@', ' first', '-old middle', '+new middle', ' last', '*** End Patch', '');

    assert.deepEqual(files(text), [added('notes/added.txt'), changed('notes/update.txt')]);
    assert.deepEqual(parse(text).hunks, [
      { type: 'add', path: 'notes/added.txt', contents: 'added by patch\nsecond line' },
      {
        type: 'update',
        path: 'notes/update.txt',
        movePath: undefined,
        chunks: [{ oldLines: ['first', 'old middle', 'last'], newLines: ['first', 'new middle', 'last'], changeContext: undefined }],
      },
    ]);
  });

  // A move takes a file away from one place and puts it in another: both are
  // files the patch changes.
  test('a moved file at both ends, a deleted file, and a path given whole', () => {
    const text = patch(
      '*** Begin Patch',
      '*** Update File: notes/move.txt',
      '*** Move to: notes/moved/there.txt',
      '@@',
      '-moving line',
      '+moved line',
      '*** Delete File: notes/delete.txt',
      '*** Add File: /work/project/notes/abs.txt',
      '+absolute add',
      '*** End Patch',
    );

    assert.deepEqual(files(text), [changed('notes/move.txt'), added('notes/moved/there.txt'), changed('notes/delete.txt'), added('/work/project/notes/abs.txt')]);
  });

  test('an added file with no lines', () => {
    assert.deepEqual(files(patch('*** Begin Patch', '*** Add File: empty.txt', '*** Delete File: gone.txt', '*** End Patch')), [added('empty.txt'), changed('gone.txt')]);
  });

  test('a patch of nothing changes nothing (the tool refuses it as empty)', () => {
    assert.deepEqual(files(patch('*** Begin Patch', '*** End Patch')), []);
  });

  test('chunks with a context marker, ended at the end of the file and resumed', () => {
    const text = patch('*** Begin Patch', '*** Update File: u.txt', '@@ function x()', '-a', '+b', '*** End of File', '', '@@', '-c', '+d', '*** End Patch');

    assert.deepEqual(files(text), [changed('u.txt')]);
    assert.deepEqual(
      parse(text).hunks[0].chunks.map((chunk) => chunk.changeContext),
      ['function x()', undefined],
    );
  });
});

// What the tool accepts besides the plain form, so this must too: a file in
// any of these would otherwise be written unchecked.
describe('the forms the tool accepts', () => {
  const plain = ['*** Begin Patch', '*** Delete File: d.txt', '*** Add File: a.txt', '+x', '*** End Patch'];

  for (const [label, text] of [
    ["a heredoc, as `cat <<'EOF'`", `cat <<'EOF'\n${patch(...plain)}\nEOF`],
    ['a heredoc, as `<<EOF`', `<<EOF\n${patch(...plain)}\nEOF`],
    ['a heredoc, as `<<"PATCH"`', `<<"PATCH"\n${patch(...plain)}\nPATCH`],
    ['Windows line endings', `${plain.join('\r\n')}\r\n`],
    ['blank lines and spaces around it', `\n\n  ${patch(...plain)}  \n\n`],
    ['spaces around each header and path', patch('  *** Begin Patch  ', '   *** Delete File:   d.txt   ', '\t*** Add File: a.txt\t', '+x', '  *** End Patch  ')],
    ['an environment line first', patch('*** Begin Patch', '*** Environment ID: env-1', ...plain.slice(1))],
  ]) {
    test(label, () => {
      assert.deepEqual(files(text), [changed('d.txt'), added('a.txt')]);
    });
  }

  test('a move named after an end-of-file marker', () => {
    const text = patch('*** Begin Patch', '*** Update File: u.txt', '*** End of File', '*** Move to: m.txt', '-a', '+b', '*** End Patch');
    assert.deepEqual(files(text), [changed('u.txt'), added('m.txt')]);
  });
});

// Lines the tool reads as content. Taking them for files would refuse a patch
// to, say, a document about the patch format.
describe('what only looks like a file', () => {
  test('a context line shaped like a header', () => {
    const text = patch('*** Begin Patch', '*** Update File: docs/format.md', '@@', ' *** Add File: not-a-file.txt', '-old', '+new', '*** End Patch');
    assert.deepEqual(files(text), [changed('docs/format.md')]);
  });

  test('an added line shaped like a header', () => {
    const text = patch('*** Begin Patch', '*** Add File: docs/format.md', '+*** Delete File: not-a-file.txt', '*** End Patch');
    assert.deepEqual(files(text), [added('docs/format.md')]);
  });

  // The tool takes a move only from a line that starts at the margin.
  test('an indented move is a line of context', () => {
    const text = patch('*** Begin Patch', '*** Update File: u.txt', ' *** Move to: m.txt', '-a', '+b', '*** End Patch');
    assert.deepEqual(files(text), [changed('u.txt')]);
  });
});

// The tool refuses these before it writes anything, so they change no file.
describe('what the tool gives up on', () => {
  for (const [label, text] of [
    ['no text', ''],
    ['no first line', patch('*** Add File: a.txt', '+x', '*** End Patch')],
    ['no last line', patch('*** Begin Patch', '*** Add File: a.txt', '+x')],
    ['only the first line', '*** Begin Patch'],
    ['a heredoc that does not close', `cat <<'EOF'\n${patch('*** Begin Patch', '*** Add File: a.txt', '+x', '*** End Patch')}\nEND`],
    ['a header the format does not have', patch('*** Begin Patch', '*** Rename File: a.txt', '*** End Patch')],
    ['a deleted file with a body', patch('*** Begin Patch', '*** Delete File: d.txt', '-x', '*** End Patch')],
    ['a move to nowhere', patch('*** Begin Patch', '*** Update File: u.txt', '*** Move to:', '-a', '*** End Patch')],
    ['an update with no lines', patch('*** Begin Patch', '*** Update File: u.txt', '*** End Patch')],
    ['an added line without its +', patch('*** Begin Patch', '*** Add File: a.txt', 'x', '*** End Patch')],
    ['an update line without its prefix', patch('*** Begin Patch', '*** Update File: u.txt', '@@', 'x', '*** End Patch')],
    ['an environment line with no value', patch('*** Begin Patch', '*** Environment ID:', '*** Add File: a.txt', '+x', '*** End Patch')],
    ['an environment line that is not first', patch('*** Begin Patch', '*** Environment ID: one', '*** Environment ID: two', '*** Add File: a.txt', '+x', '*** End Patch')],
  ]) {
    test(label, () => {
      assert.equal(files(text), 'rejected');
      assert.equal(typeof parse(text).error, 'string');
    });
  }
});

test('touched lists every file in the order the patch names it, a file named twice twice', () => {
  const text = patch('*** Begin Patch', '*** Add File: b.txt', '+x', '*** Update File: a.txt', '*** Move to: b.txt', '-a', '+b', '*** Delete File: a.txt', '*** End Patch');
  assert.deepEqual(files(text), [added('b.txt'), changed('a.txt'), added('b.txt'), changed('a.txt')]);
});
