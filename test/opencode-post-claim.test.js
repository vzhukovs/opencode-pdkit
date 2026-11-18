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

// post-claim in Open Code, end to end short of the host: the execute.after
// callbacks a stand-in for setup()'s context collects, run on calls of write,
// edit and patch shaped as Open Code reports them once they have run (F43).
// Behind them is everything real — the bridge, the runner, a node process
// running bin/pdkit, post-claim.js and its git grep — in a clone of
// podman-desktop that the configuration names, against a throwaway
// $PDKIT_HOME.
//
// The fixture is post-claim.test.js's: the API declares the local name
// (`urlProtocol`) and not the borrowed one (`uriScheme`), and a design
// document proposes the borrowed one. Each case of that suite that hands
// handle() a payload is here as the calls a model makes in Open Code — which
// of the three tools it gets depends on the model (F39) — with the reminder
// asserted where the model reads it: the last text part of the call's result
// (§13 DV8). The suite's other cases (claims, occurring) take no payload and
// stand as they are.
//
// Then what only Open Code has: the text a patch writes is its added lines;
// one patch writes several files; post-write runs beside post-claim on the
// same call and both texts share one part; and post-claim fails open without
// turning a call that ran into one that failed (F33).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import plugin from '../opencode/server.js';
import { PLUGIN_ROOT } from '../lib/commands/support.js';
import { spdxHeader } from '../lib/upstream.js';
import { logOf } from './helpers/server-log.js';

const execFileAsync = promisify(execFile);

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const POSIX = process.platform !== 'win32';

/** The API the claims are about, and a document that proposes a name it lacks. */
const API = 'packages/extension-api/src/extension-api.d.ts';
const DESIGN = 'docs/design.md';
const NOTES = 'docs/notes.md';
const SCHEMA_NOTES = 'packages/main/src/plugin/schemas/README.md';
const SOURCE = 'packages/main/src/plugin/container-registry.ts';

const PROPOSAL = 'Add `env.uriScheme` here.';
/**
 * A proposal of a member no tracked file names. The borrowed name of
 * PROPOSAL is in DESIGN, the document that proposes it: a write anywhere else
 * that calls it missing finds it there, and post-claim is right to say
 * nothing. So a case about another file proposes this one.
 */
const FRESH = 'Add `env.deepLinkHandler` here.';

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
  for (const path of [API, DESIGN, SCHEMA_NOTES, SOURCE]) await mkdir(dirname(join(dir, path)), { recursive: true });
  return dir;
}

/** A clone of podman-desktop as post-claim tells one, with the API tracked: git grep reads what git tracks. */
async function podmanDesktop(prefix) {
  const dir = await repository(prefix, {
    upstream: 'https://github.com/podman-desktop/podman-desktop.git',
    origin: 'git@github.com:someone/podman-desktop.git',
  });
  await writeFile(join(dir, API), 'export namespace env {\n  export const appName: string;\n  export const urlProtocol: string;\n}\n');
  await writeFile(join(dir, DESIGN), `${PROPOSAL}\n`);
  await execFileAsync('git', ['add', API, DESIGN], { cwd: dir });
  return dir;
}

before(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-post-claim-home-')));
  // The child process takes $PDKIT_HOME from the server's environment, as it
  // would in a session; here the server is this process. The fork is what
  // `pdkit init` would have written: post-claim searches only the clone the
  // configuration names.
  previousHome = process.env.PDKIT_HOME;
  process.env.PDKIT_HOME = home;
  await writeFile(join(home, 'config.yaml'), 'repo:\n  fork: someone/podman-desktop\n');

  repo = await podmanDesktop('pdkit-post-claim-repo-');
  // This plugin's own kind of checkout: not the codebase the claims are about.
  other = await repository('pdkit-post-claim-other-', { origin: 'git@github.com:someone/podman-desktop-kit.git' });
  outside = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-post-claim-out-')));
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
    event: { subscribe: async function* () {} },
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
const ran = (tool, input, result) => ({ tool, sessionID: 'ses_claim', agent: 'build', messageID: 'msg_claim', id: 'call_claim', input, status: 'completed', result });

/** The path a result names: relative to the session's directory when inside it (F41). */
const resource = (directory, file) => (relative(directory, file).startsWith('..') ? file : relative(directory, file));

/** What a markdown file holds once a call has written `written` into it. */
const document = (written) => `# Notes\n\n${written}\n`;

/**
 * A call of each write tool that wrote `written` in one file, as a model
 * would make it — `path` as the model wrote it, `file` where it lands — with
 * the file left on disk as the tool would have left it. write writes the
 * file whole; edit replaces a placeholder with the text; patch replaces it
 * with the text as added lines, beside a line of context.
 */
const TOOLS = {
  write: async (path, file, written, directory = repo) => {
    await writeFile(file, written);
    const said = `Created file successfully: ${resource(directory, file)}`;
    return ran('write', { path, content: written }, { output: said, content: [text(said)] });
  },
  edit: async (path, file, written, directory = repo) => {
    await writeFile(file, document(written));
    const said = `Edited ${resource(directory, file)} (1 replacement)`;
    return ran('edit', { path, oldString: 'TBD', newString: written }, {
      output: said,
      content: [text(said)],
      metadata: { files: [{ file: resource(directory, file), patch: '', status: 'modified', additions: 1, deletions: 1 }] },
    });
  },
  patch: async (path, file, written, directory = repo) => {
    await writeFile(file, document(written));
    const patchText = ['*** Begin Patch', `*** Update File: ${path}`, '@@', ' # Notes', ' ', '-TBD', ...written.split('\n').map((line) => `+${line}`), '*** End Patch'].join('\n');
    return ran('patch', { patchText }, {
      output: {},
      content: [text(`Success. Updated the following files:\nM ${resource(directory, file)}`)],
      metadata: { files: [{ file: resource(directory, file), patch: '', status: 'modified', additions: 1, deletions: 1 }] },
    });
  },
};

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The reminder post-claim adds for the names given (post-claim.js), naming the rule under this plugin's root. */
const REMINDER = (...names) =>
  new RegExp(
    `^pdkit: this text proposes or calls missing ${names.map((name) => escape(`\`${name}\``)).join(', ')}, and ${names.length === 1 ? 'that name matches' : 'those names match'} ` +
      'nothing in podman-desktop outside this file\\. A name with no match is not yet evidence that the concept is absent\\. ' +
      `[\\s\\S]*See "A name from another project" in ${escape(PLUGIN_ROOT)}/knowledge/pitfalls\\.md\\.$`,
  );

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

describe('the rules of 06-hooks.md for post-claim, for each tool that writes', () => {
  for (const [tool, of] of Object.entries(TOOLS)) {
    describe(tool, () => {
      // The document itself names the borrowed name: it is left out of the
      // search, or every proposal would find itself.
      test('HK-16: a proposed member that matches nothing outside the document gets the reminder, in the result', async (t) => {
        const { ran: hooks, log } = await loaded(t);

        const { before, now } = await hooked(hooks, await of(DESIGN, join(repo, DESIGN), PROPOSAL));

        assert.match(added(before, now), REMINDER('env.uriScheme'));
        assert.deepEqual(log(), []);
      });

      // Open Code has no variable for the plugin's directory and expands no
      // placeholder in a result: the path must be one the model can open.
      test("the rule is named under the plugin's own directory, where it is", async (t) => {
        const { ran: hooks } = await loaded(t);

        const { before, now } = await hooked(hooks, await of(DESIGN, join(repo, DESIGN), PROPOSAL));

        const rule = added(before, now).match(/See "A name from another project" in (.+)\.$/)[1];
        assert.equal(rule, join(PLUGIN_ROOT, 'knowledge', 'pitfalls.md'));
        assert.match(await readFile(rule, 'utf8'), /^## A name from another project$/m);
      });

      test('a name said to be missing that is there: nothing is said', async (t) => {
        const { ran: hooks, log } = await loaded(t);

        const { before, now } = await hooked(hooks, await of(NOTES, join(repo, NOTES), 'There is no `urlProtocol` yet.'));

        assert.deepEqual(now, before);
        assert.deepEqual(log(), []);
      });

      // "Outside this file" is any tracked file: here, the design document
      // that proposed the name first.
      test('a name that another document of the clone names: nothing is said', async (t) => {
        const { ran: hooks, log } = await loaded(t);

        const { before, now } = await hooked(hooks, await of(NOTES, join(repo, NOTES), PROPOSAL));

        assert.deepEqual(now, before);
        assert.deepEqual(log(), []);
      });

      test('outside markdown, nothing is said', async (t) => {
        const { ran: hooks, log } = await loaded(t);

        for (const path of ['docs/design.txt', 'docs/design.mdx', 'docs/design.markdown', 'docs/README']) {
          const { before, now } = await hooked(hooks, await of(path, join(repo, path), FRESH));
          assert.deepEqual(now, before, path);
        }
        assert.deepEqual(log(), []);
      });

      test('outside podman-desktop, nothing is said', async (t) => {
        for (const directory of [other, outside]) {
          const { ran: hooks, log } = await loaded(t, directory);
          const { before, now } = await hooked(hooks, await of('design.md', join(directory, 'design.md'), PROPOSAL, directory));
          assert.deepEqual(now, before, directory);
          assert.deepEqual(log(), [], directory);
        }
      });

      test('a claim that already names its search: nothing is said', async (t) => {
        const { ran: hooks, log } = await loaded(t);

        const written = 'Add `env.uriScheme`; searched: git grep -i "scheme|protocol" -- api -> 0.';
        const { before, now } = await hooked(hooks, await of(DESIGN, join(repo, DESIGN), written));

        assert.deepEqual(now, before);
        assert.deepEqual(log(), []);
      });

      test('a search that names nothing does not quiet it', async (t) => {
        const { ran: hooks } = await loaded(t);

        const { before, now } = await hooked(hooks, await of(DESIGN, join(repo, DESIGN), 'The API has no `uriScheme`; searched: yes.'));

        assert.match(added(before, now), REMINDER('uriScheme'));
      });
    });
  }

  // Not knowing is not a zero: a git that cannot search says nothing about
  // the name. A clone whose index git cannot read is that git.
  test('when git cannot answer, nothing is said', async (t) => {
    const broken = await podmanDesktop('pdkit-post-claim-noindex-');
    t.after(() => rm(broken, { recursive: true, force: true }));
    await writeFile(join(broken, '.git', 'index'), 'not an index');
    const { ran: hooks, log } = await loaded(t, broken);

    for (const [, of] of Object.entries(TOOLS)) {
      const { before, now } = await hooked(hooks, await of(DESIGN, join(broken, DESIGN), PROPOSAL, broken));
      assert.deepEqual(now, before);
    }
    assert.deepEqual(log(), []);
  });
});

// post-claim reads the text a call wrote, as the payload carries it — not the
// file: a Write's content, an Edit's new_string, and for a patch the lines it
// adds.
describe('what post-claim reads', () => {
  test('an edit: the new text, not the text it replaces', async (t) => {
    const { ran: hooks } = await loaded(t);
    await writeFile(join(repo, NOTES), document('Done.'));
    const result = () => ({ output: 'Edited', content: [text('Edited')] });

    const removed = await hooked(hooks, ran('edit', { path: NOTES, oldString: FRESH, newString: 'Done.' }, result()));
    assert.deepEqual(removed.now, removed.before);

    const written = await hooked(hooks, ran('edit', { path: NOTES, oldString: 'Done.', newString: FRESH }, result()));
    assert.match(added(written.before, written.now), REMINDER('env.deepLinkHandler'));
  });

  test('a patch: the lines it adds, not its context or the lines it removes', async (t) => {
    const { ran: hooks } = await loaded(t);
    const patch = (...lines) => ran('patch', { patchText: ['*** Begin Patch', `*** Update File: ${NOTES}`, '@@', ...lines, '*** End Patch'].join('\n') }, { output: {}, content: [text('Success.')] });

    for (const event of [patch(` ${FRESH}`, '-old', '+new'), patch(' # Notes', `-${FRESH}`, '+Done.')]) {
      const { before, now } = await hooked(hooks, event);
      assert.deepEqual(now, before, event.input.patchText);
    }
    const { before, now } = await hooked(hooks, patch(' # Notes', '-TBD', `+${FRESH}`));
    assert.match(added(before, now), REMINDER('env.deepLinkHandler'));
  });

  test('the text the call wrote, not what is on disk after it', async (t) => {
    const { ran: hooks } = await loaded(t);
    await writeFile(join(repo, NOTES), document('Formatted away.'));

    const { before, now } = await hooked(hooks, ran('write', { path: NOTES, content: FRESH }, { output: 'x', content: [text('x')] }));
    assert.match(added(before, now), REMINDER('env.deepLinkHandler'));
  });

  // The written file is left out of the search by its path inside the
  // repository; given a relative one, post-claim would take it from the
  // repository's root, which is not where a session in a subdirectory is
  // (T1.4). The bridge hands it the whole path.
  test("a relative path, from the session's directory, in a subdirectory of the clone", async (t) => {
    const directory = join(repo, 'docs');
    const { ran: hooks } = await loaded(t, directory);

    for (const [tool, of] of Object.entries(TOOLS)) {
      const { before, now } = await hooked(hooks, await of(basename(DESIGN), join(repo, DESIGN), PROPOSAL, directory));
      assert.match(added(before, now), REMINDER('env.uriScheme'), tool);
    }
  });

  test('a path from ~, as Open Code expands it', async (t) => {
    const previous = process.env.OPENCODE_TEST_HOME;
    process.env.OPENCODE_TEST_HOME = dirname(repo);
    t.after(() => {
      if (previous === undefined) delete process.env.OPENCODE_TEST_HOME;
      else process.env.OPENCODE_TEST_HOME = previous;
    });
    const { ran: hooks } = await loaded(t, repo);

    const { before, now } = await hooked(hooks, await TOOLS.write(`~/${basename(repo)}/${DESIGN}`, join(repo, DESIGN), PROPOSAL));
    assert.match(added(before, now), REMINDER('env.uriScheme'));
  });

  // Claude Code ran PostToolUse when the tool had done its work; a failed
  // call went to PostToolUseFailure, which pdkit did not register.
  test('only a call that succeeded', async (t) => {
    const { ran: hooks, log } = await loaded(t);

    const failed = { ...ran('edit', { path: NOTES, oldString: 'nope', newString: FRESH }), status: 'error', error: { message: `Could not find oldString in ${NOTES}` } };
    const before = structuredClone(failed);
    await hooks(failed);

    assert.deepEqual(failed, before);
    assert.deepEqual(log(), []);
  });
});

describe('patch: every markdown file it writes, and one text for the call', () => {
  /** A completed patch call, its files written as the patch left them. */
  async function patched(files, ...lines) {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await writeFile(join(repo, path), content);
    }
    return ran('patch', { patchText: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') }, { output: {}, content: [text('Success. Updated the following files:')] });
  }

  test('what each file needs, in the order of the patch, in one part', async (t) => {
    const { ran: hooks, log } = await loaded(t);

    const event = await patched(
      { 'docs/a.md': '', [NOTES]: '', 'docs/quiet.md': '', 'docs/b.txt': '' },
      '*** Add File: docs/a.md',
      '+# A',
      '+Should `env` get a `deepLinkScheme` field?',
      `*** Update File: ${NOTES}`,
      '@@',
      ' # Notes',
      '-TBD',
      '+There is no `onDidOpenUri` event.',
      '*** Add File: docs/quiet.md',
      '+There is no `urlProtocol` yet.',
      '*** Add File: docs/b.txt',
      '+There is no `notInMarkdown` here.',
    );
    const { before, now } = await hooked(hooks, event);

    const [first, second, ...rest] = added(before, now).split('\n\n');
    assert.match(first, REMINDER('deepLinkScheme'));
    assert.match(second, REMINDER('onDidOpenUri'));
    assert.deepEqual(rest, []);
    assert.deepEqual(log(), []);
  });

  // Where it went is what counts: from a file post-claim does not read to
  // markdown, and from markdown to a file it does not read.
  test('a file it moved is read where it went', async (t) => {
    const { ran: hooks } = await loaded(t);

    const into = await hooked(hooks, await patched({ 'docs/moved.md': '' }, '*** Update File: docs/draft.txt', '*** Move to: docs/moved.md', '@@', '-TBD', `+${FRESH}`));
    assert.match(added(into.before, into.now), REMINDER('env.deepLinkHandler'));

    const out = await hooked(hooks, await patched({ 'docs/moved.txt': '' }, `*** Update File: ${NOTES}`, '*** Move to: docs/moved.txt', '@@', '-TBD', `+${FRESH}`));
    assert.deepEqual(out.now, out.before);
  });

  test('a file it deleted is not read: it wrote nothing there', async (t) => {
    const { ran: hooks, log } = await loaded(t);

    const { before, now } = await hooked(hooks, await patched({}, '*** Delete File: docs/gone.md'));

    assert.deepEqual(now, before);
    assert.deepEqual(log(), []);
  });
});

// post-write and post-claim both look at every write (WIRING in
// opencode/bridge/hooks.js): a call they both have something to say about
// gets both texts, in one part, post-write's first — the order the table in
// lib/hooks/events.js lists them in, as Claude Code's manifest did.
describe('beside post-write', () => {
  /** The reminder post-write adds for a schema path (post-write.js). */
  const SCHEMA_REMINDER = (file) => `pdkit: ${file} affects the generated schemas — run \`pnpm generate:schemas\` and commit the result`;

  for (const [tool, of] of Object.entries(TOOLS)) {
    test(`${tool}: markdown under schemas/ gets post-write's reminder and post-claim's, one part`, async (t) => {
      const { ran: hooks, log } = await loaded(t);
      const file = join(repo, SCHEMA_NOTES);

      const { before, now } = await hooked(hooks, await of(SCHEMA_NOTES, file, FRESH));

      const [schema, claim, ...rest] = added(before, now).split('\n\n');
      assert.equal(schema, SCHEMA_REMINDER(file));
      assert.match(claim, REMINDER('env.deepLinkHandler'));
      assert.deepEqual(rest, []);
      assert.deepEqual(log(), []);
    });
  }

  test('patch: a source file without the header and a claim, one part', async (t) => {
    const { ran: hooks, log } = await loaded(t);
    await writeFile(join(repo, SOURCE), 'export const registry = 1;\n');
    await writeFile(join(repo, NOTES), FRESH);

    const event = ran(
      'patch',
      { patchText: ['*** Begin Patch', `*** Add File: ${SOURCE}`, '+export const registry = 1;', `*** Add File: ${NOTES}`, `+${FRESH}`, '*** End Patch'].join('\n') },
      { output: {}, content: [text('Success.')] },
    );
    const { before, now } = await hooked(hooks, event);

    const textOf = added(before, now);
    assert.ok(textOf.startsWith(`pdkit: ${join(repo, SOURCE)} has no license header. `), textOf);
    assert.ok(textOf.includes(spdxHeader().trim()), textOf);
    assert.match(textOf.slice(textOf.lastIndexOf('\n\npdkit: ') + 2), REMINDER('env.deepLinkHandler'));
    assert.deepEqual(log(), []);
  });
});

// post-claim shares execute.after with post-write; neither reads a call that
// writes nothing.
describe('beside the other tools', () => {
  test('the result of a call that writes nothing is left alone, whatever it shows', async (t) => {
    const { ran: hooks, log } = await loaded(t);

    for (const event of [
      ran('shell', { command: `cat ${DESIGN}`, path: DESIGN }, { output: { stdout: PROPOSAL }, content: [text(PROPOSAL)] }),
      ran('read', { path: DESIGN }, { output: { type: 'file' }, content: [text(PROPOSAL)] }),
      ran('grep', { pattern: 'uriScheme' }, { output: {}, content: [text(`Found 1 matches\n${join(repo, DESIGN)}:\n  Line 1: ${PROPOSAL}`)] }),
      ran('experimental_image_generate', { path: DESIGN, content: PROPOSAL }, { output: {}, content: [text('done')] }),
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
  const dir = await mkdtemp(join(tmpdir(), 'pdkit-post-claim-plugin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const entry of ['opencode', 'lib', 'bin', 'defaults', 'agents', 'skills', 'package.json']) {
    await cp(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  for (const [path, change] of Object.entries(files)) {
    const file = join(dir, path);
    if (change === null) await rm(file);
    else await writeFile(file, typeof change === 'function' ? change(await readFile(file, 'utf8')) : change);
  }
  const copy = (await import(pathToFileURL(join(dir, 'opencode', 'server.js')).href)).default;
  const log = logOf(t, { watch: false });
  const { ctx, ran: hooks } = host(repo);
  await copy.setup(ctx);
  return { ran: hooks, log };
}

/**
 * The lines a call left as it was for want of an answer leaves in the log:
 * one for each hook named, each saying `problem`. In no set order: the hooks
 * of a call run side by side, and each writes its line when its run ends.
 */
const allowing = (log, problem, hooks = ['post-claim']) => {
  assert.equal(log().length, hooks.length, log().join('\n'));
  const said = (hook) => log().filter((line) => line.startsWith(`opencode-pdkit: pdkit: hook "${hook}" `));
  for (const hook of hooks) {
    assert.equal(said(hook).length, 1, `${hook}: ${log().join('\n')}`);
    assert.match(said(hook)[0], new RegExp(`^opencode-pdkit: pdkit: hook "${hook}" ${problem}.*; allowing$`, 's'));
  }
};

// post-claim fails open (FAIL_CLOSED names pre-bash alone), and after a tool
// failing open is more than letting the call through: the call has run, and
// the bridge must not turn it into an error (F33). Each case is a write a
// working check speaks up about, so a result left as the tool gave it is the
// failure's doing. post-write runs on the same call and has nothing to say
// about a markdown file: where the failure is the environment's, it fails
// too, and says so in a line of its own.
describe('no answer leaves the result as the tool gave it, and says why', () => {
  /** A call the check has something to say about, and its result after the hooks. */
  async function unchanged(hooks) {
    const { before, now } = await hooked(hooks, await TOOLS.write(DESIGN, join(repo, DESIGN), PROPOSAL));
    assert.deepEqual(now, before);
  }

  test('no node on the PATH of the server', { skip: !POSIX && 'T10.10' }, async (t) => {
    const { ran: hooks, log } = await loaded(t);
    const path = process.env.PATH;
    process.env.PATH = home;
    t.after(() => (process.env.PATH = path));

    await unchanged(hooks);
    allowing(log, 'cannot run: "node" was not found on the PATH of the process that runs hooks \\(ENOENT\\)', ['post-write', 'post-claim']);
  });

  test('a session directory that does not exist', async (t) => {
    const { ran: hooks, log } = await loaded(t, join(repo, 'missing'));

    const { before, now } = await hooked(hooks, await TOOLS.write(join(repo, DESIGN), join(repo, DESIGN), PROPOSAL));
    assert.deepEqual(now, before);
    allowing(log, 'cannot run: its working directory does not exist: ', ['post-write', 'post-claim']);
  });

  test('a CLI that does not load: exit 1', async (t) => {
    const { ran: hooks, log } = await broken(t, { 'lib/cli.js': 'this is not valid javascript {{{\n' });

    await unchanged(hooks);
    allowing(log, 'exited with code 1 \\(SyntaxError: ', ['post-write', 'post-claim']);
  });

  test('a handler that does not load: runHook allows, as under Claude Code', async (t) => {
    const { ran: hooks, log } = await broken(t, { 'lib/hooks/post-claim.js': 'this is not valid javascript {{{\n' });

    await unchanged(hooks);
    allowing(log, 'handler "post-claim\\.js" is unavailable');
  });

  test('a handler that throws: runHook allows, as under Claude Code', async (t) => {
    const { ran: hooks, log } = await broken(t, { 'lib/hooks/post-claim.js': "export async function handle() { throw new Error('grep broke'); }\n" });

    await unchanged(hooks);
    allowing(log, 'failed \\(grep broke\\)');
  });

  // A deadline post-write's run on the same call finishes well inside, so the
  // line in the log is post-claim's alone.
  test('a handler that hangs: stopped at the deadline', async (t) => {
    const { ran: hooks, log } = await broken(t, {
      'lib/hooks/post-claim.js': 'export function handle() { return new Promise(() => setInterval(() => {}, 1000)); }\n',
      'lib/hooks/runner.js': (source) => source.replace('export const DEADLINE_MS = 10_000;', 'export const DEADLINE_MS = 2_000;'),
    });

    await unchanged(hooks);
    allowing(log, 'gave no answer within 2s and was stopped');
  });

  // One file of a patch whose run failed takes nothing from another's.
  test('in a patch, a run that failed does not cost the text of one that answered', async (t) => {
    const { ran: hooks, log } = await broken(t, {
      'lib/hooks/post-claim.js':
        "export async function handle(payload) {\n  const file = payload.tool_input.file_path;\n  if (file.endsWith('boom.md')) throw new Error('boom');\n  return { block: false, message: `pdkit: ${file} claims ${payload.tool_input.content}` };\n}\n",
    });

    const event = ran(
      'patch',
      { patchText: ['*** Begin Patch', '*** Add File: docs/boom.md', '+x', `*** Add File: ${NOTES}`, '+y', '*** End Patch'].join('\n') },
      { output: {}, content: [text('Success.')] },
    );
    const { before, now } = await hooked(hooks, event);

    assert.equal(added(before, now), `pdkit: ${join(repo, NOTES)} claims y`);
    allowing(log, 'failed \\(boom\\)');
  });

  // Each hook of a call answers for itself: post-claim failing costs
  // post-write's text nothing.
  test("a post-claim that failed does not cost post-write's text", async (t) => {
    const { ran: hooks, log } = await broken(t, { 'lib/hooks/post-claim.js': "export async function handle() { throw new Error('grep broke'); }\n" });
    const file = join(repo, SCHEMA_NOTES);

    const { before, now } = await hooked(hooks, await TOOLS.write(SCHEMA_NOTES, file, FRESH));

    assert.equal(added(before, now), `pdkit: ${file} affects the generated schemas — run \`pnpm generate:schemas\` and commit the result`);
    allowing(log, 'failed \\(grep broke\\)');
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
    allowing(log, 'failed in the hook bridge \\(no location today\\)', ['post-write', 'post-claim']);
  });
});
