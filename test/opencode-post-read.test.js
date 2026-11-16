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

// post-read in Open Code, end to end short of the host: the execute.after
// callbacks a stand-in for setup()'s context collects, run on calls of the
// read and grep tools shaped as Open Code reports them once they have run
// (F48, F52, F265). Behind them is everything real — the bridge, the runner,
// a node process running bin/pdkit, post-read.js and cut.js — in a directory
// that is no repository at all: the rule holds in any.
//
// The fixtures are post-read.test.js's: a namespace a window cut before its
// last member and its brace, and the same namespace read to its brace. Each
// case of that suite that hands handle() a payload is here as a call a model
// makes, with the rule asserted where the model reads it: the last text part
// of the call's result (§13 DV8). Its readWindow() and grepWindows() cases
// take no call and stand as they are.
//
// Then what only Open Code has. The read tool reports the window as a page —
// where it starts, whether lines follow — and how many lines the file has
// only when the page reaches its end; for any other page the bridge counts
// them on disk, and a file it cannot count costs the rule and says so in the
// log (§13 DV9). The grep tool has no context around a match, and its limit
// is 100 by default. A call that failed is reported as one, with no result.
// And post-read fails open without turning a call that ran into one that
// failed (F33).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import plugin from '../opencode/server.js';
import { PLUGIN_ROOT } from '../lib/commands/support.js';
import { cutDecision } from '../lib/hooks/cut.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const POSIX = process.platform !== 'win32';

/** Where the rule is, as the message names it: under the plugin's root, as runHook passes it. */
const RULE = `${PLUGIN_ROOT}/knowledge/pitfalls.md`;

/** A namespace cut before its last member and its brace (post-read.test.js). */
const CUT = ['  export namespace env {', '    export const appName: string;'].join('\n');

/** The same namespace read to its brace. */
const WHOLE = `${CUT}\n    export const urlProtocol: string;\n  }`;

/** `count` lines that open a block and never close it: CUT, then members. */
const open = (count) => [...CUT.split('\n'), ...Array.from({ length: count - 2 }, (_, i) => `    export const member${i}: string;`)].join('\n');

/** The text post-read has for the windows given, over `content`: the handler's own words (cut.js). */
const SAYS = (windows, content) => cutDecision(windows, content, PLUGIN_ROOT).message;

/** A file of `count` lines, each ending in a line feed. */
const linesOf = (count) => `${Array.from({ length: count }, (_, i) => `line ${i + 1};`).join('\n')}\n`;

let session;
let home;

before(async () => {
  // No repository: post-read is not scoped to one.
  session = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-post-read-session-')));
  home = await realpath(await mkdtemp(join(tmpdir(), 'pdkit-post-read-home-')));
  await mkdir(join(session, 'packages', 'main'), { recursive: true });
  // The declarations a plain read cuts: well over a page, and over the
  // 64 KiB a stream reads at a time.
  await writeFile(join(session, 'api.d.ts'), linesOf(4700));
  await writeFile(join(session, 'small.ts'), linesOf(120));
  await writeFile(join(session, 'packages', 'main', 'loader.ts'), linesOf(310));
  await writeFile(join(home, 'notes.ts'), linesOf(42));
});

after(async () => {
  await rm(session, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

/**
 * A stand-in for setup()'s context, in a directory: just enough for the entry
 * point to load in full. `ran` runs every execute.after callback in the order
 * they were registered, as Open Code does, on an event, and gives it back.
 */
function host(directory = session) {
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

/** A page of a text file, as the read tool reports one (F48). */
const page = (content, offset, truncated, next) => ({ type: 'text-page', content, mime: 'video/mp2t', offset, truncated, ...(next === undefined ? {} : { next }) });

/** A whole file, as the read tool reports one under 50 KB read with neither offset nor limit (F48). */
const whole = (path, content) => ({ type: 'file', uri: `file:///${path}`, name: path, content, encoding: 'utf8', mime: 'video/mp2t' });

/**
 * execute.after's event for a read that ran, as Open Code reports it (F48,
 * F50): the output, and the text the model reads — a header, the lines with
 * their numbers, and the tool's note when lines follow.
 */
function read(input, output) {
  const lines = output.type === 'list-page' ? output.entries.map((entry) => entry.path) : output.content === '' ? [] : output.content.split('\n');
  const start = output.offset ?? 1;
  const body = [`Read file ${input.path}, lines ${start}-${start + lines.length - 1}`, ...lines.map((line, i) => `${start + i}: ${line}`)];
  if (output.truncated && output.next !== undefined) body.push(`[Output truncated. Continue reading with offset: ${output.next}]`);
  return {
    tool: 'read',
    sessionID: 'ses_read',
    agent: 'build',
    messageID: 'msg_read',
    id: 'call_read',
    input,
    status: 'completed',
    result: { output, content: [text(body.join('\n'))], metadata: { truncated: output.type === 'file' ? false : output.truncated } },
  };
}

/**
 * execute.after's event for a grep that ran (F52): the matches, each line
 * with its line feed, the text the model reads, and whether the limit cut
 * them.
 */
function grep(input, lines, truncated) {
  const matches = lines.map((line, i) => ({ entry: { path: 'api.d.ts', type: 'file' }, line: i + 1, offset: 0, text: `${line}\n`, submatches: [] }));
  const body = [`Found ${matches.length} matches`, `${join(session, 'api.d.ts')}:`, ...matches.map((match) => `  Line ${match.line}: ${match.text}`)];
  if (truncated) body.push('', `(Results are truncated: showing first ${matches.length} results. Consider using a more specific path or pattern.)`);
  return {
    tool: 'grep',
    sessionID: 'ses_grep',
    agent: 'build',
    messageID: 'msg_grep',
    id: 'call_grep',
    input,
    status: 'completed',
    result: { output: matches, content: [text(body.join('\n'))], metadata: { matches: matches.length, truncated } },
  };
}

/** The lines a search matched, as the grep tool keeps them: each with its line feed. */
const matched = (lines) => lines.map((line) => `${line}\n`).join('');

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

describe('the rule of 06-hooks.md for post-read, on the read and grep tools', () => {
  // What it protects: a member past the end of a page, read as absent.
  test('HK-15: a page that ends inside a block gets the rule, in the result', async (t) => {
    const { ran: hooks, log } = await loaded(t);
    const content = open(2000);

    const { before, now } = await hooked(hooks, read({ path: 'api.d.ts' }, page(content, 1, true, 2001)));

    const said = added(before, now);
    assert.equal(said, SAYS(['Read lines 1-2000 of 4700'], content));
    assert.match(said, /`Read lines 1-2000 of 4700`/);
    assert.match(said, /1 `\{` opened, 0 closed/);
    assert.match(said, /unread, not absent/);
    assert.deepEqual(log(), []);
  });

  test('stays quiet on a whole file, and on a page that closed its block', async (t) => {
    const { ran: hooks, log } = await loaded(t);

    for (const event of [read({ path: 'api.d.ts' }, whole('api.d.ts', CUT)), read({ path: 'api.d.ts', offset: 4500, limit: 4 }, page(WHOLE, 4500, true, 4504))]) {
      const { before, now } = await hooked(hooks, event);
      assert.deepEqual(now, before, event.result.output.type);
    }
    assert.deepEqual(log(), []);
  });

  // Claude Code's Grep had two windows: context around a match, and a cap on
  // the matches. The grep tool has the cap alone (F51).
  test('HK-15: a search the limit cut that ends inside a block gets the rule, in the result', async (t) => {
    const { ran: hooks, log } = await loaded(t);
    const lines = CUT.split('\n');

    const { before, now } = await hooked(hooks, grep({ pattern: 'env|appName', path: 'api.d.ts', limit: 2 }, lines, true));

    const said = added(before, now);
    assert.equal(said, SAYS(['Grep head_limit 2'], matched(lines)));
    assert.match(said, /`Grep head_limit 2`/);
    assert.deepEqual(log(), []);
  });

  // There is no mode but the lines that matched (F51): a search outside
  // content mode cannot be made.
  test('stays quiet on a search that returned every match', async (t) => {
    const { ran: hooks, log } = await loaded(t);

    const { before, now } = await hooked(hooks, grep({ pattern: 'env|appName', path: 'api.d.ts' }, CUT.split('\n'), false));

    assert.deepEqual(now, before);
    assert.deepEqual(log(), []);
  });

  test('leaves other tools alone, whatever their result shows', async (t) => {
    const { ran: hooks, log } = await loaded(t);

    for (const tool of ['glob', 'webfetch', 'todowrite', 'Read']) {
      const event = { ...read({ path: 'api.d.ts', limit: 2 }, page(CUT, 1, true, 3)), tool };
      const { before, now } = await hooked(hooks, event);
      assert.deepEqual(now, before, tool);
    }
    assert.deepEqual(log(), []);
  });

  // Run from the session's directory, which is never the plugin: the path is
  // the plugin's own, absolute, and the rule is there.
  test('names the rule by the absolute path of the plugin it runs from', async (t) => {
    const { ran: hooks } = await loaded(t);

    const { before, now } = await hooked(hooks, read({ path: 'api.d.ts', limit: 2 }, page(CUT, 1, true, 3)));

    const said = added(before, now);
    assert.ok(said.endsWith(`See "A window that ends inside a block" in ${RULE}.`), said);
    assert.match(await readFile(RULE, 'utf8'), /^## A window that ends inside a block$/m);
  });
});

// The pages the read tool gives, as T1.5 saw them (r1–r11, d1), each with a
// block it leaves open: those it reports as a window carry the rule, naming
// the lines and how many the file has; the rest leave the result alone.
describe('every window the read tool reports, and none it does not, through the bridge', () => {
  const WINDOWED = [
    ['the first page of a file over 50 KB, cut at 2000 lines', { path: 'api.d.ts' }, page(open(2000), 1, true, 2001), 'Read lines 1-2000 of 4700'],
    ['the first page of one cut at 50 KB', { path: 'api.d.ts' }, page(open(1155), 1, true, 1156), 'Read lines 1-1155 of 4700'],
    ['a page inside it', { path: 'api.d.ts', offset: 4501, limit: 30 }, page(open(30), 4501, true, 4531), 'Read lines 4501-4530 of 4700'],
    ['a page to its end', { path: 'api.d.ts', offset: 4690 }, page(open(11), 4690, false), 'Read lines 4690-4700 of 4700'],
    ['its last lines, by a negative offset', { path: 'api.d.ts', offset: -30 }, page(open(30), 4671, false), 'Read lines 4671-4700 of 4700'],
    ['an offset past the end: the last 100 lines', { path: 'small.ts', offset: 500 }, page(open(100), 21, false), 'Read lines 21-120 of 120'],
    ['a limit inside a small file', { path: 'small.ts', limit: 10 }, page(open(10), 1, true, 11), 'Read lines 1-10 of 120'],
  ];
  for (const [label, input, output, window] of WINDOWED) {
    test(`${label} → ${window}`, async (t) => {
      const { ran: hooks, log } = await loaded(t);

      const { before, now } = await hooked(hooks, read(input, output));

      assert.equal(added(before, now), SAYS([window], output.content));
      assert.deepEqual(log(), []);
    });
  }

  const QUIET = [
    // Under 50 KB with neither offset nor limit, a file comes back whole,
    // however many lines it has (r2): no window, and the model saw it all.
    ['a whole file of 3000 lines', { path: 'api.d.ts' }, whole('api.d.ts', open(3000))],
    // A line over 2000 characters is cut with no flag (r10); Claude Code's
    // post-read looked at the window alone, too.
    ['a whole file with a line cut at 2000 characters', { path: 'long.ts' }, whole('long.ts', `${'x'.repeat(2000)}... (line truncated to 2000 chars)\n{`)],
    ['a page of all of a file', { path: 'small.ts', offset: 1, limit: 2000 }, page(open(120), 1, false)],
    ['an empty page', { path: 'empty.txt', offset: 5 }, page('', 1, false)],
    ['a directory', { path: 'packages', limit: 1 }, { type: 'list-page', entries: [{ path: 'main/', type: 'directory' }], truncated: true, next: 2 }],
  ];
  for (const [label, input, output] of QUIET) {
    test(`${label} → nothing`, async (t) => {
      const { ran: hooks, log } = await loaded(t);

      const { before, now } = await hooked(hooks, read(input, output));

      assert.deepEqual(now, before);
      assert.deepEqual(log(), []);
    });
  }

  test('an image → nothing', async (t) => {
    const { ran: hooks, log } = await loaded(t);
    const event = read({ path: 'a.png' }, { type: 'file', uri: 'file:///a.png', name: 'a.png', content: 'e3t7', encoding: 'base64', mime: 'image/png' });
    event.result.content = [text('Image read successfully'), { type: 'file', uri: 'data:image/png;base64,e3t7', mime: 'image/png', name: 'a.png' }];

    const { before, now } = await hooked(hooks, event);

    assert.deepEqual(now, before);
    assert.deepEqual(log(), []);
  });
});

// For a page with lines after it, the count is the bridge's, made the way the
// read tool makes it (F265): a line for each line feed, and one for a last
// line without one. These are the files T4.10's probe had the host count.
describe('how many lines a file has, as the read tool counts them', () => {
  for (const [label, content, total] of [
    ['line feeds', 'a {\nb\nc\n', 3],
    ['carriage returns and no last line feed', 'a {\r\nb\r\nc', 3],
    ['a byte order mark', '﻿a {\nb\n', 2],
    ['blank lines at the end', 'a {\n\n\n', 3],
  ]) {
    test(`${label}: ${total}`, async (t) => {
      const file = join(session, `count-${label.replaceAll(' ', '-')}.txt`);
      await writeFile(file, content);
      t.after(() => rm(file, { force: true }));
      const { ran: hooks, log } = await loaded(t);

      // A page the limit cut at one line: lines follow, and only the file
      // says how many.
      const { before, now } = await hooked(hooks, read({ path: file, limit: 1 }, page('a {', 1, true, 2)));

      assert.equal(added(before, now), SAYS([`Read lines 1-1 of ${total}`], 'a {'));
      assert.deepEqual(log(), []);
    });
  }

  test('a file over the 64 KiB a stream reads at a time', async (t) => {
    const file = join(session, 'many.ts');
    await writeFile(file, `${'export const something: string;\n'.repeat(9000)}export namespace last {`);
    t.after(() => rm(file, { force: true }));
    const { ran: hooks } = await loaded(t);

    const { before, now } = await hooked(hooks, read({ path: 'many.ts', offset: 9001 }, page('export namespace last {', 9001, false)));
    assert.equal(added(before, now), SAYS(['Read lines 9001-9001 of 9001'], 'export namespace last {'));

    const cut = await hooked(hooks, read({ path: 'many.ts', limit: 2 }, page(CUT, 1, true, 3)));
    assert.equal(added(cut.before, cut.now), SAYS(['Read lines 1-2 of 9001'], CUT));
  });
});

// The file counted is the one the tool read: the path as the model wrote it,
// resolved as the tool resolves it — from the session's directory, `~` from
// the home directory (F265). Each file has its own count, which proves which
// one was read.
describe('which file is counted', () => {
  test('a path relative to the session', async (t) => {
    const { ran: hooks, log } = await loaded(t);

    const { before, now } = await hooked(hooks, read({ path: 'packages/main/loader.ts', limit: 2 }, page(CUT, 1, true, 3)));

    assert.equal(added(before, now), SAYS(['Read lines 1-2 of 310'], CUT));
    assert.deepEqual(log(), []);
  });

  test('an absolute path', async (t) => {
    const { ran: hooks } = await loaded(t);

    const { before, now } = await hooked(hooks, read({ path: join(session, 'small.ts'), limit: 2 }, page(CUT, 1, true, 3)));

    assert.equal(added(before, now), SAYS(['Read lines 1-2 of 120'], CUT));
  });

  test("a path from the home directory, Open Code's", async (t) => {
    const previous = process.env.OPENCODE_TEST_HOME;
    process.env.OPENCODE_TEST_HOME = home;
    t.after(() => (previous === undefined ? delete process.env.OPENCODE_TEST_HOME : (process.env.OPENCODE_TEST_HOME = previous)));
    const { ran: hooks } = await loaded(t);

    const { before, now } = await hooked(hooks, read({ path: '~/notes.ts', limit: 2 }, page(CUT, 1, true, 3)));

    assert.equal(added(before, now), SAYS(['Read lines 1-2 of 42'], CUT));
  });
});

describe('what only Open Code has', () => {
  // A Read or a Grep that failed went to PostToolUseFailure, which pdkit never
  // registered. Open Code reports one with status "error" and no result
  // (F265): a missing file, a binary one, a pattern that does not parse.
  test('only after a call that succeeded', async (t) => {
    const { ran: hooks, log } = await loaded(t);

    for (const [tool, input, message] of [
      ['read', { path: 'missing.ts', limit: 2 }, 'File not found: missing.ts'],
      ['read', { path: 'bin.dat' }, 'Cannot read binary file: bin.dat'],
      ['grep', { pattern: '(' }, 'Invalid regex pattern: rg: regex parse error'],
    ]) {
      const event = { tool, sessionID: 'ses_x', agent: 'build', messageID: 'msg_x', id: 'call_x', input, status: 'error', error: new Error(message) };
      await hooks(event);
      assert.equal('result' in event, false, message);
    }
    assert.deepEqual(log(), []);
  });

  // The grep tool's limit is 100 when the model names none (F51): the rule
  // speaks up after a broad search whose last lines open a block.
  test('the default limit is a window too', async (t) => {
    const { ran: hooks } = await loaded(t);
    const lines = open(100).split('\n');

    const { before, now } = await hooked(hooks, grep({ pattern: 'export' }, lines, true));

    assert.equal(added(before, now), SAYS(['Grep head_limit 100'], matched(lines)));
  });

  // Open Code strips the keys a model sends for context before any hook (F51,
  // F265); were one left, the bridge would not pass it on: the tool applied
  // none.
  test('context a model asked grep for is no window: the tool gives none', async (t) => {
    const { ran: hooks, log } = await loaded(t);

    const { before, now } = await hooked(hooks, grep({ pattern: 'namespace env', '-A': 60, context: 5 }, CUT.split('\n'), false));

    assert.deepEqual(now, before);
    assert.deepEqual(log(), []);
  });

  // What the tool read, not what the result holds by now: the text another
  // plugin added, the line numbers, the paths, are no part of the read.
  test('the braces counted are the lines read, not the text around them', async (t) => {
    const { ran: hooks } = await loaded(t);

    const page2 = read({ path: 'api.d.ts', limit: 2 }, page(CUT, 1, true, 3));
    page2.result.content.push(text('} closed by some other plugin'));
    const readCut = await hooked(hooks, page2);
    assert.equal(added(readCut.before, readCut.now), SAYS(['Read lines 1-2 of 4700'], CUT));

    // The header names the file as the model wrote it, braces and all (F50).
    const named = await hooked(hooks, read({ path: 'src/{a}}.ts', offset: 4699 }, page(CUT, 4699, false)));
    assert.match(named.before.content[0].text, /^Read file src\/\{a\}\}\.ts, lines 4699-4700\n/);
    assert.equal(added(named.before, named.now), SAYS(['Read lines 4699-4700 of 4700'], CUT));

    const search = grep({ pattern: 'env', limit: 2 }, CUT.split('\n'), true);
    search.result.content = [text(`Found 2 matches\n/work/{weird}}/api.d.ts:\n  Line 1: ${CUT}`)];
    const grepCut = await hooked(hooks, search);
    assert.equal(added(grepCut.before, grepCut.now), SAYS(['Grep head_limit 2'], matched(CUT.split('\n'))));
  });

  // The read tool notes that lines follow, before the hook (F50); the rule
  // comes after its note.
  test("the rule comes after the tool's note that lines follow", async (t) => {
    const { ran: hooks } = await loaded(t);

    const { now } = await hooked(hooks, read({ path: 'api.d.ts', limit: 2 }, page(CUT, 1, true, 3)));

    assert.match(now.content[0].text, /\[Output truncated\. Continue reading with offset: 3\]$/);
    assert.match(now.content.at(-1).text, /^\npdkit: this output went through a window/);
  });
});

/** Text, as a regular expression matches it. */
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The one line a call the bridge could not look at leaves in the log:
 * post-read's, saying `problem`. post-write, post-claim and post-bash run on
 * the same call and do not look at a read, so they have nothing to say, even
 * when the failure is the environment's.
 */
const allowing = (log, problem) => {
  assert.equal(log().length, 1, log().join('\n'));
  assert.match(log()[0], new RegExp(`^opencode-pdkit: pdkit: hook "post-read" ${problem}.*; allowing$`, 's'));
};

// §13 DV9: a page with lines after it needs the file's count, and the bridge
// never makes one up. A file it cannot count — not on disk, gone, or shorter
// by now than the page showed — leaves the result as the tool gave it, with
// a line in the log, as any failure of the bridge on a hook that fails open.
describe('a file the bridge cannot count costs the rule, and says why', () => {
  test('a file gone since it was read', async (t) => {
    const { ran: hooks, log } = await loaded(t);

    const { before, now } = await hooked(hooks, read({ path: 'gone.d.ts', limit: 2 }, page(CUT, 1, true, 3)));

    assert.deepEqual(now, before);
    allowing(log, 'failed in the hook bridge \\(ENOENT: ');
  });

  // A skill's file is the host's own, in memory; there is none on disk.
  test("a page of a skill's file", async (t) => {
    const { ran: hooks, log } = await loaded(t);

    const { before, now } = await hooked(hooks, read({ path: 'skill://pd:exec/SKILL.md', limit: 2 }, page(CUT, 1, true, 3)));

    assert.deepEqual(now, before);
    allowing(log, 'failed in the hook bridge \\(ENOENT: ');
  });

  test('a file shorter by now than the page showed', async (t) => {
    const { ran: hooks, log } = await loaded(t);

    const { before, now } = await hooked(hooks, read({ path: 'small.ts', offset: 119, limit: 2 }, page(CUT, 119, true, 121)));

    assert.deepEqual(now, before);
    allowing(log, `failed in the hook bridge \\(${escaped(join(session, 'small.ts'))} has 120 lines now, and the read showed it had at least 121\\)`);
  });

  // A page that reaches the end says how many lines the file has itself.
  test('a page that reaches the end needs no file: the rule, though the file is gone', async (t) => {
    const { ran: hooks, log } = await loaded(t);

    const { before, now } = await hooked(hooks, read({ path: 'gone.d.ts', offset: 4699 }, page(CUT, 4699, false)));

    assert.equal(added(before, now), SAYS(['Read lines 4699-4700 of 4700'], CUT));
    assert.deepEqual(log(), []);
  });
});

/**
 * A copy of the plugin with some files replaced, loaded in the session's directory.
 *
 * @param {import('node:test').TestContext} t
 * @param {Record<string, string|((text: string) => string)|null>} files
 */
async function broken(t, files) {
  const dir = await mkdtemp(join(tmpdir(), 'pdkit-post-read-plugin-'));
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
  const { ctx, ran: hooks } = host(session);
  await copy.setup(ctx);
  return { ran: hooks, log };
}

// post-read fails open (FAIL_CLOSED names pre-bash alone), and after a tool
// failing open is more than letting the call through: the read has happened,
// and the bridge must not turn it into an error (F33). Each case is a read a
// working check speaks up about — a page to the end of the file, which needs
// nothing from disk — so a result left as the tool gave it is the failure's
// doing.
describe('no answer leaves the result as the tool gave it, and says why', () => {
  /** A read the check has something to say about, and its result after the hooks. */
  async function unchanged(hooks) {
    const { before, now } = await hooked(hooks, read({ path: 'api.d.ts', offset: 4699 }, page(CUT, 4699, false)));
    assert.deepEqual(now, before);
  }

  test('no node on the PATH of the server', { skip: !POSIX && 'T10.10' }, async (t) => {
    const { ran: hooks, log } = await loaded(t);
    const path = process.env.PATH;
    process.env.PATH = session;
    t.after(() => (process.env.PATH = path));

    await unchanged(hooks);
    allowing(log, 'cannot run: "node" was not found on the PATH of the process that runs hooks \\(ENOENT\\)');
  });

  test('a session directory that does not exist', async (t) => {
    const { ran: hooks, log } = await loaded(t, join(session, 'missing'));

    await unchanged(hooks);
    allowing(log, 'cannot run: its working directory does not exist: ');
  });

  test('a CLI that does not load: exit 1', async (t) => {
    const { ran: hooks, log } = await broken(t, { 'lib/cli.js': 'this is not valid javascript {{{\n' });

    await unchanged(hooks);
    allowing(log, 'exited with code 1 \\(SyntaxError: ');
  });

  test('a handler that does not load: runHook allows, as under Claude Code', async (t) => {
    const { ran: hooks, log } = await broken(t, { 'lib/hooks/post-read.js': 'this is not valid javascript {{{\n' });

    await unchanged(hooks);
    allowing(log, 'handler "post-read\\.js" is unavailable');
  });

  test('a handler that throws: runHook allows, as under Claude Code', async (t) => {
    const { ran: hooks, log } = await broken(t, { 'lib/hooks/post-read.js': "export async function handle() { throw new Error('read broke'); }\n" });

    await unchanged(hooks);
    allowing(log, 'failed \\(read broke\\)');
  });

  test('a handler that hangs: stopped at the deadline', async (t) => {
    const { ran: hooks, log } = await broken(t, {
      'lib/hooks/post-read.js': 'export function handle() { return new Promise(() => setInterval(() => {}, 1000)); }\n',
      'lib/hooks/runner.js': (source) => source.replace('export const DEADLINE_MS = 10_000;', 'export const DEADLINE_MS = 2_000;'),
    });

    await unchanged(hooks);
    allowing(log, 'gave no answer within 2s and was stopped');
  });

  test('a bridge that fails before the runner is reached', async (t) => {
    const log = logOf(t);
    const { ctx, ran: hooks } = host(session);
    await plugin.setup(ctx);
    Object.defineProperty(ctx, 'location', {
      get() {
        throw new Error('no location today');
      },
    });

    await unchanged(hooks);
    allowing(log, 'failed in the hook bridge \\(no location today\\)');
  });

  // The location is read for a run, after a hook has chosen the call: a read
  // of a whole file needs none, and costs no line without one.
  test('and a read no post hook looks at says nothing without a location', async (t) => {
    const log = logOf(t);
    const { ctx, ran: hooks } = host(session);
    await plugin.setup(ctx);
    Object.defineProperty(ctx, 'location', {
      get() {
        throw new Error('no location today');
      },
    });

    const { before, now } = await hooked(hooks, read({ path: 'api.d.ts' }, whole('api.d.ts', CUT)));

    assert.deepEqual(now, before);
    assert.deepEqual(log(), []);
  });
});
