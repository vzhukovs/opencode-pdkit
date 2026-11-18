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

// Tests for the one thing `pdkit init` works out for itself.
//
// The shipped config cannot name somebody else's fork, so it ships the key
// empty and init reads it from the remote. Asking for it on the command line
// would be asking the user to read out a value they are standing inside — but
// reading it means the two ways of getting it wrong have to be caught here,
// because both produce a plausible-looking slug: no remote to read, and a
// clone of upstream that was never forked at all. And what it does not do:
// write anything into the fork.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { adoptFork } from '../lib/cli.js';
import { familyOf, lastModelIn } from '../lib/session-model.js';

const exec = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'pdkit');

const CONFIG_TEXT = [
  'repo:',
  '  upstream: podman-desktop/podman-desktop',
  '  # a comment that has to survive',
  '  fork: ""',
  '  upstream_remote: upstream',
  '  fork_remote: origin',
].join('\n');

const REPO_CONFIG = { repo: { upstream: 'podman-desktop/podman-desktop', fork_remote: 'origin' } };

let dir;
let config;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pdkit-init-fork-'));
  config = join(dir, 'config.yaml');
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('reading the fork from the clone', () => {
  test('the slug is written in, and the comments survive', async () => {
    await writeFile(config, CONFIG_TEXT);

    const result = await adoptFork({ repo: { remotes: { origin: 'jdoe/podman-desktop' }, config: REPO_CONFIG }, config });

    assert.deepEqual(result, { ok: true, fork: 'jdoe/podman-desktop' });

    const written = await readFile(config, 'utf8');
    assert.match(written, /^ {2}fork: jdoe\/podman-desktop$/m);
    assert.match(written, /a comment that has to survive/, 'rewriting the line must not regenerate the file');
    assert.match(written, /^ {2}fork_remote: origin$/m, 'fork_remote is a different key and is left alone');
  });

  // Cloning upstream and calling it a fork points every push at the project
  // itself, and the gate would then be guarding a branch in somebody else's
  // repository. The one case where guessing is worse than refusing.
  test('a clone of upstream is refused rather than adopted', async () => {
    await writeFile(config, CONFIG_TEXT);

    const result = await adoptFork({
      repo: { remotes: { origin: 'podman-desktop/podman-desktop' }, config: REPO_CONFIG },
      config,
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /upstream repository rather than a fork/);
    assert.match(await readFile(config, 'utf8'), /^ {2}fork: ""$/m, 'nothing is written on refusal');
  });

  test('no remote to read is said plainly', async () => {
    await writeFile(config, CONFIG_TEXT);

    const result = await adoptFork({ repo: { remotes: { upstream: 'podman-desktop/podman-desktop' }, config: REPO_CONFIG }, config });

    assert.equal(result.ok, false);
    assert.match(result.error, /no "origin" remote/);
  });

  test('a config with no fork line is reported, not silently skipped', async () => {
    await writeFile(config, 'repo:\n  upstream: podman-desktop/podman-desktop\n');

    const result = await adoptFork({ repo: { remotes: { origin: 'jdoe/podman-desktop' }, config: REPO_CONFIG }, config });

    assert.equal(result.ok, false);
    assert.match(result.error, /no "fork:" line/);
  });
});

// What `pdkit init` leaves in the fork: nothing. Claude Code's version wrote
// the session's default model into .claude/settings.local.json there; in Open
// Code each /pd: command switches the session to its own model, so there is
// no default to keep, and Open Code's project config would be a file git sees.
// The file Claude Code's version wrote is left as it is: that version reads it.
describe('the fork after pdkit init', () => {
  let fork;
  const homes = [];
  const local = () => join(fork, '.claude', 'settings.local.json');

  const git = (args) => exec('git', args, { cwd: fork });

  // The suite's own environment: a git or pdkit variable of the developer's
  // would otherwise reach the command.
  const env = (home) => {
    const own = { ...process.env, PDKIT_HOME: home };
    for (const name of Object.keys(own)) if (/^(GIT_|CLAUDE_)/.test(name)) delete own[name];
    return own;
  };

  async function init(...args) {
    const home = await mkdtemp(join(tmpdir(), 'pdkit-init-home-'));
    homes.push(home);
    const { stdout } = await exec(process.execPath, [BIN, 'init', ...args], { cwd: fork, env: env(home) });
    return stdout;
  }

  /** Every file of the working tree with what it holds; .git is git's. */
  async function tree(dir = fork, prefix = '') {
    const found = {};
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (prefix === '' && entry.name === '.git') continue;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) Object.assign(found, await tree(join(dir, entry.name), name));
      else found[name] = await readFile(join(dir, entry.name), 'utf8');
    }
    return found;
  }

  const status = async () => (await git(['status', '--porcelain', '--ignored', '--untracked-files=all'])).stdout;

  before(async () => {
    fork = await mkdtemp(join(tmpdir(), 'pdkit-init-files-'));
    await git(['init', '-q', '-b', 'main']);
    await git(['remote', 'add', 'origin', 'git@github.com:jdoe/podman-desktop.git']);
    await git(['remote', 'add', 'upstream', 'git@github.com:podman-desktop/podman-desktop.git']);
    await mkdir(join(fork, 'packages', 'main'), { recursive: true });
    await writeFile(join(fork, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    await writeFile(join(fork, 'packages', 'main', 'package.json'), '{ "name": "@example/main" }\n');
    await mkdir(join(fork, '.claude'));
    await writeFile(join(fork, '.claude', 'settings.json'), '{\n  "upstream": true\n}\n');
    await git(['add', 'pnpm-workspace.yaml', 'packages', '.claude']);
    await git(['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init']);
  });

  after(async () => {
    await rm(fork, { recursive: true, force: true });
    for (const home of homes) await rm(home, { recursive: true, force: true });
  });

  test('creates no file in it and changes none, tracked or not', async () => {
    const files = await tree();
    const before = await status();

    const out = await init();

    assert.match(out, /^pdkit initialized$/m);
    assert.match(out, /^ {2}package map : 1 packages$/m, 'it did read the clone');
    assert.deepEqual(await tree(), files);
    assert.equal(await status(), before);
  });

  test('says where the models come from, in place of a model and an effort', async () => {
    const out = await init();

    assert.match(out, /^ {2}models {6}: each \/pd: command sets its own — `pdkit doctor` lists them$/m);
    assert.doesNotMatch(out, /^ {2}(model|effort) +:/m);
  });

  test('--json reports no settings', async () => {
    const report = JSON.parse(await init('--json'));

    assert.deepEqual(Object.keys(report).sort(), ['configCreated', 'fork', 'home', 'packages', 'repo', 'warnings']);
  });

  test("the settings.local.json Claude Code's version wrote is left as it is, with --force too", async () => {
    await writeFile(local(), `${JSON.stringify({ permissions: { allow: ['Bash(git status)'] }, model: 'opus' }, null, 2)}\n`);
    const files = await tree();

    await init();
    await init('--force');

    assert.deepEqual(await tree(), files);
  });

  // It used to refuse here, so as not to lose the permission rules in it.
  // Nothing reads it now, so nothing refuses over it.
  test('an invalid one no longer stops it', async () => {
    await writeFile(local(), '{ "permissions": { "allow": [ } ');
    const files = await tree();

    assert.match(await init(), /^pdkit initialized$/m);
    assert.deepEqual(await tree(), files);
  });
});

// What the prompt hook reads to tell which model a session is on.
describe('the model a transcript says', () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pdkit-transcript-'));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('a family from an id, a picker label or an alias', () => {
    assert.equal(familyOf('claude-opus-5-5'), 'opus');
    assert.equal(familyOf('Sonnet 5.5'), 'sonnet');
    assert.equal(familyOf('haiku'), 'haiku');
    assert.equal(familyOf('<synthetic>'), null);
    assert.equal(familyOf(undefined), null);
  });

  test('a record further back than the tail read is still found', async () => {
    const path = join(dir, 'long.jsonl');
    const filler = `${JSON.stringify({ type: 'attachment', text: 'x'.repeat(1000) })}\n`.repeat(2500);
    await writeFile(path, `${JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5' } })}\n${filler}`);
    assert.equal(await lastModelIn(path), 'opus');
  });

  test('no file, or a file that says nothing, is null', async () => {
    assert.equal(await lastModelIn(join(dir, 'absent.jsonl')), null);
    const path = join(dir, 'quiet.jsonl');
    await writeFile(path, `${JSON.stringify({ type: 'user', message: { content: '<command-name>/clear</command-name>' } })}\n`);
    assert.equal(await lastModelIn(path), null);
  });
});

