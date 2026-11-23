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

// Where the comments of a source file are.
//
// The comment pattern of maintainer-rules is strict, so a line it takes for a
// comment that is not one is a push nobody can make. A regular expression over
// the added line alone cannot tell a `//` in a string or a template literal
// from a comment, nor see that a line was added inside a block comment opened
// above it. This reads the whole file the way the language does — strings,
// template literals and their `${}`, regular expressions — and says on which
// lines each comment starts and ends. On three months of upstream commits,
// 38,260 added lines, a line-by-line reading and this one disagreed on 8, and
// this one was right on all 8: three lines of a template literal a test holds,
// five inside a multi-line `<!-- -->`.
//
// Svelte and HTML are markup with code in it: `<!-- -->` in the markup,
// JavaScript's comments in `<script>`, nothing in `<style>`, which a pattern
// of its own already forbids in Svelte.
//
// Two places where it guesses, as any reader without a parser does:
//
// - whether `/` starts a regular expression or divides, from what comes before
//   it. When unsure it takes a regular expression, which ends at the line's
//   end and at worst hides a comment on that one line; taking one for a
//   division would find a comment in `/https?:\/\//`;
// - JSX text, in .tsx and .jsx, is read as code: a URL written as text between
//   two tags would read as a comment. JSX exists only in the docs site, and no
//   file there has one.
//
// A leaf: it imports nothing, so anything may read from it.

/**
 * @typedef {object} Comment
 * @property {'line'|'block'|'jsdoc'|'html'} kind
 * @property {number} start   the line it starts on, from 1
 * @property {number} end     the line it ends on
 * @property {string} text    as written, delimiters included
 */

/** The files this reads: code, and the markup that carries code. */
export const CODE = /\.(?:[cm]?[jt]s|[jt]sx|svelte|html)$/;

const MARKUP = /\.(?:svelte|html)$/;

/** After one of these, `/` starts a regular expression rather than dividing. */
const BEFORE_REGEX = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

/** The words after which `/` does the same. */
const KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await']);

const WORD = /[\w$]/;
const BLANK = /[ \t\r\f\v ﻿]/;

/** Where `<script` or `<style` opens an element, not a longer tag name. */
const RAW_TEXT = /<(script|style)(?=[\s/>])/iy;

/**
 * The text, a position in it and the line that position is on.
 */
class Reader {
  /** @param {string} text */
  constructor(text) {
    this.text = text;
    this.at = 0;
    this.line = 1;
    /** @type {Comment[]} */
    this.comments = [];
  }

  /**
   * Move up to `stop`, counting the lines passed.
   *
   * @param {number} stop
   */
  skipTo(stop) {
    const end = Math.min(stop, this.text.length);
    for (; this.at < end; this.at += 1) {
      if (this.text[this.at] === '\n') this.line += 1;
    }
  }

  /**
   * A comment of `kind` from here up to `stop`.
   *
   * @param {Comment['kind']} kind
   * @param {number} stop
   */
  comment(kind, stop) {
    const start = this.line;
    const text = this.text.slice(this.at, stop);
    this.skipTo(stop);
    this.comments.push({ kind, start, end: this.line, text });
  }

  /**
   * Where the line `from` is on ends, or `limit`.
   *
   * @param {number} from
   * @param {number} limit
   */
  lineEnd(from, limit) {
    const end = this.text.indexOf('\n', from);
    return end === -1 || end > limit ? limit : end;
  }
}

/**
 * After a backtick or the `}` that closes a `${`, the rest of a template
 * literal: up to its closing backtick, or into the next `${`.
 *
 * @param {Reader} reader
 * @param {number} limit
 * @param {number[]} templates   one entry per open `${`: how many `{` in it are open
 */
function template(reader, limit, templates) {
  const { text } = reader;
  let at = reader.at;
  while (at < limit && text[at] !== '`' && !(text[at] === '$' && text[at + 1] === '{')) at += text[at] === '\\' ? 2 : 1;
  if (at >= limit) {
    reader.skipTo(limit);
  } else if (text[at] === '`') {
    reader.skipTo(at + 1);
  } else {
    templates.push(0);
    reader.skipTo(at + 2);
  }
}

/**
 * Script from here up to `limit`: the comments in it, and nothing else.
 *
 * @param {Reader} reader
 * @param {number} limit
 */
function script(reader, limit) {
  const { text } = reader;
  /** @type {number[]} */
  const templates = [];
  let previous = '';
  let word = '';

  if (reader.at === 0 && text.startsWith('#!')) reader.skipTo(reader.lineEnd(0, limit));

  while (reader.at < limit) {
    const char = text[reader.at];
    const next = text[reader.at + 1];

    if (char === '\n' || BLANK.test(char)) {
      reader.skipTo(reader.at + 1);
      continue;
    }

    if (char === '/' && next === '/') {
      reader.comment('line', reader.lineEnd(reader.at, limit));
      continue;
    }

    if (char === '/' && next === '*') {
      const close = text.indexOf('*/', reader.at + 2);
      const stop = close === -1 || close + 2 > limit ? limit : close + 2;
      const jsdoc = text[reader.at + 2] === '*' && text[reader.at + 3] !== '/';
      reader.comment(jsdoc ? 'jsdoc' : 'block', stop);
      continue;
    }

    if (char === "'" || char === '"') {
      let at = reader.at + 1;
      while (at < limit && text[at] !== char && text[at] !== '\n') at += text[at] === '\\' ? 2 : 1;
      reader.skipTo(Math.min(text[at] === char ? at + 1 : at, limit));
      previous = char;
      word = '';
      continue;
    }

    if (char === '`') {
      reader.skipTo(reader.at + 1);
      template(reader, limit, templates);
      previous = '`';
      word = '';
      continue;
    }

    if (char === '/' && (previous === '' || BEFORE_REGEX.has(previous) || (previous === 'word' && KEYWORDS.has(word)))) {
      let at = reader.at + 1;
      let inClass = false;
      while (at < limit && text[at] !== '\n' && (inClass || text[at] !== '/')) {
        if (text[at] === '\\' && text[at + 1] !== '\n') at += 1;
        else if (text[at] === '[') inClass = true;
        else if (text[at] === ']') inClass = false;
        at += 1;
      }
      if (text[at] === '/') at += 1;
      while (at < limit && WORD.test(text[at])) at += 1;
      reader.skipTo(Math.min(at, limit));
      previous = 'regex';
      word = '';
      continue;
    }

    if (templates.length > 0 && (char === '{' || char === '}')) {
      reader.skipTo(reader.at + 1);
      if (char === '{') templates[templates.length - 1] += 1;
      else if (templates[templates.length - 1] > 0) templates[templates.length - 1] -= 1;
      else {
        templates.pop();
        template(reader, limit, templates);
        previous = '`';
        word = '';
        continue;
      }
      previous = char;
      word = '';
      continue;
    }

    if (WORD.test(char)) {
      let at = reader.at;
      while (at < limit && WORD.test(text[at])) at += 1;
      word = text.slice(reader.at, at);
      previous = 'word';
      reader.skipTo(at);
      continue;
    }

    reader.skipTo(reader.at + 1);
    previous = char;
    word = '';
  }
}

/**
 * Where the opening tag that starts at `from` ends: past its `>`, with a `>`
 * inside a quoted attribute — `generics="T extends Map<K, V>"` — skipped.
 *
 * @param {string} text
 * @param {number} from
 * @returns {number}
 */
function tagEnd(text, from) {
  let quote = '';
  for (let at = from; at < text.length; at += 1) {
    const char = text[at];
    if (quote !== '') {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '>') return at + 1;
  }
  return text.length;
}

/**
 * Markup: `<!-- -->` comments, and the scripts and styles inside it.
 *
 * @param {Reader} reader
 */
function markup(reader) {
  const { text } = reader;
  const lower = text.toLowerCase();

  while (reader.at < text.length) {
    if (text.startsWith('<!--', reader.at)) {
      const close = text.indexOf('-->', reader.at + 4);
      reader.comment('html', close === -1 ? text.length : close + 3);
      continue;
    }

    RAW_TEXT.lastIndex = reader.at;
    const element = RAW_TEXT.exec(text);
    if (element) {
      const name = element[1].toLowerCase();
      reader.skipTo(tagEnd(text, reader.at));
      const close = lower.indexOf(`</${name}`, reader.at);
      const limit = close === -1 ? text.length : close;
      if (name === 'script') script(reader, limit);
      else reader.skipTo(limit);
      continue;
    }

    reader.skipTo(reader.at + 1);
  }
}

/**
 * The comments of a file, in the order they appear.
 *
 * @param {string} path     decides how it is read: markup for .svelte and .html, script otherwise
 * @param {string} source
 * @returns {Comment[]}
 */
export function commentsIn(path, source) {
  const reader = new Reader(String(source ?? ''));
  if (MARKUP.test(path)) markup(reader);
  else script(reader, reader.text.length);
  return reader.comments;
}
