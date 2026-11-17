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

// Tests for lib/transcripts.js: Claude Code's transcripts read into calls.
//
// TODO(T7.2): goes with the module, once lib/planning.js reads Open Code.
//
// Nothing here reads ~/.claude: the files are written to a temporary directory.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scan, slugOf } from '../lib/transcripts.js';

describe('reading transcripts', () => {
  let dir;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pdkit-transcripts-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('the project directory name replaces every non-alphanumeric character', () => {
    assert.equal(
      slugOf('/Users/Vlad/Workspace/RedHat/git/vzhukovs/podman-desktop'),
      '-Users-Vlad-Workspace-RedHat-git-vzhukovs-podman-desktop',
    );
  });

  test('one response written as several lines is one call, and subagents are read from their own files', async () => {
    const usage = { input_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 2 };
    const line = (id, block, extra = {}) =>
      JSON.stringify({
        timestamp: '2026-08-26T10:00:00.000Z',
        sessionId: 's1',
        message: { id, model: 'claude-opus-5', role: 'assistant', usage, content: [{ type: block }] },
        ...extra,
      });

    await writeFile(
      join(dir, 's1.jsonl'),
      [
        line('msg_1', 'thinking'),
        line('msg_1', 'text'),
        line('msg_1', 'tool_use'),
        'not json',
        JSON.stringify({ timestamp: '2026-08-26T10:01:00.000Z', isCompactSummary: true, sessionId: 's1' }),
        line('msg_2', 'text'),
        '',
      ].join('\n'),
    );
    await mkdir(join(dir, 's1', 'subagents'), { recursive: true });
    await writeFile(join(dir, 's1', 'subagents', 'agent-abc.jsonl'), `${line('msg_3', 'text', { isSidechain: true })}\n`);

    const scanned = await scan([dir]);
    assert.equal(scanned.calls.length, 3);
    assert.equal(scanned.duplicateLines, 2);
    assert.equal(scanned.unreadableLines, 1);
    assert.equal(scanned.compactions.length, 1);
    assert.equal(scanned.subagentFiles, 1);
    assert.deepEqual(scanned.calls.map((entry) => entry.agent).sort(), ['abc', null, null]);
  });
});
