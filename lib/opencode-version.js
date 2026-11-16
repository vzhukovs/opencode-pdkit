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

// Which Open Code a version string names, and whether it is new enough.
//
// The minimum lives in one place, package.json engines.opencode, and Open Code
// itself ignores the field: it installs and loads a plugin on any host. So the
// plugin compares for itself, at load time, and three readers have to agree on
// what the field means — the plugin's entry point, `pdkit doctor`, and the CI
// script that installs the minimum to test on. This module is that one reading.
//
// It is a leaf on purpose: it imports nothing. The plugin's entry point loads
// it inside the Open Code server, where only leaf modules of lib/ run (the rest
// of lib/ runs in a node child process), and a leaf cannot drag the rest in.

/** `>=X.Y.Z` and nothing else: a range of any other shape names no one version to install. */
const MINIMUM = /^>=(\d+\.\d+\.\d+)$/;

/** A release: `X.Y.Z`, optionally with the `v` that `opencode --version` prints. */
const RELEASE = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** A build that is not a release: a prerelease suffix, as in `0.0.0-dev-1297`. */
const PRERELEASE = /^v?\d+\.\d+\.\d+-\S+$/;

/** The channel Open Code reports for a release build. */
const RELEASE_CHANNEL = 'latest';

/**
 * The environment variable that tells a shell command which Open Code runs it.
 *
 * The plugin sets it on every command the shell tool runs, from the version
 * the server reports to the plugin, and `pdkit doctor` reads it. The version
 * that has to meet the minimum is the server's, since the server runs the
 * plugin, and `opencode --version` reports the CLI's, which can differ. Unset
 * means no plugin of this version set it: outside a session, or below the
 * minimum, where the plugin registers nothing but the gate and refusals.
 */
export const SERVER_VERSION_VARIABLE = 'PDKIT_OPENCODE_VERSION';

/**
 * The lowest version a range admits, when the range is `>=X.Y.Z`.
 *
 * @param {unknown} range engines.opencode as package.json has it
 * @returns {string | null} `X.Y.Z`, or null for any other shape
 */
export function minimumVersion(range) {
  const match = typeof range === 'string' ? MINIMUM.exec(range) : null;
  return match ? match[1] : null;
}

/**
 * The numbers of a release version.
 *
 * @param {unknown} text
 * @returns {[number, number, number] | null} null for anything but `X.Y.Z` (or `vX.Y.Z`)
 */
export function parseRelease(text) {
  const match = typeof text === 'string' ? RELEASE.exec(text) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * Order two release versions.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} negative when a is older, 0 when equal, positive when newer
 */
export function compareVersions(a, b) {
  const left = parseRelease(a);
  const right = parseRelease(b);
  if (!left || !right) throw new Error(`cannot compare "${a}" with "${b}": both must be X.Y.Z`);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

/**
 * Where a running Open Code stands against the minimum.
 *
 * `app` is what the host reports about itself: in the plugin, `ctx.app`
 * (`{ name, version, channel }`); elsewhere, whatever the caller read, with the
 * channel left out when nothing reported one. A build that is not a release
 * (`0.0.0-<channel>-<n>`, `local`, a channel other than "latest") cannot be
 * placed on the release line, so it is reported as such and never compared:
 * whoever runs one chose that channel, and calling it too old or new enough
 * would be a claim nobody measured.
 *
 * Never throws: a minimum that is not `X.Y.Z` (see minimumVersion, which
 * returns null for a malformed engines.opencode) is "unknown" as well.
 *
 * @param {{version?: unknown, channel?: unknown} | undefined} app
 * @param {string | null} minimum `X.Y.Z`
 * @returns {{status: 'ok' | 'below' | 'unreleased' | 'unknown', version: string | undefined, minimum: string | null, detail: string}}
 */
export function checkOpenCode(app, minimum) {
  const version = typeof app?.version === 'string' ? app.version : undefined;
  const channel = typeof app?.channel === 'string' ? app.channel : undefined;
  const result = (status, detail) => ({ status, version, minimum, detail });

  if (!parseRelease(minimum)) return result('unknown', `no minimum to compare with: ${JSON.stringify(minimum)} is not X.Y.Z`);
  if (version === undefined) return result('unknown', 'Open Code reported no version');
  if (channel !== undefined && channel !== RELEASE_CHANNEL) {
    return result('unreleased', `Open Code ${version} is a ${channel} build, not a release`);
  }
  if (version === 'local' || PRERELEASE.test(version) || /^v?0\.0\.0$/.test(version)) {
    return result('unreleased', `Open Code ${version} is not a release build`);
  }
  if (!parseRelease(version)) return result('unknown', `cannot read Open Code version "${version}"`);

  return compareVersions(version, minimum) < 0
    ? result('below', `Open Code ${version} is older than ${minimum}`)
    : result('ok', `Open Code ${version}, at least ${minimum}`);
}
