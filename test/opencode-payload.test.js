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

// Tests for opencode/bridge/payload.js: Open Code's events, as the Claude Code
// payloads pdkit's handlers read. The events are shaped as execute.before
// receives them (an input as the model wrote it); what is pinned is the field
// each handler reads, and the working directory, which a handler that is given
// none takes from the process — the server's, not the session's.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve, win32 } from 'node:path';
import { tmpdir } from 'node:os';

import { hostPath, preBash, preWrite } from '../opencode/bridge/payload.js';

const DIRECTORY = join(tmpdir(), 'project');

/** execute.before's event for a call. */
const call = (input, tool = 'shell') => ({ tool, sessionID: 'ses_test', agent: 'build', messageID: 'msg_test', id: 'call_test', input });

describe('pre-bash', () => {
  test("is Claude Code's PreToolUse on Bash, with the command, the directory and the session", () => {
    assert.deepEqual(preBash(call({ command: 'git push origin HEAD' }), DIRECTORY), {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git push origin HEAD' },
      cwd: DIRECTORY,
      session_id: 'ses_test',
    });
  });

  test('names no transcript: Open Code keeps none to point at', () => {
    assert.equal('transcript_path' in preBash(call({ command: 'x' }), DIRECTORY), false);
  });

  // dispatch.js lets through whatever is not named Bash; the entry point has
  // already chosen the calls the gate checks.
  test('is Bash whatever tool carried the command', () => {
    assert.equal(preBash(call({ command: 'git push' }, 'terminal_run'), DIRECTORY).tool_name, 'Bash');
  });

  test("the shell tool's workdir is where the command runs", () => {
    const elsewhere = join(tmpdir(), 'elsewhere');
    assert.equal(preBash(call({ command: 'git push', workdir: elsewhere }), DIRECTORY).cwd, elsewhere);
  });

  test("a relative workdir is taken from the session's directory, as the shell tool takes it", () => {
    assert.equal(preBash(call({ command: 'git push', workdir: 'packages/main' }), DIRECTORY).cwd, resolve(DIRECTORY, 'packages/main'));
    assert.equal(preBash(call({ command: 'git push', workdir: '..' }), DIRECTORY).cwd, resolve(DIRECTORY, '..'));
  });

  test('an empty or odd workdir is no workdir', () => {
    for (const workdir of ['', 7, null, ['/x']]) {
      assert.equal(preBash(call({ command: 'git push', workdir }), DIRECTORY).cwd, DIRECTORY, JSON.stringify(workdir));
    }
  });

  test("another tool's workdir is that tool's business", () => {
    assert.equal(preBash(call({ command: 'git push', workdir: '/somewhere' }, 'terminal_run'), DIRECTORY).cwd, DIRECTORY);
  });

  // The runner refuses a payload without a directory rather than run the gate
  // where the server happens to be.
  test('no directory from the session and none from the call is no directory', () => {
    for (const directory of [undefined, '']) {
      assert.equal(preBash(call({ command: 'git push' }), directory).cwd, undefined);
      assert.equal(preBash(call({ command: 'git push', workdir: 'relative' }), directory).cwd, undefined);
    }
    assert.equal(preBash(call({ command: 'git push', workdir: DIRECTORY }), undefined).cwd, DIRECTORY);
  });
});

describe('pre-write', () => {
  const HOME = join(tmpdir(), 'home');
  const host = { directory: DIRECTORY, home: HOME };
  const write = (input) => call(input, 'write');
  const patch = (...lines) => call({ patchText: lines.join('\n') }, 'patch');

  /** The payload for one file. */
  const payload = (file, tool_name = 'Write') => ({
    hook_event_name: 'PreToolUse',
    tool_name,
    tool_input: { file_path: file },
    cwd: DIRECTORY,
    session_id: 'ses_test',
  });

  test("write is Claude Code's PreToolUse on Write, with the file whole, the directory and the session", () => {
    assert.deepEqual(preWrite(write({ path: 'src/a.ts', content: 'x' }), host), [payload(join(DIRECTORY, 'src/a.ts'))]);
  });

  test('edit is Edit', () => {
    assert.deepEqual(preWrite(call({ path: 'src/a.ts', oldString: 'a', newString: 'b' }, 'edit'), host), [payload(join(DIRECTORY, 'src/a.ts'), 'Edit')]);
  });

  test('names no transcript', () => {
    assert.equal('transcript_path' in preWrite(write({ path: 'a', content: '' }), host)[0], false);
  });

  // owns.js takes a relative path from `cwd` and knows no `~`; the tool takes
  // both from the session, and that is the file it writes.
  describe('the file is the one the tool would write', () => {
    for (const [given, expected] of [
      ['src/a.ts', resolve(DIRECTORY, 'src/a.ts')],
      ['../elsewhere/a.ts', resolve(DIRECTORY, '../elsewhere/a.ts')],
      [join(tmpdir(), 'other', 'a.ts'), join(tmpdir(), 'other', 'a.ts')],
      [`${join(tmpdir(), 'other')}/../x/./a.ts`, join(tmpdir(), 'x', 'a.ts')],
      ['~', HOME],
      ['~/notes/a.md', join(HOME, 'notes/a.md')],
      ['~user/a.md', resolve(DIRECTORY, '~user/a.md')],
      ['./~/a.md', resolve(DIRECTORY, '~/a.md')],
    ]) {
      test(JSON.stringify(given), () => {
        assert.equal(preWrite(write({ path: given, content: '' }), host)[0].tool_input.file_path, expected);
      });
    }
  });

  test('with no directory from the session, a whole path is still a file, and a relative one is passed on as given', () => {
    for (const directory of [undefined, '']) {
      const absolute = join(tmpdir(), 'a.ts');
      assert.deepEqual(preWrite(write({ path: absolute, content: '' }), { directory, home: HOME }), [{ ...payload(absolute), cwd: undefined }]);
      // The runner refuses a payload without a directory; pre-write then fails
      // open and says why.
      assert.deepEqual(preWrite(write({ path: 'a.ts', content: '' }), { directory, home: HOME }), [{ ...payload('a.ts'), cwd: undefined }]);
    }
  });

  // The input is the model's, unchecked: Open Code applies the tool's schema
  // after this hook. What the tool would refuse names no file.
  test('an input that names no file is no payload', () => {
    for (const input of [undefined, null, 'a.ts', ['a.ts'], {}, { path: '' }, { path: 7 }, { path: ['a.ts'] }, { filePath: 'a.ts' }, { file_path: 'a.ts' }]) {
      assert.deepEqual(preWrite(write(input), host), [], JSON.stringify(input));
      assert.deepEqual(preWrite(call(input, 'edit'), host), [], JSON.stringify(input));
    }
    for (const input of [undefined, {}, { patchText: 7 }, { patchText: ['*** Begin Patch'] }, { path: 'a.ts' }]) {
      assert.deepEqual(preWrite(call(input, 'patch'), host), [], JSON.stringify(input));
    }
  });

  test('any other tool is no payload, whatever it carries', () => {
    for (const tool of ['shell', 'read', 'experimental_image_generate', 'worktree_remove', 'toString', undefined]) {
      assert.deepEqual(preWrite(call({ path: 'a.ts', content: 'x', patchText: '*** Begin Patch\n*** Delete File: a.ts\n*** End Patch' }, tool), host), [], String(tool));
    }
    assert.deepEqual(preWrite(undefined, host), []);
  });

  describe('patch', () => {
    // Decided with T4.6: every file the patch changes, a deleted one and the
    // file a move takes away included.
    test('a payload for every file it changes: added and moved-to as Write, updated, deleted and moved-from as Edit', () => {
      const event = patch(
        '*** Begin Patch',
        '*** Add File: notes/added.txt',
        '+x',
        '*** Update File: notes/update.txt',
        '@@',
        '-a',
        '+b',
        '*** Update File: notes/move.txt',
        '*** Move to: ~/moved.txt',
        '-c',
        '+d',
        '*** Delete File: /work/gone.txt',
        '*** End Patch',
      );

      assert.deepEqual(preWrite(event, host), [
        payload(join(DIRECTORY, 'notes/added.txt'), 'Write'),
        payload(join(DIRECTORY, 'notes/update.txt'), 'Edit'),
        payload(join(DIRECTORY, 'notes/move.txt'), 'Edit'),
        payload(join(HOME, 'moved.txt'), 'Write'),
        payload(resolve('/work/gone.txt'), 'Edit'),
      ]);
    });

    test('a file named twice is checked once, however it is spelled', () => {
      const event = patch('*** Begin Patch', '*** Add File: b.txt', '+x', '*** Update File: a.txt', '*** Move to: ./b.txt', '-a', '+b', `*** Delete File: ${join(DIRECTORY, 'a.txt')}`, '*** End Patch');

      assert.deepEqual(
        preWrite(event, host).map((one) => [one.tool_name, one.tool_input.file_path]),
        [
          ['Write', join(DIRECTORY, 'b.txt')],
          ['Edit', join(DIRECTORY, 'a.txt')],
        ],
      );
    });

    // The tool refuses it before writing anything (opencode-patch.test.js has
    // what it refuses).
    test('a patch the tool cannot read is no payload', () => {
      assert.deepEqual(preWrite(patch('*** Begin Patch', '*** Delete File: a.txt', '-body', '*** End Patch'), host), []);
      assert.deepEqual(preWrite(patch('*** Begin Patch', '*** End Patch'), host), []);
    });
  });
});

// Windows is Open Code's own rewrite of a shell's drive path, then Windows'
// path rules — computed here with path.win32 on any machine.
describe('hostPath on Windows', () => {
  const host = { home: 'C:\\Users\\someone', platform: 'win32' };
  const directory = 'C:\\work\\project';

  for (const [given, expected] of [
    ['src\\a.ts', 'C:\\work\\project\\src\\a.ts'],
    ['src/a.ts', 'C:\\work\\project\\src\\a.ts'],
    ['D:\\other\\a.ts', 'D:\\other\\a.ts'],
    ['/d/other/a.ts', 'D:\\other\\a.ts'],
    ['/D:/other/a.ts', 'D:\\other\\a.ts'],
    ['/cygdrive/e/a.ts', 'E:\\a.ts'],
    ['/mnt/f/x/a.ts', 'F:\\x\\a.ts'],
    ['~', 'C:\\Users\\someone'],
    ['~/a.ts', 'C:\\Users\\someone\\a.ts'],
    ['~\\a.ts', 'C:\\Users\\someone\\a.ts'],
  ]) {
    test(JSON.stringify(given), () => {
      assert.equal(hostPath(directory, given, host), expected);
      assert.ok(win32.isAbsolute(expected));
    });
  }

  // Elsewhere `~\` is a name like any other.
  test('`~\\` is the home directory only there', () => {
    assert.equal(hostPath('/work/project', '~\\a.ts', { home: '/home/someone', platform: 'linux' }), '/work/project/~\\a.ts');
    assert.equal(hostPath('/work/project', '/d/a.ts', { home: '/home/someone', platform: 'linux' }), '/d/a.ts');
  });
});
