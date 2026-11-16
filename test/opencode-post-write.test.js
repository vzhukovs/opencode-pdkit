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

// post-write in Open Code, end to end short of the host: the execute.after
// callbacks a stand-in for setup()'s context collects, run on calls of write,
// edit and patch shaped as Open Code reports them once they have run (F43).
// Behind them is everything real — the bridge, the runner, a node process
// running bin/pdkit, post-write.js — in a clone of podman-desktop that the
// configuration names, against a throwaway $PDKIT_HOME.
//
// After a tool, what Claude Code placed beside the result — the stderr of
// exit 2, a hook's additionalContext — is added to the result as its last
// text part (§13 DV8), and the call stays one that succeeded. So each rule of
// docs/specification/06-hooks.md for post-write, and the one the code adds
// (HK-32), is asserted on the result, for each of the three tools that write
// here — which one a model gets depends on the model (F39) — and the patch
// tool once more for what only it does: leave several files in one call. Then
// the other half: post-write fails open, so every way of getting no answer
// leaves the result as the tool made it and says why in the log, and nothing
// it does turns a call that ran into one that failed (F33).
//
// lib/hooks/post-write.js had no test of its own under Claude Code (only the
// stdin protocol in hook-stdin.test.js ran it): these are the first of HK-12,
// HK-13 and HK-32.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import plugin from '../opencode/server.js';
import { spdxHeader } from '../lib/upstream.js';

const execFileAsync = promisify(execFile);

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const POSIX = process.platform !== 'win32';

const SOURCE = 'packages/main/src/plugin/container-registry.ts';
const SCHEMA = 'packages/main/src/plugin/schemas/settings.ts';
const NOTES = 'packages/main/README.md';

/** A source file as podman-desktop writes it, and one without the header. */
const WITH_HEADER = `${spdxHeader()}\n\nexport const registry = 1;\n`;
const BARE = 'export const registry = 1;\n';

let home;
let repo;
let other;
let outside;
let previousHome;

/** A git repository with the remotes given, at its real path (owns.test.js says why). */
async function repository(prefix, remotes) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  for (const [name, url] of Object.entries(remotes)) await execFileAsync('git', ['remote', 'add', name, url], { cwd: dir });
  await mkdir(join(dir, 'packages/main/src/plugin/schemas'), { recursive: true });
  return dir;
}

before(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-post-write-home-')));
  // The child process takes $PDKIT_HOME from the server's environment, as it
  // would in a session; here the server is this process. The fork is what
  // `pdkit init` would have written: post-write only speaks in the clone the
  // configuration names (HK-32).
  previousHome = process.env.PDKIT_HOME;
  process.env.PDKIT_HOME = home;
  await writeFile(join(home, 'config.yaml'), 'repo:\n  fork: someone/podman-desktop\n');

  repo = await repository('pdkit-post-write-repo-', {
    upstream: 'https://github.com/podman-desktop/podman-desktop.git',
    origin: 'git@github.com:someone/podman-desktop.git',
  });
  // This plugin's own kind of checkout: its sources carry a header of their
  // own, and must not be asked for podman-desktop's.
  other = await repository('pdkit-post-write-other-', { origin: 'git@github.com:someone/podman-desktop-kit.git' });
  outside = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-post-write-out-')));
});

after(async () => {
  if (previousHome === undefined) delete process.env.PDKIT_HOME;
  else process.env.PDKIT_HOME = previousHome;
  for (const dir of [home, repo, other, outside]) await rm(dir, { recursive: true, force: true });
});

/**
 * A stand-in for setup()'s context, in a directory: just enough for the entry
 * point to load in full. `ran` runs every execute.after callback in the order
 * they were registered, as Open Code does, on an event, and gives it back.
 */
function host(directory = repo) {
  const afterTool = [];
  const registered = { dispose: async () => {} };
  const hooks = {
    hook: async (name, callback) => {
      if (name === 'execute.after') afterTool.push(callback);
      return registered;
    },
  };
  const transforms = { transform: async () => registered };
  const ctx = {
    app: { name: 'cli', version: '2.3.0', channel: 'latest' },
    location: { directory, project: { id: 'global', directory, canonical: directory } },
    tool: hooks,
    session: { hook: async () => registered },
    shell: { hook: async () => registered },
    permission: { hook: async () => registered },
    agent: transforms,
    command: transforms,
    skill: transforms,
  };
  return {
    ctx,
    ran: async (event) => {
      for (const callback of afterTool) await callback(event);
      return event;
    },
  };
}

/** What setup() and the callbacks write to the server's stderr. */
function logOf(t) {
  const error = t.mock.method(console, 'error', () => {});
  return () => error.mock.calls.map((entry) => entry.arguments.join(' '));
}

/** The post hooks of the plugin in this checkout, loaded in `directory`. */
async function loaded(t, directory) {
  const log = logOf(t);
  const { ctx, ran } = host(directory);
  await plugin.setup(ctx);
  return { ran, log };
}

/** A text part, as a result carries it. */
const text = (value) => ({ type: 'text', text: value });

/** execute.after's event for a call that ran, with the result the tool gave (F43). */
const ran = (tool, input, result) => ({ tool, sessionID: 'ses_post', agent: 'build', messageID: 'msg_post', id: 'call_post', input, status: 'completed', result });

/** The path a result names: relative to the session's directory when inside it (F41). */
const resource = (directory, file) => (relative(directory, file).startsWith('..') ? file : relative(directory, file));

/**
 * A call of each write tool that left `content` in one file, as a model
 * would make it — `path` as the model wrote it, `file` where it lands — with
 * the file written first, as the tool would have.
 */
const TOOLS = {
  write: async (path, file, content, directory = repo) => {
    await writeFile(file, content);
    const said = `Created file successfully: ${resource(directory, file)}`;
    return ran('write', { path, content }, { output: said, content: [text(said)] });
  },
  edit: async (path, file, content, directory = repo) => {
    await writeFile(file, content);
    const said = `Edited ${resource(directory, file)} (1 replacement)`;
    return ran('edit', { path, oldString: 'registry = 0', newString: 'registry = 1' }, {
      output: said,
      content: [text(said)],
      metadata: { files: [{ file: resource(directory, file), patch: '', status: 'modified', additions: 1, deletions: 1 }] },
    });
  },
  patch: async (path, file, content, directory = repo) => {
    await writeFile(file, content);
    const patchText = ['*** Begin Patch', `*** Update File: ${path}`, '@@', '-export const registry = 0;', '+export const registry = 1;', '*** End Patch'].join('\n');
    return ran('patch', { patchText }, {
      output: {},
      content: [text(`Success. Updated the following files:\nM ${resource(directory, file)}`)],
      metadata: { files: [{ file: resource(directory, file), patch: '', status: 'modified', additions: 1, deletions: 1 }] },
    });
  },
};

/** The text post-write adds for a source file without the header (post-write.js). */
const NO_HEADER = (file) => new RegExp(`^pdkit: ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} has no license header\\. [\\s\\S]*Insert this at the top of the file:\\n\\n/\\*{70}\\n \\* Copyright \\(C\\) \\d{4} Red Hat, Inc\\.[\\s\\S]*SPDX-License-Identifier: Apache-2\\.0\\n \\*{71}/$`);

/** The reminder post-write adds for a schema file (post-write.js). */
const REMINDER = (file) => `pdkit: ${file} affects the generated schemas — run \`pnpm generate:schemas\` and commit the result`;

/** The result a call has after the hooks, given the one it had before. */
async function hooked(hooks, event) {
  const before = structuredClone(event.result);
  await hooks(event);
  return { before, now: event.result };
}

/**
 * The result kept whole, with one text part after it, on a line of its own
 * (answer.js withText says why); the text, without the line break.
 */
function added(before, now) {
  assert.deepEqual(now.content.slice(0, -1), before.content, 'the parts the tool gave stay first, as they were');
  assert.equal(now.content.length, before.content.length + 1, 'one part is added');
  const last = now.content.at(-1);
  assert.equal(last.type, 'text');
  assert.ok(last.text.startsWith('\n'), 'the text starts on a line of its own');
  for (const key of Object.keys(before).filter((key) => key !== 'content')) assert.deepEqual(now[key], before[key], key);
  return last.text.slice(1);
}

describe('the rules of 06-hooks.md for post-write, for each tool that writes', () => {
  for (const [tool, of] of Object.entries(TOOLS)) {
    describe(tool, () => {
      test('HK-12: a source file without the license header gets the header to insert, in the result', async (t) => {
        const { ran: hooks, log } = await loaded(t);
        const file = join(repo, SOURCE);

        const { before, now } = await hooked(hooks, await of(SOURCE, file, BARE));

        assert.match(added(before, now), NO_HEADER(file));
        assert.deepEqual(log(), []);
      });

      test('a source file with the header: the result as the tool gave it', async (t) => {
        const { ran: hooks, log } = await loaded(t);

        const { before, now } = await hooked(hooks, await of(SOURCE, join(repo, SOURCE), WITH_HEADER));

        assert.deepEqual(now, before);
        assert.deepEqual(log(), []);
      });

      // The reminder is all: the header of a schema file is not checked
      // (post-write.js answers for the schema first).
      test('HK-13: a schema source gets the reminder to regenerate, in the result', async (t) => {
        const { ran: hooks, log } = await loaded(t);
        const file = join(repo, SCHEMA);

        const { before, now } = await hooked(hooks, await of(SCHEMA, file, BARE));

        assert.equal(added(before, now), REMINDER(file));
        assert.deepEqual(log(), []);
      });

      test('HK-32: outside the clone the configuration names, nothing is said', async (t) => {
        const { ran: hooks, log } = await loaded(t, other);

        for (const [directory, path] of [
          [other, SOURCE],
          [other, SCHEMA],
          [outside, 'loose.ts'],
        ]) {
          const { before, now } = await hooked(hooks, await of(join(directory, path), join(directory, path), BARE, other));
          assert.deepEqual(now, before, join(directory, path));
        }
        assert.deepEqual(log(), []);
      });

      test('a file of a kind neither check is for: nothing is said', async (t) => {
        const { ran: hooks, log } = await loaded(t);

        const { before, now } = await hooked(hooks, await of(NOTES, join(repo, NOTES), '# Notes\n'));

        assert.deepEqual(now, before);
        assert.deepEqual(log(), []);
      });
    });
  }
});

// The check reads the file from disk, which is what is there after the tool
// ran: the result has none of its text (F43), and a formatter may have changed
// what the input said (F44).
describe('what post-write looks at', () => {
  test("the file on disk, not the tool's input", async (t) => {
    const { ran: hooks } = await loaded(t);
    const file = join(repo, SOURCE);

    const formatted = ran('write', { path: SOURCE, content: WITH_HEADER }, { output: 'x', content: [text('x')] });
    await writeFile(file, BARE);
    const { before, now } = await hooked(hooks, formatted);
    assert.match(added(before, now), NO_HEADER(file));

    const fixed = ran('write', { path: SOURCE, content: BARE }, { output: 'x', content: [text('x')] });
    await writeFile(file, WITH_HEADER);
    const second = await hooked(hooks, fixed);
    assert.deepEqual(second.now, second.before);
  });

  test("a relative path, from the session's directory", async (t) => {
    const directory = join(repo, 'packages/main');
    const { ran: hooks } = await loaded(t, directory);
    const file = join(repo, SOURCE);

    for (const [, of] of Object.entries(TOOLS)) {
      const { before, now } = await hooked(hooks, await of(relative(directory, file), file, BARE, directory));
      assert.match(added(before, now), NO_HEADER(file));
    }
  });

  test('a path from ~, as Open Code expands it', async (t) => {
    const previous = process.env.OPENCODE_TEST_HOME;
    process.env.OPENCODE_TEST_HOME = dirname(repo);
    t.after(() => {
      if (previous === undefined) delete process.env.OPENCODE_TEST_HOME;
      else process.env.OPENCODE_TEST_HOME = previous;
    });
    const { ran: hooks } = await loaded(t, outside);
    const file = join(repo, SOURCE);

    const { before, now } = await hooked(hooks, await TOOLS.write(`~/${basename(repo)}/${SOURCE}`, file, BARE, outside));
    assert.match(added(before, now), NO_HEADER(file));
  });

  // Claude Code ran PostToolUse when the tool had done its work; a failed
  // call went to PostToolUseFailure, which pdkit did not register.
  test('only a call that succeeded', async (t) => {
    const { ran: hooks, log } = await loaded(t);
    await writeFile(join(repo, SOURCE), BARE);

    const failed = { ...ran('edit', { path: SOURCE, oldString: 'nope', newString: 'x' }), status: 'error', error: { message: `Could not find oldString in ${SOURCE}` } };
    const before = structuredClone(failed);
    await hooks(failed);

    assert.deepEqual(failed, before);
    assert.deepEqual(log(), []);
  });
});

describe('patch: every file it leaves, and one text for the call', () => {
  /** A completed patch call, its files written as the patch left them. */
  async function patched(files, ...lines) {
    for (const [path, content] of Object.entries(files)) await writeFile(join(repo, path), content);
    return ran('patch', { patchText: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') }, { output: {}, content: [text('Success. Updated the following files:')] });
  }

  test('what each file needs, in the order of the patch, in one part', async (t) => {
    const { ran: hooks, log } = await loaded(t);
    const added1 = 'packages/main/src/plugin/a.ts';
    const added2 = 'packages/main/src/plugin/b.ts';

    const event = await patched(
      { [added1]: BARE, [SCHEMA]: BARE, [NOTES]: '# x\n', [SOURCE]: WITH_HEADER, [added2]: BARE },
      `*** Add File: ${added1}`,
      '+export const registry = 1;',
      `*** Update File: ${SCHEMA}`,
      '@@',
      '-a',
      '+b',
      `*** Add File: ${NOTES}`,
      '+# x',
      `*** Update File: ${SOURCE}`,
      '@@',
      '-a',
      '+b',
      `*** Add File: ${added2}`,
      '+export const registry = 1;',
    );
    const { before, now } = await hooked(hooks, event);

    const textOf = added(before, now);
    assert.equal(textOf.match(/has no license header/g).length, 2);
    const first = textOf.indexOf(`pdkit: ${join(repo, added1)} has no license header`);
    const reminder = textOf.indexOf(REMINDER(join(repo, SCHEMA)));
    const second = textOf.indexOf(`pdkit: ${join(repo, added2)} has no license header`);
    assert.ok(first === 0 && reminder > first && second > reminder, textOf);
    assert.doesNotMatch(textOf, /container-registry\.ts|README\.md/);
    assert.deepEqual(log(), []);
  });

  test('a file it moved is looked at where it went, not where it was', async (t) => {
    const { ran: hooks } = await loaded(t);
    const to = 'packages/main/src/plugin/moved.ts';

    const event = await patched({ [to]: BARE }, `*** Update File: ${SOURCE}`, `*** Move to: ${to}`, '@@', '-a', '+b');
    const { before, now } = await hooked(hooks, event);

    assert.match(added(before, now), NO_HEADER(join(repo, to)));
  });

  test('a file it deleted is not looked at: there is nothing there', async (t) => {
    const { ran: hooks, log } = await loaded(t);

    const event = await patched({}, '*** Delete File: packages/main/src/plugin/gone.ts');
    const { before, now } = await hooked(hooks, event);

    assert.deepEqual(now, before);
    assert.deepEqual(log(), []);
  });
});

// The hooks share execute.after with nothing else yet; each reads only its
// own calls.
describe('beside the other tools', () => {
  test('the result of a call that writes nothing is left alone', async (t) => {
    const { ran: hooks, log } = await loaded(t);
    await writeFile(join(repo, SOURCE), BARE);

    for (const event of [
      ran('shell', { command: `cat ${SOURCE}`, path: SOURCE }, { output: { stdout: BARE }, content: [text(BARE)] }),
      ran('read', { path: SOURCE }, { output: { type: 'file' }, content: [text(BARE)] }),
      ran('experimental_image_generate', { path: SOURCE }, { output: {}, content: [text('done')] }),
    ]) {
      const { before, now } = await hooked(hooks, event);
      assert.deepEqual(now, before, event.tool);
    }
    assert.deepEqual(log(), []);
  });
});

/**
 * A copy of the plugin with some files replaced, loaded in the repository.
 *
 * @param {import('node:test').TestContext} t
 * @param {Record<string, string|((text: string) => string)|null>} files
 */
async function broken(t, files) {
  const dir = await mkdtemp(join(tmpdir(), 'pdkit-post-write-plugin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const entry of ['opencode', 'lib', 'bin', 'defaults', 'package.json']) {
    await cp(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  for (const [path, change] of Object.entries(files)) {
    const file = join(dir, path);
    if (change === null) await rm(file);
    else await writeFile(file, typeof change === 'function' ? change(await readFile(file, 'utf8')) : change);
  }
  const copy = (await import(pathToFileURL(join(dir, 'opencode', 'server.js')).href)).default;
  const log = logOf(t);
  const { ctx, ran: hooks } = host(repo);
  await copy.setup(ctx);
  return { ran: hooks, log };
}

/** The one line a call left as it was for want of an answer leaves in the log. */
const allowing = (log, problem) => {
  assert.equal(log().length, 1, log().join('\n'));
  assert.match(log()[0], new RegExp(`^opencode-pdkit: pdkit: hook "post-write" ${problem}.*; allowing$`, 's'));
};

// post-write fails open (FAIL_CLOSED names pre-bash alone), and after a tool
// failing open is more than letting the call through: the call has run, and
// the bridge must not turn it into an error (F33). Each case is a write a
// working check speaks up about, so a result left as the tool gave it is the
// failure's doing.
describe('no answer leaves the result as the tool gave it, and says why', () => {
  /** A call the check has something to say about, and its result after the hooks. */
  async function unchanged(hooks) {
    const { before, now } = await hooked(hooks, await TOOLS.write(SOURCE, join(repo, SOURCE), BARE));
    assert.deepEqual(now, before);
  }

  test('no node on the PATH of the server', { skip: !POSIX && 'T10.10' }, async (t) => {
    const { ran: hooks, log } = await loaded(t);
    const path = process.env.PATH;
    process.env.PATH = home;
    t.after(() => (process.env.PATH = path));

    await unchanged(hooks);
    allowing(log, 'cannot run: "node" was not found on the PATH of the process that runs hooks \\(ENOENT\\)');
  });

  test('a session directory that does not exist', async (t) => {
    const { ran: hooks, log } = await loaded(t, join(repo, 'missing'));

    const { before, now } = await hooked(hooks, await TOOLS.write(join(repo, SOURCE), join(repo, SOURCE), BARE));
    assert.deepEqual(now, before);
    allowing(log, 'cannot run: its working directory does not exist: ');
  });

  test('a CLI that does not load: exit 1', async (t) => {
    const { ran: hooks, log } = await broken(t, { 'lib/cli.js': 'this is not valid javascript {{{\n' });

    await unchanged(hooks);
    allowing(log, 'exited with code 1 \\(SyntaxError: ');
  });

  test('a handler that does not load: runHook allows, as under Claude Code', async (t) => {
    const { ran: hooks, log } = await broken(t, { 'lib/hooks/post-write.js': 'this is not valid javascript {{{\n' });

    await unchanged(hooks);
    allowing(log, 'handler "post-write\\.js" is unavailable');
  });

  test('a handler that throws: runHook allows, as under Claude Code', async (t) => {
    const { ran: hooks, log } = await broken(t, { 'lib/hooks/post-write.js': "export async function handle() { throw new Error('headers broke'); }\n" });

    await unchanged(hooks);
    allowing(log, 'failed \\(headers broke\\)');
  });

  test('a handler that hangs: stopped at the deadline', async (t) => {
    const { ran: hooks, log } = await broken(t, {
      'lib/hooks/post-write.js': 'export function handle() { return new Promise(() => setInterval(() => {}, 1000)); }\n',
      'lib/hooks/runner.js': (source) => source.replace('export const DEADLINE_MS = 10_000;', 'export const DEADLINE_MS = 500;'),
    });

    await unchanged(hooks);
    allowing(log, 'gave no answer within 0\\.5s and was stopped');
  });

  // One file of a patch whose run failed takes nothing from another's.
  test('in a patch, a run that failed does not cost the text of one that answered', async (t) => {
    const { ran: hooks, log } = await broken(t, {
      'lib/hooks/post-write.js':
        "export async function handle(payload) {\n  const file = payload.tool_input.file_path;\n  if (file.endsWith('boom.ts')) throw new Error('boom');\n  return { block: true, reason: `pdkit: ${file} needs a header` };\n}\n",
    });
    await writeFile(join(repo, 'packages/main/src/plugin/boom.ts'), BARE);
    await writeFile(join(repo, SOURCE), BARE);

    const event = ran(
      'patch',
      { patchText: ['*** Begin Patch', '*** Add File: packages/main/src/plugin/boom.ts', '+x', `*** Add File: ${SOURCE}`, '+x', '*** End Patch'].join('\n') },
      { output: {}, content: [text('Success.')] },
    );
    const { before, now } = await hooked(hooks, event);

    assert.equal(added(before, now), `pdkit: ${join(repo, SOURCE)} needs a header`);
    allowing(log, 'failed \\(boom\\)');
  });

  test('a bridge that fails before the runner is reached', async (t) => {
    const log = logOf(t);
    const { ctx, ran: hooks } = host(repo);
    await plugin.setup(ctx);
    Object.defineProperty(ctx, 'location', {
      get() {
        throw new Error('no location today');
      },
    });

    await unchanged(hooks);
    allowing(log, 'failed in the hook bridge \\(no location today\\)');
  });

  // The text was ready; the result would not take it. The call still stands.
  test('a result that cannot be replaced: the call stands, and the log says so', async (t) => {
    const { ran: hooks, log } = await loaded(t);
    const event = await TOOLS.write(SOURCE, join(repo, SOURCE), BARE);
    const result = event.result;
    Object.defineProperty(event, 'result', {
      get: () => result,
      set() {
        throw new Error('read-only result');
      },
    });

    await hooks(event);

    assert.equal(event.result, result);
    assert.equal(log().length, 1, log().join('\n'));
    assert.match(log()[0], /^opencode-pdkit: pdkit: the hook bridge failed after a tool call \(read-only result\); its result is as the tool left it$/);
  });
});
