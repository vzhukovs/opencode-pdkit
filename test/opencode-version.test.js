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

// lib/opencode-version.js decides whether the plugin loads in full or only as
// the gate, and the doctor and CI read the minimum through it as well. The
// versions here are the shapes Open Code actually reports: ctx.app of a release
// is { version: "2.3.0", channel: "latest" }, a nightly is "0.0.0-<channel>-<n>",
// a local build "local"/"local", and `opencode --version` prints "v" in front.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkOpenCode, compareVersions, minimumVersion, parseRelease } from '../lib/opencode-version.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

describe('the minimum in engines.opencode', () => {
  test('is the version a >=X.Y.Z range starts at', () => {
    assert.equal(minimumVersion('>=2.3.0'), '2.3.0');
  });

  // CI installs the minimum and the plugin compares against it, so a range
  // that names no single version is no minimum at all.
  for (const range of ['^2.3.0', '>=2.3', '2.3.0', '>= 2.3.0', '>=2.3.0 <3', '>=2.3.0-beta.1', '', undefined, 230]) {
    test(`is not read from ${JSON.stringify(range)}`, () => {
      assert.equal(minimumVersion(range), null);
    });
  }

  test("is read from the package's own engines.opencode", async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));

    assert.match(minimumVersion(pkg.engines?.opencode) ?? '', /^\d+\.\d+\.\d+$/);
  });
});

describe('release versions', () => {
  test('parse with or without the v that opencode --version prints', () => {
    assert.deepEqual(parseRelease('2.3.0'), [2, 3, 0]);
    assert.deepEqual(parseRelease('v2.3.0'), [2, 3, 0]);
  });

  for (const text of ['0.0.0-dev-1297', 'local', '2.3', 'opencode v2.3.0', '', undefined]) {
    test(`${JSON.stringify(text)} is not one`, () => {
      assert.equal(parseRelease(text), null);
    });
  }

  test('order by number, not by text', () => {
    assert.ok(compareVersions('2.10.0', '2.9.0') > 0);
    assert.ok(compareVersions('2.2.7', '2.3.0') < 0);
    assert.ok(compareVersions('1.19.5', '2.3.0') < 0);
    assert.equal(compareVersions('v2.3.0', '2.3.0'), 0);
  });

  test('a build that is not a release is not ordered at all', () => {
    assert.throws(() => compareVersions('0.0.0-dev-1297', '2.3.0'), /X\.Y\.Z/);
  });
});

describe('the running Open Code against the minimum', () => {
  const MINIMUM = '2.3.0';
  const release = (version) => ({ name: 'cli', version, channel: 'latest' });

  for (const [app, status] of [
    [release('2.3.0'), 'ok'],
    [release('2.4.1'), 'ok'],
    [release('2.10.0'), 'ok'],
    [release('2.2.7'), 'below'],
    [release('1.19.5'), 'below'],
    // The doctor's fallback outside a session: `opencode --version`, no channel.
    [{ version: 'v2.3.0' }, 'ok'],
    [{ version: 'v2.2.7' }, 'below'],
  ]) {
    test(`${app.version} is ${status}`, () => {
      const verdict = checkOpenCode(app, MINIMUM);

      assert.equal(verdict.status, status);
      assert.equal(verdict.version, app.version);
      assert.equal(verdict.minimum, MINIMUM);
    });
  }

  // A build off the release line is neither too old nor new enough: nobody
  // measured it against the minimum, and skip is not pass.
  for (const app of [
    { name: 'cli', version: '0.0.0-dev-1297', channel: 'dev' },
    { name: 'cli', version: '0.0.0-beta-202611150000', channel: 'beta' },
    { name: 'cli', version: 'local', channel: 'local' },
    { name: 'cli', version: '2.4.0', channel: 'beta' },
    { version: '0.0.0-dev-1297' },
    { version: 'local' },
    { version: '0.0.0' },
  ]) {
    test(`${app.version} on channel ${app.channel ?? '(none)'} is not a release`, () => {
      const verdict = checkOpenCode(app, MINIMUM);

      assert.equal(verdict.status, 'unreleased');
      assert.match(verdict.detail, new RegExp(app.version.replace(/\./g, '\\.')));
    });
  }

  for (const app of [undefined, {}, { version: 42 }, { version: 'abc', channel: 'latest' }]) {
    test(`${JSON.stringify(app)} cannot be placed`, () => {
      assert.equal(checkOpenCode(app, MINIMUM).status, 'unknown');
    });
  }

  test('a minimum that is not X.Y.Z places nothing, and does not throw', () => {
    const verdict = checkOpenCode(release('2.3.0'), minimumVersion('^2.3.0'));

    assert.equal(verdict.status, 'unknown');
    assert.match(verdict.detail, /minimum/);
  });
});
