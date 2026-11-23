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

// Tests for the comment pattern of maintainer-rules, and for
// lib/preflight/comments.js, which finds the comments it reads.
//
// The rule is the plugin's own (agents/pd-implementer.md, "Write no comments
// in the code"), stricter than the nit in section 4 of the maintainer's rules:
// a comment the branch adds fails, anywhere in the code, but for the three a
// rule asks for. The pattern is strict, so a false hit is a push nobody can
// make: what is not a comment — a `//` in a string, a template literal, a
// regular expression, a URL in Svelte markup — is held to passing as firmly
// as each kind of comment is held to failing.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { cleanup, commitAll, git, initRepo, writeFiles } from './helpers/repo-fixture.js';
import { CODE, commentsIn } from '../lib/preflight/comments.js';
import { run, scan } from '../lib/preflight/checks/maintainer-rules.js';
import { checkSpdx, isSpdxHeader, spdxHeader } from '../lib/upstream.js';

const COMMENT = 'a comment';
const OURS = 'agents/pd-implementer.md';
const MAIN = 'packages/main/src/registry.ts';

/**
 * The lines of `text` the comment pattern reports, read as a file a branch
 * adds in full unless `where` says more.
 *
 * @param {string} file
 * @param {string} text
 * @param {object} [where]
 * @returns {string[]}
 */
const commented = (file, text, where = {}) =>
  scan(file, text.split('\n'), 2026, where)
    .filter((hit) => hit.label === COMMENT)
    .map((hit) => hit.line);

/**
 * Every label a line hits, in a file the branch adds.
 *
 * @param {string} file
 * @param {string} line
 * @returns {string[]}
 */
const labels = (file, line) => scan(file, [line], 2026).map((hit) => hit.label);

describe('where the comments of a file are', () => {
  test('a line comment, a block, JSDoc and a comment after code, each with its lines', () => {
    const source = ['// one', 'const a = 1; /* two */', '/**', ' * three', ' */', 'run(); // four'].join('\n');
    assert.deepEqual(commentsIn('lib/a.ts', source), [
      { kind: 'line', start: 1, end: 1, text: '// one' },
      { kind: 'block', start: 2, end: 2, text: '/* two */' },
      { kind: 'jsdoc', start: 3, end: 5, text: '/**\n * three\n */' },
      { kind: 'line', start: 6, end: 6, text: '// four' },
    ]);
  });

  test('a string, a template literal and a regular expression hold no comment', () => {
    const source = [
      "const url = 'https://podman.io'; const glob = \"/* not */\";",
      'const yaml = `',
      'url: https://example.test',
      '/* still the template */',
      '${"// in an expression"} and ${`a nested // template`}',
      '`;',
      'const scheme = /https?:\\/\\//;',
      'const slash = /[/*]/g.test(text);',
      'const half = total / 2; // real',
    ].join('\n');
    assert.deepEqual(commentsIn('lib/a.ts', source), [{ kind: 'line', start: 9, end: 9, text: '// real' }]);
  });

  test('a shebang is not a regular expression that swallows the header under it', () => {
    const source = ['#!/usr/bin/env node', '/* header */', 'main();'].join('\n');
    assert.deepEqual(commentsIn('scripts/run.mjs', source), [{ kind: 'block', start: 2, end: 2, text: '/* header */' }]);
  });

  test('in Svelte: comments in the script and the markup, none in the style or in markup text', () => {
    const source = [
      '<script lang="ts" generics="T extends Map<string, number>">',
      "const link = 'https://podman.io'; // in the script",
      '</script>',
      '<!-- in the markup,',
      '     over two lines -->',
      '<a href="https://podman.io">https://podman.io // not a comment</a>',
      '<style>',
      '/* css */',
      '</style>',
    ].join('\n');
    assert.deepEqual(commentsIn('packages/renderer/src/lib/A.svelte', source), [
      { kind: 'line', start: 2, end: 2, text: '// in the script' },
      { kind: 'html', start: 4, end: 5, text: '<!-- in the markup,\n     over two lines -->' },
    ]);
  });

  test('HTML is read as Svelte is, and JSX expressions as script', () => {
    assert.deepEqual(commentsIn('packages/renderer/index.html', '<body>\n<!-- a note -->\n<script>run(); // b</script>\n</body>'), [
      { kind: 'html', start: 2, end: 2, text: '<!-- a note -->' },
      { kind: 'line', start: 3, end: 3, text: '// b' },
    ]);
    assert.deepEqual(commentsIn('website/src/components/Card.tsx', 'return (\n  <div>{/* chevron */}</div>\n);'), [
      { kind: 'block', start: 2, end: 2, text: '/* chevron */' },
    ]);
  });

  test('the files it reads are code; documents, styles and data are not', () => {
    for (const path of ['a.ts', 'a.d.ts', 'a.js', 'a.mjs', 'a.cjs', 'a.tsx', 'a.jsx', 'A.svelte', 'index.html']) {
      assert.ok(CODE.test(`packages/x/src/${path}`), path);
    }
    for (const path of ['README.md', 'ci.yml', 'app.css', 'package.json']) {
      assert.ok(!CODE.test(`packages/x/${path}`), path);
    }
  });
});

describe('maintainer-rules: a comment the branch adds', () => {
  test('each kind of comment fails, as a rule the plugin made strict', () => {
    assert.deepEqual(scan(MAIN, ['// keep in sync with the list'], 2026), [
      { label: COMMENT, section: 4, strict: true, source: OURS, line: '// keep in sync with the list' },
    ]);
    assert.deepEqual(commented(MAIN, 'const limit = 3; // the retries'), ['const limit = 3; // the retries']);
    assert.deepEqual(commented(MAIN, '/* a block */'), ['/* a block */']);
    assert.deepEqual(commented(MAIN, '/**\n * Starts the watcher.\n */\nexport class Watcher {}'), ['/**', ' * Starts the watcher.', ' */']);
    assert.deepEqual(commented('packages/renderer/src/lib/Card.svelte', '<script lang="ts">\n// in the script\n</script>\n<!-- in the markup -->\n<div></div>'), [
      '// in the script',
      '<!-- in the markup -->',
    ]);
    assert.deepEqual(commented('packages/ui/src/lib/Alert.svelte', '<!-- wrap anywhere:\n     an error is text nobody chose the length of -->\n<p></p>'), [
      '<!-- wrap anywhere:',
      '     an error is text nobody chose the length of -->',
    ]);
    assert.deepEqual(commented('packages/renderer/index.html', '<!-- a note -->'), ['<!-- a note -->']);
    assert.deepEqual(commented('website/src/components/Card.tsx', '<div>{/* chevron */}</div>'), ['<div>{/* chevron */}</div>']);
  });

  test('a directive is a comment too', () => {
    for (const line of [
      '// @ts-expect-error a tab without `selected` must not typecheck',
      '// @ts-ignore',
      '/// <reference types="vite/client" />',
      '// prettier-ignore',
      '/* eslint-enable import/no-duplicates */',
    ]) {
      assert.deepEqual(commented(MAIN, line), [line], line);
    }
    assert.deepEqual(commented('packages/ui/src/lib/Table.svelte', '<!-- svelte-ignore a11y_click_events_have_key_events -->\n<div></div>'), [
      '<!-- svelte-ignore a11y_click_events_have_key_events -->',
    ]);
  });

  test('in every code file of the repository, and in no other file', () => {
    for (const file of [
      'extensions/podman/packages/extension/src/machine.ts',
      'tests/playwright/src/specs/pod.spec.ts',
      'scripts/build.js',
      'storybook/src/stories/button.mjs',
      'packages/main/vite.config.cjs',
      'packages/extension-api/src/extension-api.d.ts',
    ]) {
      assert.deepEqual(commented(file, '// a note'), ['// a note'], file);
    }
    for (const file of ['README.md', '.github/workflows/ci.yml', 'packages/renderer/src/app.css', 'package.json']) {
      assert.deepEqual(labels(file, '<!-- a note --> // a note /* a note */'), [], file);
    }
  });

  test('what only looks like a comment passes', () => {
    for (const line of [
      "const url = 'https://podman.io';",
      'const glob = "/* not */";',
      'const tag = `// ${name}`;',
      'const scheme = /https?:\\/\\//;',
      'const half = total / 2;',
    ]) {
      assert.deepEqual(commented(MAIN, line), [], line);
    }
    assert.deepEqual(commented('packages/renderer/src/lib/Link.svelte', '<a href="https://podman.io">https://podman.io</a>'), []);
  });

  test('a line added inside a comment opened above it fails; one inside a template literal does not', () => {
    const jsdoc = ['/**', ' * Starts the watcher.', ' * Stops it on dispose.', ' */', 'export class Watcher {}'].join('\n');
    assert.deepEqual(commented(MAIN, ' * Stops it on dispose.', { source: jsdoc, numbers: [3] }), [' * Stops it on dispose.']);

    const template = ['const page = `', '<a href="https://podman.io">', '// the second line', '`;'].join('\n');
    assert.deepEqual(commented(MAIN, '// the second line', { source: template, numbers: [3] }), []);
  });

  test('a comment the diff only moves is not one the branch wrote; an edited one is', () => {
    assert.deepEqual(commented(MAIN, '    // the registry keeps the first one', { removed: ['  // the registry keeps the first one'] }), []);
    assert.deepEqual(commented(MAIN, 'start(2); // the order matters', { removed: ['start(1); // the order matters'] }), []);
    assert.deepEqual(commented(MAIN, '// the registry keeps the last one', { removed: ['// the registry keeps the first one'] }), [
      '// the registry keeps the last one',
    ]);
  });

  test('a blank line inside a comment is not a hit of its own', () => {
    assert.deepEqual(commented(MAIN, '/*\n\n the note\n*/'), ['/*', ' the note', '*/']);
  });
});

describe('maintainer-rules: the comments a rule asks for', () => {
  test('the license header of a new file, in the house format, as the spdx check reads it', () => {
    const header = spdxHeader(2026);
    assert.equal(isSpdxHeader(header), true);
    assert.equal(checkSpdx({ path: 'a.ts', content: `${header}export class A {}\n` }).present, true);
    assert.equal(isSpdxHeader('/* Copyright (C) 2026 Red Hat, Inc. */'), false, 'no identifier, not the house block');

    assert.deepEqual(commented(MAIN, `${header}export class A {}`, { created: true }), []);
    assert.deepEqual(commented('scripts/build.mjs', `#!/usr/bin/env node\n${header}main();`, { created: true }), []);
    assert.deepEqual(commented('packages/renderer/src/lib/Card.svelte', `<!--\n${header}-->\n\n<script lang="ts">\n</script>`, { created: true }), []);
  });

  test('a header in a file that already existed, a header that is not first, or another one fails', () => {
    const header = spdxHeader(2026);
    const lines = header.split('\n').filter((line) => line !== '');
    assert.deepEqual(commented(MAIN, `${header}export class A {}`), lines, 'added to a file that existed');
    assert.deepEqual(commented(MAIN, `// a note\n${header}export class A {}`, { created: true }), ['// a note', ...lines]);
    assert.deepEqual(commented(MAIN, '/* Copyright (C) 2026 Someone Else */\nexport class A {}', { created: true }), ['/* Copyright (C) 2026 Someone Else */']);
  });

  test('JSDoc in the extension API, a new member or a corrected one; nothing else there', () => {
    const API = 'packages/extension-api/src/extension-api.d.ts';
    assert.deepEqual(commented(API, '    /**\n     * Whether the watcher follows links.\n     * @default false\n     */\n    followLinks?: boolean;'), []);

    const existing = ['    /**', '     * An absolute path in which the extension can store state.', '     * The directory is created before the extension is activated.', '     */', '    readonly storagePath: string;'].join('\n');
    assert.deepEqual(commented(API, '     * The directory is created before the extension is activated.', { source: existing, numbers: [3] }), []);

    assert.deepEqual(commented(API, '    // the watcher follows links'), ['    // the watcher follows links']);
    assert.deepEqual(commented(API, '    /* the watcher follows links */'), ['    /* the watcher follows links */']);
  });

  test('the eslint-disable section 4 allows on an empty interface, anywhere', () => {
    for (const file of [MAIN, 'extensions/kind/src/options.ts']) {
      assert.deepEqual(labels(file, '// eslint-disable-next-line @typescript-eslint/no-empty-object-type'), [], file);
      assert.deepEqual(labels(file, '/* eslint-disable @typescript-eslint/no-empty-interface */'), [], file);
    }
  });

  test('any other eslint-disable is reported once: by its own pattern under packages/, as a comment elsewhere', () => {
    assert.deepEqual(labels(MAIN, '// eslint-disable-next-line @typescript-eslint/no-explicit-any'), ['eslint-disable']);
    assert.deepEqual(labels('packages/renderer/src/lib/Html.svelte', '<!-- eslint-disable-next-line svelte/no-at-html-tags -->'), ['eslint-disable']);
    assert.deepEqual(labels('tests/playwright/src/specs/pod.spec.ts', '// eslint-disable-next-line sonarjs/no-fixed-wait-in-tests'), [COMMENT]);
  });
});

describe('maintainer-rules reads each changed file at the ref', () => {
  test('the comments the branch wrote fail, on the lines they are on, and the rest of the diff passes', async () => {
    const root = await initRepo('pdkit-maintainer-comments-');
    try {
      await writeFiles(root, {
        'packages/main/src/watcher.ts': [
          'export class Watcher {',
          '  /**',
          '   * Starts the watcher.',
          '   */',
          '  start(): void {',
          '    // the first event is the scan',
          '    this.scan();',
          '  }',
          '}',
          '',
        ].join('\n'),
        'packages/main/src/page.ts': ['export const PAGE = `', '<a href="https://podman.io">', '`;', ''].join('\n'),
        'packages/main/src/counter.ts': ['export class Counter {', '  count = 0;', '  next(): void {', '  }', '}', ''].join('\n'),
      });
      await commitAll(root, 'chore: base');
      await git(['checkout', '-q', '-b', 'work'], root);

      await writeFiles(root, {
        'packages/main/src/watcher.ts': [
          'export class Watcher {',
          '  /**',
          '   * Starts the watcher.',
          '   * Stops it on dispose.',
          '   */',
          '  start(): void {',
          '    if (this.enabled) {',
          '      // the first event is the scan',
          '      this.scan();',
          '    }',
          '  }',
          '}',
          '',
        ].join('\n'),
        'packages/main/src/page.ts': ['export const PAGE = `', '<a href="https://podman.io">', '// the link opens outside', '`;', ''].join('\n'),
        'packages/main/src/counter.ts': ['export class Counter {', '  count = 0;', '  next(): void {', '++this.count;', '    // keep in sync with the list', '  }', '}', ''].join('\n'),
        'packages/main/src/registry.ts': `${spdxHeader(2026)}export class Registry {}\n// the registry keeps the first one\n`,
      });
      await commitAll(root, 'feat(main): watch');

      const result = await run({ base: 'main', ref: 'HEAD', repoRoot: root }, { year: 2026 });
      const comments = result.hits.filter((hit) => hit.label === COMMENT);

      assert.equal(result.status, 'fail');
      assert.deepEqual(
        comments.map((hit) => [hit.path, hit.line]),
        [
          ['packages/main/src/counter.ts', '// keep in sync with the list'],
          ['packages/main/src/registry.ts', '// the registry keeps the first one'],
          ['packages/main/src/watcher.ts', '* Stops it on dispose.'],
        ],
        'the header, the template literal and the re-indented comment pass',
      );
      assert.ok(comments.every((hit) => hit.strict && hit.section === 4 && hit.source === OURS));
      assert.match(result.summary, /^a comment ×3 \(§4\)$/);
      assert.match(result.output, /^a comment — §4, made strict by agents\/pd-implementer\.md$/m);
      assert.match(result.remedy, /the plugin's own rule \(agents\/pd-implementer\.md\)/);
      assert.match(result.remedy, /delete it, and say why the code changed in the commit message and the PR body/);
      assert.doesNotMatch(result.remedy, /upstream's review agent raises each of these/, 'no upstream rule broke');
    } finally {
      await cleanup(root);
    }
  });

  test('a comment moved to another file passes, and the remedy speaks only of the rules that broke', async () => {
    const root = await initRepo('pdkit-maintainer-comments-moved-');
    const cards = (extra) =>
      `${spdxHeader(2026)}export class Cards {\n  // a card per started provider\n  of(providers: unknown[]): unknown[] {\n    return providers as any;\n  }\n${extra}}\n`;
    try {
      await writeFiles(root, {
        'packages/renderer/src/lib/Card.svelte': ['<script lang="ts">', '// a card per started provider', 'const cards = $derived(providers);', '</script>', ''].join('\n'),
      });
      await commitAll(root, 'chore: base');
      await git(['checkout', '-q', '-b', 'work'], root);

      await writeFiles(root, {
        'packages/renderer/src/lib/Card.svelte': ['<script lang="ts">', "import { Cards } from '/@/lib/cards';", 'const cards = $derived(new Cards().of(providers));', '</script>', ''].join('\n'),
        'packages/renderer/src/lib/cards.ts': cards(''),
      });
      await commitAll(root, 'refactor(renderer): cards');

      const moved = await run({ base: 'main', ref: 'HEAD', repoRoot: root }, { year: 2026 });
      assert.equal(moved.status, 'fail');
      assert.deepEqual(moved.hits.filter((hit) => hit.label === COMMENT), [], 'moved with its code');
      assert.equal(moved.summary, 'any ×1 (§4)');
      assert.match(moved.remedy, /^upstream's review agent raises each of these as an `issue:`/);
      assert.doesNotMatch(moved.remedy, /agents\/pd-implementer\.md/, 'no comment broke the rule, so nothing is said of it');

      await writeFiles(root, { 'packages/renderer/src/lib/cards.ts': cards('  // sorted by name\n') });
      await commitAll(root, 'refactor(renderer): sorted');

      const both = await run({ base: 'main', ref: 'HEAD', repoRoot: root }, { year: 2026 });
      assert.equal(both.summary, 'any ×1 (§4), a comment ×1 (§4)');
      assert.match(both.remedy, /^upstream's review agent raises each of these as an `issue:`/);
      assert.match(both.remedy, /the plugin's own rule \(agents\/pd-implementer\.md\)/);
      assert.match(both.remedy, /fix the code, then run preflight again$/);
    } finally {
      await cleanup(root);
    }
  });
});
