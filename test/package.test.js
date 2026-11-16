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

// The package is the plugin: Open Code installs it from npm, resolves its "."
// export and loads the default export inside the server.
//
// Nothing else in the suite would notice that chain broken. A package whose
// export is missing from `files`, or whose entry point needs a module the
// package does not ship, passes every other test here and fails only once a
// server tries to load the published copy — and a plugin that fails to load
// leaves the session running without it, gate included.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, posix } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const manifest = async () => JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));

/** The file the "." export names, relative to the package root. */
const entryOf = (pkg) => {
  const target = typeof pkg.exports === 'string' ? pkg.exports : pkg.exports?.['.'];
  assert.equal(typeof target, 'string', 'package.json exports no "." entry, so Open Code has nothing to load');
  return posix.normalize(target);
};

describe('the Open Code package', () => {
  test('the "." export loads in plain node with the shape the host requires', async () => {
    const entry = entryOf(await manifest());
    const { default: plugin } = await import(pathToFileURL(join(ROOT, entry)).href);

    // The host accepts a default export with a string id and a setup function,
    // and refuses to load anything else.
    assert.equal(plugin?.id, 'opencode-pdkit');
    assert.equal(typeof plugin.setup, 'function');
  });

  test('the export is among the files the package ships', async () => {
    const pkg = await manifest();
    const entry = entryOf(pkg);
    const shipped = (pkg.files ?? []).map((path) => posix.normalize(path));

    assert.ok(
      shipped.some((path) => entry === path || entry.startsWith(path.endsWith('/') ? path : `${path}/`)),
      `${entry} is not covered by "files", so the published package would have no entry point`,
    );
  });

  // Zero dependencies is the rule for the code, and the package keeps it. A peer
  // dependency on @opencode/plugin in particular buys nothing: the installer
  // fetches it from the registry and never compares it with the host that is
  // actually running, and the entry point does not import it.
  test('declares no runtime dependencies', async () => {
    const pkg = await manifest();

    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies']) {
      assert.equal(pkg[field], undefined, `package.json declares ${field}`);
    }
  });
});
