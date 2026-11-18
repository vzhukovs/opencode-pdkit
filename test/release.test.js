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

// The version lives in one place, package.json, and this is the only thing
// that holds the changelog to it.
//
// The package is the plugin. npm publishes the version package.json carries,
// Open Code lists the installed copy by it and offers `opencode plugin update`
// when the registry has a newer one, and `pdkit --version` prints it. A
// release that forgets to bump it does not slip through: npm refuses to publish
// over a version it already has. What nothing at runtime notices is the
// changelog — release notes headed by another number than the one that
// shipped, or a release with no link — and a reader finds that only after the
// release is public.
//
// Under Claude Code the version had a second home, .claude-plugin/plugin.json,
// which decided whether an update reached anyone at all, and this test held the
// two equal. That manifest is gone, and the first test keeps it gone.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const read = async (...parts) => readFile(join(ROOT, ...parts), 'utf8');
const json = async (...parts) => JSON.parse(await read(...parts));

/** `## [1.2.3] - 2026-08-10`, newest first in a Keep a Changelog file. */
const RELEASE_HEADING = /^## \[(\d+\.\d+\.\d+)\](?: - (\d{4}-\d{2}-\d{2}))?$/gm;

/**
 * The first version this repository releases. The numbering goes on from
 * podman-desktop-kit 0.15.0, whose releases stay in the changelog below it
 * with their links into the repository they were released from, as history:
 * those links are not this repository's to correct, tags that never existed
 * included.
 */
const FIRST_RELEASE = '0.16.0';

const newerOrSame = (version, than) => {
  const [a, b] = [version, than].map((v) => v.split('.').map(Number));
  const at = a.findIndex((part, i) => part !== b[i]);
  return at === -1 || a[at] > b[at];
};

/** The web address of the repository npm checks the package's provenance against. */
const repositoryOf = (pkg) => {
  const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const web = /^(?:git\+)?(https:\/\/github\.com\/[^/\s]+\/[^/\s]+?)(?:\.git)?$/.exec(url ?? '');
  assert.ok(web, `package.json repository.url is ${JSON.stringify(url)}, not a GitHub https URL`);
  return web[1];
};

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The target of `[label]: <target>` at the bottom of the changelog, if there is one. */
const linkOf = (changelog, label) => new RegExp(`^\\[${escape(label)}\\]: (\\S+)$`, 'm').exec(changelog)?.[1];

describe('the version is one number', () => {
  test('package.json carries it, and no second manifest does', async () => {
    const pkg = await json('package.json');

    assert.match(pkg.version ?? '', /^\d+\.\d+\.\d+$/, 'package.json carries no x.y.z version');
    await assert.rejects(
      access(join(ROOT, '.claude-plugin')),
      { code: 'ENOENT' },
      '.claude-plugin/ is back: a version there is a second number that nothing reads and nothing holds to package.json',
    );
  });

  test('the newest changelog entry is that version', async () => {
    const pkg = await json('package.json');
    const [newest] = [...(await read('CHANGELOG.md')).matchAll(RELEASE_HEADING)];

    assert.ok(newest, 'CHANGELOG.md has no `## [x.y.z]` release heading at all');
    assert.equal(
      newest[1],
      pkg.version,
      `CHANGELOG.md's newest release is ${newest[1]} and package.json says ${pkg.version}`,
    );
    assert.ok(newest[2], `the ${newest[1]} heading carries no date`);
  });
});

describe('the changelog stays readable as a changelog', () => {
  test('it keeps an Unreleased section to write the next entry into', async () => {
    assert.match(await read('CHANGELOG.md'), /^## \[Unreleased\]$/m);
  });

  test('every release heading has a link definition', async () => {
    const changelog = await read('CHANGELOG.md');

    for (const [, version] of changelog.matchAll(RELEASE_HEADING)) {
      assert.match(
        changelog,
        new RegExp(`^\\[${escape(version)}\\]: `, 'm'),
        `[${version}] has no link definition at the bottom`,
      );
    }
  });

  // The first release has no earlier tag here to compare with, so it links to
  // its own tag; each one after it, to the change from the release before; and
  // Unreleased, to what main has added since the newest. Before the first
  // release there is nothing of this repository's to hold.
  test(`the releases from ${FIRST_RELEASE} on link into the package's repository`, async () => {
    const repository = repositoryOf(await json('package.json'));
    const changelog = await read('CHANGELOG.md');
    const own = [...changelog.matchAll(RELEASE_HEADING)]
      .map(([, version]) => version)
      .filter((version) => newerOrSame(version, FIRST_RELEASE));

    own.forEach((version, i) => {
      const previous = own[i + 1];
      const expected = previous
        ? `${repository}/compare/v${previous}...v${version}`
        : `${repository}/releases/tag/v${version}`;
      assert.equal(linkOf(changelog, version), expected, `[${version}] links somewhere else`);
    });
    if (own.length > 0) {
      assert.equal(
        linkOf(changelog, 'Unreleased'),
        `${repository}/compare/v${own[0]}...HEAD`,
        '[Unreleased] does not compare main with the newest release',
      );
    }
  });
});
