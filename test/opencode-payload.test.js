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

import { hostPath, postBash, postClaim, postRead, postWrite, preBash, preWrite } from '../opencode/bridge/payload.js';

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

// post-bash reads the command and what it printed (post-bash.js), so its
// payload carries both — for a command that the shell tool ran and that exited
// 0, which is what Claude Code ran PostToolUse on. The result is shaped as the
// shell tool reports it to execute.after (F264).
describe('post-bash', () => {
  const host = { directory: DIRECTORY };
  /** What the shell tool reports for a command that ran in the foreground and exited `exitCode`. */
  const shellResult = (output, exitCode) => ({
    output: { output, exitCode, wallTimeSeconds: 0.02 },
    content: [{ type: 'text', text: output }, ...(exitCode === 0 ? [] : [{ type: 'text', text: `Exit code: ${exitCode}` }])],
    metadata: { status: 'completed', truncated: false, exit: exitCode },
  });
  /** A block left open, as a command that exited 0 printed it. */
  const OPEN = shellResult('namespace env {\n', 0);
  /** execute.after's event for a call that ran. */
  const done = (input, { result = OPEN, tool = 'shell', status = 'completed' } = {}) => ({ ...call(input, tool), status, result });

  test("is Claude Code's PostToolUse on Bash, with the command, what it printed, the directory and the session", () => {
    assert.deepEqual(postBash(done({ command: 'sed -n 1,40p api.d.ts' }), host), [
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'sed -n 1,40p api.d.ts' },
        tool_response: { stdout: 'namespace env {\n' },
        cwd: DIRECTORY,
        session_id: 'ses_test',
      },
    ]);
  });

  test('names no transcript', () => {
    assert.equal('transcript_path' in postBash(done({ command: 'head -5 a' }), host)[0], false);
  });

  // The shell tool's one stream is stdout and stderr together, as Claude
  // Code's Bash stdout was; post-bash counts the braces of all of it.
  test("what it printed is the shell tool's output, stderr in it, and not the result's text parts", () => {
    const result = shellResult('OUT {\nERR {\n', 0);
    result.content = [...result.content, { type: 'text', text: '} added by someone else' }];
    assert.equal(postBash(done({ command: 'head -5 a' }, { result }), host)[0].tool_response.stdout, 'OUT {\nERR {\n');
  });

  // What the shell tool cut itself, before the hook, is what the model read (F34).
  test('a long output is as the shell tool cut it, with its note', () => {
    const cut = '501 {\n502 {\n\n[showing lines 501-502 of 502; full output saved to /tmp/sh_x.out]';
    const result = { ...shellResult(cut, 0), metadata: { status: 'completed', truncated: true, exit: 0 } };
    result.output.outputPath = '/tmp/sh_x.out';
    assert.equal(postBash(done({ command: 'head -502 a' }, { result }), host)[0].tool_response.stdout, cut);
  });

  test("the shell tool's workdir is where the command ran, as pre-bash takes it", () => {
    const elsewhere = join(tmpdir(), 'elsewhere');
    assert.equal(postBash(done({ command: 'head -5 a', workdir: elsewhere }), host)[0].cwd, elsewhere);
    assert.equal(postBash(done({ command: 'head -5 a', workdir: 'packages/main' }), host)[0].cwd, resolve(DIRECTORY, 'packages/main'));
    assert.equal(postBash(done({ command: 'head -5 a', workdir: 7 }), host)[0].cwd, DIRECTORY);
    assert.equal(postBash(done({ command: 'head -5 a', workdir: 'relative' }), { directory: undefined })[0].cwd, undefined);
  });

  // Claude Code ran PostToolUse when a tool succeeded; a Bash command that
  // exited otherwise was a failure, PostToolUseFailure, which pdkit never
  // registered. Open Code calls it completed, with the code (F264).
  test('only a command that exited 0', () => {
    for (const exitCode of [1, 2, 127, -1, '0', null, undefined]) {
      assert.deepEqual(postBash(done({ command: 'sed -n 1,40p a' }, { result: shellResult('namespace env {\n', exitCode) }), host), [], String(exitCode));
    }
  });

  // A command moved to the background has no exit code yet (F264).
  test('not a command moved to the background', () => {
    const result = {
      output: { output: 'Command moved to the background (shell ID: sh_x).', exitCode: null, wallTimeSeconds: 0.001, shellID: 'sh_x', pid: 1 },
      content: [{ type: 'text', text: 'Command moved to the background (shell ID: sh_x).' }],
      metadata: { status: 'running', truncated: false, shellID: 'sh_x', pid: 1 },
    };
    assert.deepEqual(postBash(done({ command: 'tail -40 a.ts', background: true }, { result }), host), []);
  });

  test('only after a call that succeeded', () => {
    for (const status of ['error', 'running']) {
      assert.deepEqual(postBash(done({ command: 'head -5 a' }, { status }), host), [], status);
    }
    const { status: _, ...noStatus } = done({ command: 'head -5 a' });
    assert.deepEqual(postBash(noStatus, host), []);
  });

  // Unlike the gate (§13 DV5): the matcher was Bash, and post-bash guards nothing.
  test('only the shell tool, whatever else carries a command', () => {
    for (const tool of ['terminal_run', 'bash', 'read', 'grep', 'write']) {
      assert.deepEqual(postBash(done({ command: 'head -5 a' }, { tool }), host), [], tool);
    }
    const { tool: _, ...noTool } = done({ command: 'head -5 a' });
    assert.deepEqual(postBash(noTool, host), []);
    assert.deepEqual(postBash(undefined, host), []);
  });

  test('no command, or a result with no output of the shell tool, is no payload', () => {
    for (const input of [undefined, null, {}, { command: '' }, { command: 7 }]) {
      assert.deepEqual(postBash(done(input), host), [], JSON.stringify(input));
    }
    for (const result of [null, {}, { content: [{ type: 'text', text: 'x {' }] }, { output: 'x {' }, { output: null }, { output: { output: 7, exitCode: 0 } }]) {
      assert.deepEqual(postBash(done({ command: 'head -5 a' }, { result }), host), [], JSON.stringify(result));
    }
    const { result: _, ...noResult } = done({ command: 'head -5 a' });
    assert.deepEqual(postBash(noResult, host), []);
  });
});

describe('post-read', () => {
  /** A host whose files have the line counts given, and which says which it was asked about. */
  const hostWith = (counts = {}) => {
    const asked = [];
    return {
      asked,
      host: {
        directory: DIRECTORY,
        home: '/home/someone',
        lines: async (file) => {
          asked.push(file);
          if (!Object.hasOwn(counts, file)) throw new Error(`ENOENT: no such file or directory, open '${file}'`);
          return counts[file];
        },
      },
    };
  };
  const API = join(DIRECTORY, 'api.d.ts');
  const { host } = hostWith({ [API]: 4700 });

  /** A page of a text file, as the read tool reports one (F48). */
  const page = (content, offset, truncated, next) => ({ type: 'text-page', content, mime: 'video/mp2t', offset, truncated, ...(next === undefined ? {} : { next }) });
  /** execute.after's event for a read that ran, with the page as its output. */
  const read = (input, output, { status = 'completed', tool = 'read' } = {}) => ({
    ...call(input, tool),
    status,
    result: { output, content: [{ type: 'text', text: `Read file ${input?.path}` }], metadata: { truncated: output?.truncated ?? false } },
  });
  /** execute.after's event for a grep that ran: the matches, and whether the limit cut them. */
  const grep = (input, texts, truncated, { status = 'completed' } = {}) => ({
    ...call(input, 'grep'),
    status,
    result: {
      output: texts.map((text, i) => ({ entry: { path: 'api.d.ts', type: 'file' }, line: i + 1, offset: 0, text, submatches: [] })),
      content: [{ type: 'text', text: `Found ${texts.length} matches` }],
      metadata: { matches: texts.length, truncated },
    },
  });

  const CUT = 'export namespace env {\n  export const appName: string;';

  test("a page with lines after it is Claude Code's PostToolUse on Read: the file, its text, which lines out of how many", async () => {
    assert.deepEqual(await postRead(read({ path: 'api.d.ts', limit: 2 }, page(CUT, 1, true, 3)), host), [
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { file_path: API },
        tool_response: { type: 'text', file: { filePath: API, content: CUT, startLine: 1, numLines: 2, totalLines: 4700 } },
        cwd: DIRECTORY,
        session_id: 'ses_test',
      },
    ]);
  });

  test('names no transcript', async () => {
    assert.equal('transcript_path' in (await postRead(read({ path: 'api.d.ts', limit: 2 }, page(CUT, 1, true, 3)), host))[0], false);
  });

  // The read tool says how many lines a file has only of a page that reaches
  // the end: the last line of that page is the file's (F48).
  test('a page that reaches the end of the file counts its lines from the page, and reads nothing from disk', async () => {
    const counting = hostWith();
    const [payload] = await postRead(read({ path: 'api.d.ts', offset: 4699 }, page(`${CUT}\n}`, 4698, false)), counting.host);
    assert.deepEqual(payload.tool_response.file, { filePath: API, content: `${CUT}\n}`, startLine: 4698, numLines: 3, totalLines: 4700 });
    assert.deepEqual(counting.asked, []);
  });

  test('a page with lines after it counts them in the file the tool read, as the tool resolves its path', async () => {
    const sub = join(DIRECTORY, 'packages', 'main', 'a.ts');
    const home = join('/home/someone', 'a.ts');
    const counting = hostWith({ [sub]: 10, [home]: 20, [API]: 30 });
    for (const [path, file, total] of [
      ['packages/main/a.ts', sub, 10],
      ['~/a.ts', home, 20],
      [API, API, 30],
    ]) {
      const [payload] = await postRead(read({ path, limit: 2 }, page(CUT, 1, true, 3)), counting.host);
      assert.equal(payload.tool_input.file_path, file, path);
      assert.equal(payload.tool_response.file.totalLines, total, path);
    }
    assert.deepEqual(counting.asked, [sub, home, API]);
  });

  test('the window is the page: one past the first line, or one with lines after it', async () => {
    for (const [label, output, window] of [
      ['the first lines of a long file', page(CUT, 1, true, 3), { startLine: 1, numLines: 2 }],
      ['lines inside it', page(CUT, 4500, true, 4502), { startLine: 4500, numLines: 2 }],
      ['its last lines', page(CUT, 4699, false), { startLine: 4699, numLines: 2 }],
      ['one line', page('export namespace env {', 4600, false), { startLine: 4600, numLines: 1 }],
    ]) {
      const [payload] = await postRead(read({ path: 'api.d.ts' }, output), hostWith({ [API]: 4700 }).host);
      const { startLine, numLines } = payload.tool_response.file;
      assert.deepEqual({ startLine, numLines }, window, label);
    }
  });

  // A file under 50 KB read with neither offset nor limit comes back whole,
  // however many lines it has (F48); so does a page from its first line to its
  // last. The model saw all of it.
  test('no window, no payload: a whole file, or a page of all of it', async () => {
    const whole = { type: 'file', uri: 'file:///x/api.d.ts', name: 'api.d.ts', content: CUT, encoding: 'utf8', mime: 'video/mp2t' };
    assert.deepEqual(await postRead(read({ path: 'api.d.ts' }, whole), host), []);
    assert.deepEqual(await postRead(read({ path: 'api.d.ts', offset: 1, limit: 2000 }, page(CUT, 1, false)), host), []);
  });

  test('nothing read, no payload: an empty page, a directory, an image', async () => {
    assert.deepEqual(await postRead(read({ path: 'empty.txt', offset: 5 }, page('', 1, false)), host), []);
    assert.deepEqual(await postRead(read({ path: 'a.txt', offset: 3 }, page('', 3, false)), host), []);
    const listing = { type: 'list-page', entries: [{ path: 'a.ts', type: 'file' }], truncated: true, next: 2 };
    assert.deepEqual(await postRead(read({ path: 'src', limit: 1 }, listing), host), []);
    const image = { type: 'file', uri: 'file:///x/a.png', name: 'a.png', content: 'iVBORw0K', encoding: 'base64', mime: 'image/png' };
    assert.deepEqual(await postRead(read({ path: 'a.png' }, image), host), []);
  });

  test('an output that is no page of the read tool is no payload', async () => {
    for (const output of [undefined, null, 'x {', {}, { type: 'text-page' }, page(7, 2, false), page(CUT, 0, true, 3), page(CUT, 1.5, true, 3), page(CUT, 2, 'yes')]) {
      assert.deepEqual(await postRead(read({ path: 'api.d.ts' }, output), host), [], JSON.stringify(output));
    }
  });

  // §13 DV9: the count is never made up. A file the bridge cannot count is a
  // failure of the bridge, which afterRuns turns into a line in the log.
  test('a file that cannot be counted, or has fewer lines than the page showed, is a failure, not a guess', async () => {
    await assert.rejects(postRead(read({ path: 'gone.ts', limit: 2 }, page(CUT, 1, true, 3)), host), /ENOENT/);
    await assert.rejects(postRead(read({ path: 'skill://pd:exec/SKILL.md', limit: 2 }, page(CUT, 1, true, 3)), host), /ENOENT/);
    const shorter = hostWith({ [API]: 2 }).host;
    await assert.rejects(postRead(read({ path: 'api.d.ts', limit: 2 }, page(CUT, 1, true, 3)), shorter), /has 2 lines now, and the read showed it had at least 3/);
    await assert.rejects(
      postRead(read({ path: 'api.d.ts', limit: 2 }, page(CUT, 1, true, 3)), { ...host, directory: undefined }),
      /cannot tell which file "api.d.ts" is: the session has no directory/,
    );
    // Its next line is the one the page names, or the one after its last.
    const exact = hostWith({ [API]: 3 }).host;
    assert.equal((await postRead(read({ path: 'api.d.ts', limit: 2 }, page(CUT, 1, true, 3)), exact))[0].tool_response.file.totalLines, 3);
    assert.equal((await postRead(read({ path: 'api.d.ts', limit: 2 }, page(CUT, 1, true)), exact))[0].tool_response.file.totalLines, 3);
  });

  // A page that reaches the end needs no count, so needs no file.
  test('a page that reaches the end needs no directory either', async () => {
    const [payload] = await postRead(read({ path: 'api.d.ts', offset: 4699 }, page(CUT, 4699, false)), { ...host, directory: undefined });
    assert.equal(payload.tool_input.file_path, 'api.d.ts');
    assert.equal(payload.cwd, undefined);
  });

  test("matches the limit cut short are Claude Code's PostToolUse on Grep, in content mode, with the limit it applied", async () => {
    const texts = ['export namespace env {\n', 'export namespace process {\n'];
    assert.deepEqual(await postRead(grep({ pattern: 'export namespace', limit: 2 }, texts, true), host), [
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: 'export namespace' },
        tool_response: { mode: 'content', content: 'export namespace env {\nexport namespace process {\n', appliedLimit: 2 },
        cwd: DIRECTORY,
        session_id: 'ses_test',
      },
    ]);
  });

  // A search the tool cut returns exactly its limit of matches (F265), the
  // default one when the model named none.
  test('the limit applied is the number of matches a cut search returned', async () => {
    const hundred = Array.from({ length: 100 }, () => 'x {\n');
    assert.equal((await postRead(grep({ pattern: 'x' }, hundred, true), host))[0].tool_response.appliedLimit, 100);
  });

  test('the lines matched are what was read, not the paths and count around them in the result', async () => {
    const event = grep({ pattern: 'env' }, ['namespace env {\n'], true);
    event.result.content = [{ type: 'text', text: 'Found 1 matches\n/x/{weird}/api.d.ts:\n  Line 1: namespace env {\n' }];
    assert.equal((await postRead(event, host))[0].tool_response.content, 'namespace env {\n');
  });

  // Claude Code's other window, context around a match: the grep tool has
  // none, and Open Code strips the keys a model sends for it before any hook
  // (F51, F265). The bridge passes the pattern alone.
  test('every match, no payload; and no context is passed on, whatever the input holds', async () => {
    assert.deepEqual(await postRead(grep({ pattern: 'env' }, ['namespace env {\n'], false), host), []);
    assert.deepEqual(await postRead(grep({ pattern: 'env', '-A': 60, context: 5 }, ['namespace env {\n'], false), host), []);
    const [payload] = await postRead(grep({ pattern: 'env', '-A': 60 }, ['namespace env {\n'], true), host);
    assert.deepEqual(payload.tool_input, { pattern: 'env' });
  });

  test('a search with no pattern, or a result that is no list of matches, is no payload', async () => {
    for (const input of [{}, { pattern: '' }, { pattern: 7 }]) {
      assert.deepEqual(await postRead(grep(input, ['x {\n'], true), host), [], JSON.stringify(input));
    }
    const event = grep({ pattern: 'x' }, ['x {\n'], true);
    for (const output of [undefined, null, 'x {', { text: 'x {' }]) {
      assert.deepEqual(await postRead({ ...event, result: { ...event.result, output } }, host), [], JSON.stringify(output));
    }
    assert.deepEqual(await postRead({ ...event, result: { ...event.result, metadata: { matches: 1, truncated: 'yes' } } }, host), []);
    assert.deepEqual(await postRead({ ...event, result: { ...event.result, metadata: undefined } }, host), []);
    // A match that is no match counts for nothing.
    const odd = { ...event, result: { ...event.result, output: [{ text: 'x {\n' }, null, { text: 7 }] } };
    assert.equal((await postRead(odd, host))[0].tool_response.content, 'x {\n');
  });

  // A Read or a Grep that failed went to PostToolUseFailure, which pdkit never
  // registered; Open Code reports one with status "error" and no result (F265).
  test('only after a call that succeeded', async () => {
    for (const status of ['error', 'running']) {
      assert.deepEqual(await postRead(read({ path: 'api.d.ts', limit: 2 }, page(CUT, 1, true, 3), { status }), host), [], status);
      assert.deepEqual(await postRead(grep({ pattern: 'x' }, ['x {\n'], true, { status }), host), [], status);
    }
    const { status: _, ...noStatus } = read({ path: 'api.d.ts', limit: 2 }, page(CUT, 1, true, 3));
    assert.deepEqual(await postRead(noStatus, host), []);
    const { result: __, ...noResult } = read({ path: 'api.d.ts', limit: 2 }, page(CUT, 1, true, 3));
    assert.deepEqual(await postRead(noResult, host), []);
  });

  test('only the read and grep tools', async () => {
    for (const tool of ['shell', 'write', 'edit', 'patch', 'glob', 'webfetch', 'Read']) {
      assert.deepEqual(await postRead(read({ path: 'api.d.ts', limit: 2 }, page(CUT, 1, true, 3), { tool }), host), [], tool);
    }
    const { tool: _, ...noTool } = read({ path: 'api.d.ts', limit: 2 }, page(CUT, 1, true, 3));
    assert.deepEqual(await postRead(noTool, host), []);
    assert.deepEqual(await postRead(undefined, host), []);
  });

  test('a read with no path is no payload', async () => {
    for (const input of [undefined, null, {}, { path: '' }, { path: 7 }]) {
      assert.deepEqual(await postRead(read(input, page(CUT, 1, true, 3)), host), [], JSON.stringify(input));
    }
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
