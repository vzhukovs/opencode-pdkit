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

// Preflight check: maintainer rules
//
// The greppable part of knowledge/maintainer-rules.md, in the added lines.
// Those are the rules upstream's review agent applies to every pull request,
// and a pull request that breaks one comes back with an `issue:` on it.
//
// Two kinds of pattern, and the kind comes from the rule, not from how sure the
// regular expression is:
//
// - **strict**: the rule admits no exception. `vi.spyOn` in a new unit test,
//   `as unknown as`, an exported function in packages/main. A hit fails the
//   check and blocks the push. The rule says "no", so the code changes; there
//   is no flag to wave a hit through, and none is coming.
// - **judged**: the rule carries its own condition. "No hand-written factories
//   *when automocking suffices*", "no dynamic *path-resolving* imports". A grep
//   cannot see whether the condition holds, so a hit warns and the self-review
//   (the `self-review` check, /pd:pr step 5) rules on each one.
//
// Added lines only, which is the calibration's own line: a violation that
// already existed in a touched file is not this branch's finding.
//
// Each pattern is scoped to the files its rule is about. `afterEach` in a
// Playwright spec or `export function` in an extension is not a violation,
// and a check that says it is would block work that upstream accepts.

import { capture } from '../../evidence.js';

/** @type {string} */
export const id = 'maintainer-rules';

/** @type {boolean} */
export const blocking = true;

const SPEC = /\.(?:spec|test)\.ts$/;
const SOURCE = /\.(?:ts|svelte)$/;
const PACKAGES = /^packages\//;
const MAIN_SOURCE = /^packages\/main\/src\/.*\.ts$/;
const RENDERER = /^packages\/(?:renderer|ui)\//;

/** Unit specs, not Playwright: tests/playwright has its own conventions. */
const unitSpec = (path) => SPEC.test(path) && PACKAGES.test(path);
/** Production code under packages/, specs excluded. */
const packageSource = (path) => SOURCE.test(path) && PACKAGES.test(path) && !SPEC.test(path) && !path.endsWith('.d.ts');
/** Anything under packages/, specs included. */
const packageCode = (path) => SOURCE.test(path) && PACKAGES.test(path);
/** Production code in packages/main, where Inversify owns the structure. */
const mainSource = (path) => MAIN_SOURCE.test(path) && !SPEC.test(path);
/** Renderer and UI production code. */
const rendererSource = (path) => packageSource(path) && RENDERER.test(path);

const NODE_BUILTINS = 'fs|path|os|child_process|crypto|url|util|events|stream|http|https|net|zlib|readline|assert|buffer|process|timers';

/**
 * The one exception section 4 names for `eslint-disable`: an intentionally
 * empty interface extending `Omit<…>`.
 */
const EMPTY_INTERFACE_RULE = /no-empty-(?:object-type|interface)/;

/** Vitest's mock types: a constant typed by one is what section 2 rules out. */
const MOCK_TYPES = 'Mock|MockInstance|MockedFunction|MockedClass|MockedObject|Mocked';

/** A variable, parameter or return typed by one of them, or a value cast to one. */
const TYPED_MOCK = new RegExp(String.raw`(?::\s*|\bas\s+)(?:${MOCK_TYPES})\b`);

/**
 * An `as` that asserts a type. Not `as const`, which asserts none; not the
 * second `as` of `as unknown as`, nor `as any`, nor a mock type, which have
 * patterns of their own.
 */
const CAST = new RegExp(String.raw`(?<!\bas\s+unknown\s+)\bas\s+(?!(?:const|unknown|any|${MOCK_TYPES})\b)[A-Za-z_$({[]`, 'g');

/**
 * Where `as` renames rather than casts: an import or export, a lone specifier
 * of one written over several lines, a mapped type's key.
 */
const RENAMES = /^\s*import\b|^\s*export\s*(?:type\s*)?[{*]|^\s*(?:type\s+)?[\w$]+\s+as\s+[\w$]+\s*,?\s*$|\[\s*[\w$]+\s+in\s+/;

const STRING = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

/** A line that is all comment: `//`, a block comment, a JSDoc line. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/**
 * The code of a line, with what strings and comments say taken out: a test
 * named "renders the card as selected" casts nothing.
 *
 * @param {string} line
 * @returns {string}
 */
const codeOf = (line) => (COMMENT_LINE.test(line) ? '' : line.replace(STRING, "''").replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, ''));

/** Words after which `[` opens an array literal rather than indexing a value. */
const BEFORE_LITERAL = new Set(['return', 'yield', 'await', 'case', 'throw', 'in', 'of', 'else', 'do', 'typeof', 'void', 'delete', 'new']);

/**
 * Whether what `code` ends with is an object or array literal rather than a
 * value: `{ Id: '1' }` and `[a, b]` are, `items[0]` and `call()` are not. A
 * line that only closes a literal opened above it, `} as Foo;`, ends one.
 *
 * @param {string} code
 * @returns {boolean}
 */
function endsWithLiteral(code) {
  const text = code.trimEnd();
  if (text.endsWith('}')) return true;
  if (!text.endsWith(']')) return false;

  let depth = 0;
  for (let at = text.length - 1; at >= 0; at -= 1) {
    if (text[at] === ']') depth += 1;
    else if (text[at] === '[' && --depth === 0) {
      const before = text.slice(0, at).trimEnd();
      const word = /[\w$]+$/.exec(before)?.[0];
      if (word && BEFORE_LITERAL.has(word)) return true;
      return !/[\w$)\].?!]$/.test(before);
    }
  }
  return true;
}

/**
 * What a line of a unit spec casts: a value, a literal, or nothing.
 *
 * Section 4 holds no `as X` without a runtime check, and in a unit spec the
 * check is always there to be had: `assert(x)` and `assert(x instanceof T)`
 * narrow, `vi.mocked()` types a mock. So a cast of a value breaks the rule
 * outright. A cast of an object or array literal is a fixture written short —
 * what the calibration calls a test-only shortcut, a nit unless it leaves the
 * test proving nothing — and whether it does is the review's to say.
 *
 * @param {string} line
 * @returns {{value: boolean, literal: boolean}}
 */
function castsIn(line) {
  const code = codeOf(line);
  const found = { value: false, literal: false };
  if (code.trim() === '' || RENAMES.test(code)) return found;

  for (const match of code.matchAll(CAST)) {
    if (endsWithLiteral(code.slice(0, match.index))) found.literal = true;
    else found.value = true;
  }
  return found;
}

/**
 * @typedef {object} Pattern
 * @property {string} label
 * @property {number} section    of knowledge/maintainer-rules.md
 * @property {boolean} strict    the rule has no exception: a hit blocks
 * @property {(path: string) => boolean} applies
 * @property {(line: string) => boolean} test
 */

/**
 * @param {RegExp} pattern
 * @returns {(line: string) => boolean}
 */
const matching = (pattern) => (line) => pattern.test(line);

/** @type {Pattern[]} */
const PATTERNS = [
  // Section 2: unit tests.
  { label: 'vi.spyOn', section: 2, strict: true, applies: unitSpec, test: matching(/\bvi\.spyOn\s*\(/) },
  { label: 'Object.defineProperty(window)', section: 2, strict: true, applies: unitSpec, test: matching(/\bObject\.defineProperty\s*\(\s*window\b/) },
  { label: 'vi.stubGlobal', section: 2, strict: true, applies: unitSpec, test: matching(/\bvi\.stubGlobal\s*\(/) },
  // vi.mocked() types what automocking mocked, vi.fn<…>() a mock of its own:
  // neither leaves a reason to type a constant by hand.
  { label: 'a typed Mock', section: 2, strict: true, applies: unitSpec, test: (line) => TYPED_MOCK.test(codeOf(line)) },
  { label: 'clearAllMocks/restoreAllMocks', section: 2, strict: true, applies: unitSpec, test: matching(/\bvi\.(?:clearAllMocks|restoreAllMocks)\s*\(/) },
  { label: 'afterEach/afterAll/beforeAll', section: 2, strict: true, applies: unitSpec, test: matching(/^\s*(?:afterEach|afterAll|beforeAll)\s*\(/) },
  { label: 'await tick()', section: 2, strict: true, applies: unitSpec, test: matching(/\bawait\s+tick\s*\(\s*\)/) },
  { label: 'a real sleep in a unit spec', section: 2, strict: true, applies: unitSpec, test: matching(/\bnew\s+Promise\b[^;]*\bsetTimeout\s*\(\s*(?:resolve|res|r)\b/) },
  { label: 'expect(…).toBeDefined() instead of assert()', section: 4, strict: true, applies: unitSpec, test: matching(/\.toBeDefined\s*\(\s*\)/) },
  { label: 'vi.mock with a factory', section: 2, strict: false, applies: unitSpec, test: matching(/\bvi\.mock\s*\(\s*(?:import\s*\(\s*)?['"][^'"]+['"]\s*\)?\s*,/) },
  { label: 'vi.hoisted', section: 2, strict: false, applies: unitSpec, test: matching(/\bvi\.hoisted\s*\(/) },
  { label: 'vi.importActual', section: 2, strict: false, applies: unitSpec, test: matching(/\bvi\.importActual\s*[(<]/) },
  { label: 'mockImplementation(async () => …)', section: 2, strict: false, applies: unitSpec, test: matching(/\.mockImplementation\s*\(\s*async\s*\(\s*\)\s*=>/) },

  // Section 4: TypeScript.
  { label: 'as unknown as', section: 4, strict: true, applies: packageCode, test: matching(/\bas\s+unknown\s+as\b/) },
  { label: 'any', section: 4, strict: true, applies: packageCode, test: matching(/\bas\s+any\b|:\s*any\b(?![\w$])|<any>/) },
  // In unit specs only: production code may cast after a check a grep cannot see.
  { label: 'as <Type> on a value', section: 4, strict: true, applies: unitSpec, test: (line) => castsIn(line).value },
  { label: 'as <Type> on an object or array literal', section: 4, strict: false, applies: unitSpec, test: (line) => castsIn(line).literal },
  { label: '! non-null assertion', section: 4, strict: true, applies: packageCode, test: matching(/[\w$)\]]!(?=[.[;,)])/) },
  { label: 'eslint-disable', section: 4, strict: true, applies: packageCode, test: (line) => /eslint-disable/.test(line) && !EMPTY_INTERFACE_RULE.test(line) },
  {
    label: 'synchronous fs/exec',
    section: 4,
    strict: true,
    applies: packageSource,
    test: matching(/\b(?:exec|execFile|spawn|readFile|writeFile|appendFile|readdir|exists|mkdir|stat|lstat|access|copyFile|rename|rm|rmdir|unlink|realpath)Sync\s*\(/),
  },
  { label: 'an empty catch', section: 4, strict: true, applies: packageSource, test: matching(/\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/) },
  { label: 'void to discard a promise', section: 4, strict: true, applies: packageSource, test: matching(/^\s*void\s+[\w$.]+\s*\(/) },
  { label: 'sort() instead of toSorted()', section: 4, strict: false, applies: packageSource, test: matching(/\.sort\s*\(/) },

  // Section 5: imports and package boundaries.
  { label: 'relative ../ import', section: 5, strict: true, applies: packageCode, test: matching(/\bfrom\s+['"]\.\.\//) },
  { label: 'node built-in without node:', section: 5, strict: true, applies: packageCode, test: matching(new RegExp(`\\bfrom\\s+['"](?:${NODE_BUILTINS})(?:/[a-z]+)?['"]`)) },
  { label: 'import() in the body', section: 5, strict: false, applies: packageCode, test: matching(/\bawait\s+import\s*\(/) },

  // Section 6: main process and DI.
  { label: 'export function in packages/main', section: 6, strict: true, applies: mainSource, test: matching(/^export\s+(?:async\s+)?function\b/) },
  { label: 'exported arrow function in packages/main', section: 6, strict: true, applies: mainSource, test: matching(/^export\s+const\s+[\w$]+\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*(?::[^=]+)?=>/) },
  { label: 'file-scope function in packages/main', section: 6, strict: true, applies: mainSource, test: matching(/^(?:async\s+)?function\b/) },
  { label: 'Electron app.name', section: 8, strict: true, applies: mainSource, test: matching(/\bapp\.name\b/) },

  // Section 3: Svelte and the renderer.
  { label: '<style> or style= in Svelte', section: 3, strict: true, applies: (path) => path.endsWith('.svelte'), test: matching(/<style\b|\sstyle=/) },
  { label: '$: in Svelte', section: 3, strict: true, applies: (path) => path.endsWith('.svelte'), test: matching(/^\s*\$:/) },
  { label: 'tick() in component code', section: 3, strict: true, applies: rendererSource, test: matching(/\btick\s*\(\s*\)/) },
  { label: 'Node types in renderer code', section: 3, strict: true, applies: rendererSource, test: matching(/\bNodeJS\./) },

  // Section 8: UI and theming.
  { label: 'hardcoded "Podman Desktop"', section: 8, strict: true, applies: packageSource, test: matching(/['"`][^'"`]*\bPodman Desktop\b/) },
  { label: 'hex color in color-registry', section: 8, strict: true, applies: (path) => /color-registry\.ts$/.test(path), test: matching(/['"]#[0-9a-fA-F]{3,8}['"]/) },
];

/**
 * A license header naming a year other than this one, or a range.
 *
 * Kept apart from PATTERNS because "this year" is not a constant.
 *
 * @param {string} line
 * @param {number} year
 */
export function staleCopyright(line, year) {
  const match = /Copyright \(C\) (\d{4})(-\d{4})?/.exec(line);
  return match !== null && (match[2] !== undefined || Number(match[1]) !== year);
}

/**
 * What a list of added lines breaks, by label.
 *
 * Exported so each pattern can be held to the line it is meant to catch and the
 * line it must leave alone, without a repository per case.
 *
 * @param {string} file             repository-relative path
 * @param {string[]} lines          the added lines, without the leading `+`
 * @param {number} year
 * @returns {Array<{label: string, section: number, strict: boolean, line: string}>}
 */
export function scan(file, lines, year) {
  const hits = [];
  for (const line of lines) {
    for (const pattern of PATTERNS) {
      if (pattern.applies(file) && pattern.test(line)) hits.push({ label: pattern.label, section: pattern.section, strict: pattern.strict, line });
    }
    if (staleCopyright(line, year)) hits.push({ label: `copyright not ${year} alone`, section: 1, strict: true, line });
  }
  return hits;
}

/**
 * One added line a pattern hit, where it is. The result carries them for a
 * caller that prints them on its own terms — `pdkit self-review target`, with
 * the task that owns each file — rather than the report's prose.
 *
 * @typedef {object} Hit
 * @property {string} label
 * @property {number} section
 * @property {boolean} strict
 * @property {string} path
 * @property {string} line   the added line, trimmed
 */

/**
 * @param {Record<string, {section: number, lines: string[]}>} found
 */
const summarize = (found) => Object.keys(found).map((label) => `${label} ×${found[label].lines.length} (§${found[label].section})`).join(', ');

/**
 * @param {Record<string, {section: number, lines: string[]}>} found
 */
const detail = (found) => Object.keys(found).map((label) => `${label} — §${found[label].section}\n  ${found[label].lines.join('\n  ')}`).join('\n\n');

/**
 * @param {import('../index.js').PreflightContext} context
 * @param {{year?: number}} [options]
 * @returns {Promise<import('../index.js').CheckResult>}
 */
export async function run(context, options = {}) {
  const year = options.year ?? new Date().getFullYear();
  const diff = await capture({
    command: `git diff ${context.base}...${context.ref} --unified=0`,
    cwd: context.repoRoot,
  });

  /** @type {Record<string, string[]>} */
  const added = {};
  let file = '';

  for (const raw of diff.stdout.split('\n')) {
    // Same CRLF care as debug-leftovers: the `\r` would otherwise end up in
    // the captured filename and in every reported line.
    const line = raw.replace(/\r$/, '');
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) {
      file = header[1];
      continue;
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    (added[file] ??= []).push(line.slice(1));
  }

  /** @type {Record<string, {section: number, lines: string[]}>} */
  const strict = {};
  /** @type {Record<string, {section: number, lines: string[]}>} */
  const judged = {};
  /** @type {Hit[]} */
  const hits = [];

  for (const [path, lines] of Object.entries(added)) {
    for (const hit of scan(path, lines, year)) {
      const into = hit.strict ? strict : judged;
      (into[hit.label] ??= { section: hit.section, lines: [] }).lines.push(`${path}: ${hit.line.trim()}`);
      hits.push({ label: hit.label, section: hit.section, strict: hit.strict, path, line: hit.line.trim() });
    }
  }

  const strictCount = Object.keys(strict).length;
  const judgedCount = Object.keys(judged).length;

  if (strictCount === 0 && judgedCount === 0) {
    return { id, status: 'pass', blocking, summary: 'none of the greppable maintainer rules hit', hits };
  }

  const sections = [];
  if (strictCount > 0) sections.push(`Breaks a rule with no exception — change the code:\n\n${detail(strict)}`);
  if (judgedCount > 0) sections.push(`Allowed only when the rule's own condition holds — the self-review rules on each:\n\n${detail(judged)}`);

  if (strictCount > 0) {
    return {
      id,
      status: 'fail',
      blocking,
      summary: summarize(strict) + (judgedCount > 0 ? `; to judge: ${summarize(judged)}` : ''),
      output: sections.join('\n\n'),
      remedy:
        'upstream\'s review agent raises each of these as an `issue:`. The rule and its reason are in ' +
        'knowledge/maintainer-rules.md under the section named; fix the code, then run preflight again',
      hits,
    };
  }

  return {
    id,
    status: 'warn',
    blocking,
    summary: `to judge: ${summarize(judged)}`,
    output: sections.join('\n\n'),
    remedy:
      'each of these rules holds unless its own condition says otherwise (knowledge/maintainer-rules.md, section named). ' +
      'The self-review decides each hit; one it cannot justify is an `issue:`',
    hits,
  };
}
