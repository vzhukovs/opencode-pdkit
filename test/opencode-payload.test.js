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

import { hostPath, postClaim, postWrite, preBash, preWrite } from '../opencode/bridge/payload.js';

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

describe('post-write', () => {
  const HOME = join(tmpdir(), 'home');
  const host = { directory: DIRECTORY, home: HOME };
  /** execute.after's event for a call that ran. */
  const done = (input, tool, status = 'completed') => ({ ...call(input, tool), status, result: { content: [{ type: 'text', text: 'ok' }] } });
  const patch = (...lines) => done({ patchText: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') }, 'patch');

  /** The payload for one file. */
  const payload = (file, tool_name = 'Write') => ({
    hook_event_name: 'PostToolUse',
    tool_name,
    tool_input: { file_path: file },
    cwd: DIRECTORY,
    session_id: 'ses_test',
  });

  test("write is Claude Code's PostToolUse on Write, with the file whole, the directory and the session", () => {
    assert.deepEqual(postWrite(done({ path: 'src/a.ts', content: 'x' }, 'write'), host), [payload(join(DIRECTORY, 'src/a.ts'))]);
  });

  test('edit is Edit', () => {
    assert.deepEqual(postWrite(done({ path: 'src/a.ts', oldString: 'a', newString: 'b' }, 'edit'), host), [payload(join(DIRECTORY, 'src/a.ts'), 'Edit')]);
  });

  // post-write reads the file from disk; the result has none of its text (F43).
  test('carries no tool_response and no transcript', () => {
    const [one] = postWrite(done({ path: 'a.ts', content: 'x' }, 'write'), host);
    assert.equal('tool_response' in one, false);
    assert.equal('transcript_path' in one, false);
  });

  test('the file is the one the tool wrote, as pre-write takes it', () => {
    assert.equal(postWrite(done({ path: '~/a.ts', content: '' }, 'write'), host)[0].tool_input.file_path, join(HOME, 'a.ts'));
    assert.equal(postWrite(done({ path: '../b.ts', content: '' }, 'write'), host)[0].tool_input.file_path, resolve(DIRECTORY, '../b.ts'));
  });

  // Claude Code ran PostToolUse only after a tool had done its work; a failed
  // call went to PostToolUseFailure, which pdkit did not register.
  test('only after a call that succeeded', () => {
    for (const status of ['error', 'running']) {
      assert.deepEqual(postWrite(done({ path: 'a.ts', content: 'x' }, 'write', status), host), [], status);
    }
    const { status: _, ...noStatus } = done({ path: 'a.ts', content: 'x' }, 'write');
    assert.deepEqual(postWrite(noStatus, host), []);
  });

  test('any other tool, or an input that names no file, is no payload', () => {
    for (const tool of ['shell', 'read', 'grep', 'experimental_image_generate', undefined]) {
      assert.deepEqual(postWrite(done({ path: 'a.ts', content: 'x' }, tool), host), [], String(tool));
    }
    for (const input of [undefined, {}, { path: '' }, { path: 7 }]) {
      assert.deepEqual(postWrite(done(input, 'write'), host), [], JSON.stringify(input));
    }
    assert.deepEqual(postWrite(undefined, host), []);
  });

  describe('patch', () => {
    test('a payload for every file it left: added and moved-to as Write, updated as Edit; not a deleted one, nor where one moved from', () => {
      const event = patch(
        '*** Add File: notes/added.ts',
        '+x',
        '*** Update File: notes/update.ts',
        '@@',
        '-a',
        '+b',
        '*** Update File: notes/move.ts',
        '*** Move to: ~/moved.ts',
        '-c',
        '+d',
        '*** Delete File: /work/gone.ts',
      );

      assert.deepEqual(postWrite(event, host), [
        payload(join(DIRECTORY, 'notes/added.ts'), 'Write'),
        payload(join(DIRECTORY, 'notes/update.ts'), 'Edit'),
        payload(join(HOME, 'moved.ts'), 'Write'),
      ]);
    });

    test('a file named twice is looked at once', () => {
      const event = patch('*** Update File: a.ts', '@@', '-a', '+b', '*** Update File: ./a.ts', '@@', '-c', '+d');
      assert.deepEqual(postWrite(event, host), [payload(join(DIRECTORY, 'a.ts'), 'Edit')]);
    });

    test('a patch that only deletes leaves nothing to look at', () => {
      assert.deepEqual(postWrite(patch('*** Delete File: a.ts'), host), []);
    });

    test('a patch the tool cannot read is no payload', () => {
      assert.deepEqual(postWrite(patch('*** Delete File: a.ts', '-body'), host), []);
    });
  });
});

// post-claim reads the text a call wrote — a Write's content, an Edit's
// new_string (post-claim.js) — so its payload carries that text, and only for
// markdown, which is all post-claim reads.
describe('post-claim', () => {
  const HOME = join(tmpdir(), 'home');
  const host = { directory: DIRECTORY, home: HOME };
  /** execute.after's event for a call that ran. */
  const done = (input, tool, status = 'completed') => ({ ...call(input, tool), status, result: { content: [{ type: 'text', text: 'ok' }] } });
  const patch = (...lines) => done({ patchText: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') }, 'patch');

  /** The payload for one file, with the text written in it. */
  const wrote = (file, content) => ({
    hook_event_name: 'PostToolUse',
    tool_name: 'Write',
    tool_input: { file_path: file, content },
    cwd: DIRECTORY,
    session_id: 'ses_test',
  });
  const edited = (file, new_string) => ({ ...wrote(file), tool_name: 'Edit', tool_input: { file_path: file, new_string } });

  test("write is Claude Code's PostToolUse on Write, with the file whole, the text it wrote, the directory and the session", () => {
    assert.deepEqual(postClaim(done({ path: 'docs/a.md', content: 'Add `env.uriScheme`.' }, 'write'), host), [wrote(join(DIRECTORY, 'docs/a.md'), 'Add `env.uriScheme`.')]);
  });

  // newString is Edit's new_string (F38); the text it replaces is not written.
  test('edit is Edit, with its new text and not the old', () => {
    assert.deepEqual(postClaim(done({ path: 'a.md', oldString: 'old `x.y`', newString: 'new `a.b`', replaceAll: true }, 'edit'), host), [edited(join(DIRECTORY, 'a.md'), 'new `a.b`')]);
  });

  test('carries no tool_response and no transcript', () => {
    const [one] = postClaim(done({ path: 'a.md', content: 'x' }, 'write'), host);
    assert.equal('tool_response' in one, false);
    assert.equal('transcript_path' in one, false);
  });

  // post-claim leaves the file it is given out of its search, and takes a
  // relative one from the repository's root, not from cwd (T1.4).
  test('the file is the one the tool wrote, whole, as pre-write takes it', () => {
    assert.equal(postClaim(done({ path: '~/a.md', content: '' }, 'write'), host)[0].tool_input.file_path, join(HOME, 'a.md'));
    assert.equal(postClaim(done({ path: '../b.md', content: '' }, 'write'), host)[0].tool_input.file_path, resolve(DIRECTORY, '../b.md'));
  });

  test('only markdown: a file of any other kind is no payload, as post-claim reads none', () => {
    for (const path of ['a.ts', 'a.mdx', 'a.MD', 'a.md.bak', 'README', 'docs.md/a.txt']) {
      assert.deepEqual(postClaim(done({ path, content: 'Add `env.uriScheme`.' }, 'write'), host), [], path);
    }
  });

  test('a text that is not a string is no text', () => {
    assert.deepEqual(postClaim(done({ path: 'a.md' }, 'write'), host), [wrote(join(DIRECTORY, 'a.md'), '')]);
    assert.deepEqual(postClaim(done({ path: 'a.md', oldString: 'a', newString: 7 }, 'edit'), host), [edited(join(DIRECTORY, 'a.md'), '')]);
  });

  test('only after a call that succeeded', () => {
    for (const status of ['error', 'running']) {
      assert.deepEqual(postClaim(done({ path: 'a.md', content: 'x' }, 'write', status), host), [], status);
    }
    const { status: _, ...noStatus } = done({ path: 'a.md', content: 'x' }, 'write');
    assert.deepEqual(postClaim(noStatus, host), []);
  });

  test('any other tool, or an input that names no file, is no payload', () => {
    for (const tool of ['shell', 'read', 'grep', 'experimental_image_generate', undefined]) {
      assert.deepEqual(postClaim(done({ path: 'a.md', content: 'x' }, tool), host), [], String(tool));
    }
    for (const input of [undefined, {}, { path: '', content: 'x' }, { path: 7, content: 'x' }]) {
      assert.deepEqual(postClaim(done(input, 'write'), host), [], JSON.stringify(input));
    }
    assert.deepEqual(postClaim(undefined, host), []);
  });

  describe('patch', () => {
    test('an added file is Write with its contents; an updated one is Edit with the lines it adds, not its context or what it removes', () => {
      const event = patch(
        '*** Add File: docs/added.md',
        '+# Added',
        '+Add `env.uriScheme`.',
        '*** Update File: docs/update.md',
        '@@ ## Section',
        ' There is no `context.line` here.',
        '-There is no `removed.line` here.',
        '+There is no `added.line` here.',
        '@@',
        '+A second chunk.',
      );

      assert.deepEqual(postClaim(event, host), [
        wrote(join(DIRECTORY, 'docs/added.md'), '# Added\nAdd `env.uriScheme`.'),
        edited(join(DIRECTORY, 'docs/update.md'), 'There is no `added.line` here.\nA second chunk.'),
      ]);
    });

    test('a file it moved is where it went, with the lines it adds; one it deleted writes nothing', () => {
      const event = patch('*** Update File: docs/move.md', '*** Move to: ~/moved.md', '@@', '-a', '+b', '*** Delete File: /work/gone.md');
      assert.deepEqual(postClaim(event, host), [edited(join(HOME, 'moved.md'), 'b')]);
    });

    test('markdown only, whatever else the patch writes', () => {
      const event = patch('*** Add File: a.ts', '+x', '*** Update File: b.md', '@@', '+y', '*** Add File: c.txt', '+z');
      assert.deepEqual(postClaim(event, host), [edited(join(DIRECTORY, 'b.md'), 'y')]);
    });

    test('a file named twice is one payload, with what each hunk wrote, in order', () => {
      const event = patch('*** Update File: a.md', '@@', '-a', '+first', '*** Update File: ./a.md', '@@', '-c', '+second');
      assert.deepEqual(postClaim(event, host), [edited(join(DIRECTORY, 'a.md'), 'first\nsecond')]);
    });

    test('a patch that only removes writes no text, but still names the file', () => {
      assert.deepEqual(postClaim(patch('*** Update File: a.md', '@@', ' kept', '-gone'), host), [edited(join(DIRECTORY, 'a.md'), '')]);
    });

    test('a patch the tool cannot read is no payload', () => {
      assert.deepEqual(postClaim(patch('*** Delete File: a.md', '-body'), host), []);
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
