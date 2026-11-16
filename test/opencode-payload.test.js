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
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { preBash } from '../opencode/bridge/payload.js';

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
