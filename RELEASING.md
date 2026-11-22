# Releasing

How a version is decided, what a release run consists of, and what a user has to
do to receive it.

## Versioning

Semantic versioning, and pre-1.0 the slots mean:

| Bump | For |
|---|---|
| **MINOR** (`0.1.0` → `0.2.0`) | anything a user would have to change: a renamed command or flag, a new required state transition, a config key that stops being read, a preflight check that starts blocking, a higher minimum Open Code |
| **PATCH** (`0.1.0` → `0.1.1`) | fixes and additions that break nothing |

`1.0.0` means the state machine, the `pdkit` command surface and the artefact
formats are stable enough that changing them would be a breaking change worth
announcing. Nothing about the current status justifies claiming that yet — see
[section 13 of `docs/specification/`](docs/specification/13-status.md).

The numbering goes on from the Claude Code version. Its releases, 0.1.0 to
0.15.0, were GitHub releases of `vzhukovs/podman-desktop-kit`, installed from
its marketplace; their notes stay in [CHANGELOG.md](CHANGELOG.md), with their
links into that repository. This package's first release is 0.16.0.

### The version lives in one place

`version` in `package.json` is the release. npm publishes the number it
carries, `opencode plugin list` shows an installed copy by it, `opencode plugin
check` and `update` compare it with the registry's, and `pdkit --version`
prints it. There is no second manifest to keep in step with it.

A forgotten bump does not slip through: the new version's tag would not match
`package.json`, which the publish workflow checks first, and npm never
publishes over a version it already has. Two things around the number can still
go wrong in silence, and each has a check:

- **The changelog.** `test/release.test.js` holds `CHANGELOG.md` to
  `package.json`: the newest dated heading is its version, every heading has a
  link definition, and from 0.16.0 on the links go into the repository that
  `repository.url` names — the first release to its tag
  (`releases/tag/v0.16.0`), each later one to the change since the release
  before it (`compare/v0.16.0...v0.16.1`), and `[Unreleased]` to what `main`
  has added since the newest (`compare/v0.16.1...HEAD`).
- **The tag.** The test cannot see it, and npm publishes the version in
  `package.json` whatever the tag says: a `v0.17.0` on a commit that still says
  0.16.1 would put 0.16.1 out under the wrong name. The publish workflow checks
  the tag against `package.json` before it does anything else.

Under Claude Code the version had a second home, `.claude-plugin/plugin.json`,
and a release that forgot to bump it reached nobody, with nothing anywhere
reporting a problem. That manifest is gone, and `test/release.test.js` keeps it
gone.

### The minimum Open Code

`engines.opencode` in `package.json` is the oldest Open Code the plugin
supports, and the one place that says so. CI's `minimum` legs install that
version, `pdkit doctor`'s `opencode` line reports a newer server as tested on
it, and below it the plugin registers the gate alone, with every `/pd:` command
refusing. There is no upper bound: CI's `latest` legs report what a newer Open
Code changed, and never block.

The minimum is the version the code's facts about Open Code were checked on.
It goes up in the commit where the code starts to rely on a fact rechecked on a
newer version, and that commit also:

- adds a CHANGELOG entry — a MINOR, since a user below the new minimum has to
  update Open Code;
- moves "tested on" to the new version in README.md, in the Requirements table
  and in Status and limitations, and the requirement in CONTRIBUTING.md;
- has passed the receipt gate's check by hand on the new version (next section).

### The receipt gate stands on an experimental hook

The receipt gate holds an implementer that stops without a receipt, through
Open Code's `experimental.idle` hook. Open Code takes a hook under any name, so
a version that renames or reshapes this one switches the gate off without a
word: every test stays green, and so does `pdkit doctor`'s `hooks` line. Two
checks see it, both `scripts/check-receipt-gate.js` on a real model:

- **CI's `receipt-gate` job**, at the minimum and at the latest Open Code, with
  the provider's key from the `PDKIT_SMOKE_KEY` secret. A run without the
  secret — a pull request from a fork — skips it, and `receipt-gate-key` says
  why: not run, not passed.
- **The same check by hand**, whenever the minimum goes up, and whenever the
  `latest` leg goes red, to tell a model's slip from a changed hook:

  ```bash
  version=2.4.0                                   # the Open Code to check
  dir="$(mktemp -d)"
  npm install --global --prefix "$dir" "@opencode/cli@$version"
  export PATH="$dir/bin:$PATH"                    # the Open Code you work in stays as it is
  opencode --version                              # opencode v2.4.0
  read -rs DEEPSEEK_API_KEY && export DEEPSEEK_API_KEY   # typed, so it stays out of the history
  node scripts/check-receipt-gate.js --model deepseek/deepseek-flash
  ```

  It runs on Linux and macOS. Another provider is its model and the variable
  Open Code reads that provider's key from.

What the result says:

| Result | Means |
|---|---|
| `result: PASS` | the implementer was held exactly once, for the missing receipt, and let go with its task accepted; the `doctor` line reads `hooks:agent-done ok` |
| `FAIL (hold, journal, doctor)`, with `subagent` ok | the implementer stopped and nothing ran the subagent-stop handler: this Open Code renamed or changed `experimental.idle`, and the gate is off on it. No release with this version as the minimum |
| `FAIL` at `subagent`, or at `hold` with `held N times, not once` | the model did not do what it was told: it started no subagent, or did not run the capture the hold named. The line shows what it did instead. Run the check again |
| `FAIL` at `model` | the key, or the model, is not available here |

The `doctor` step is `pdkit doctor`'s own `hooks:agent-done` check, read
against Open Code's session database, and the fork gives the same reading from
real use: once a subagent of the plugin has stopped there on the new version,
the line is `ok`. A `fail` that says subagents "stopped … and none of them wrote
an agent-done" is the hook not running, and that version is not one to release
on as the minimum.

## Every release

Run in this order. The example releases 0.16.1.

```bash
# 1. The tree is clean and main is current.
git status --porcelain          # must be empty
git pull --ff-only

# 2. Bump the version in package.json, the one place it lives.
#    "version": "0.16.1"

# 3. Move what is under [Unreleased] into a dated release heading, and leave
#    the empty ## [Unreleased] heading above it: test/release.test.js
#    requires it.
#    ## [0.16.1] - YYYY-MM-DD
#    At the bottom of CHANGELOG.md, add the release's link and move
#    [Unreleased] on to it:
#    [Unreleased]: https://github.com/vzhukovs/opencode-pdkit/compare/v0.16.1...HEAD
#    [0.16.1]: https://github.com/vzhukovs/opencode-pdkit/compare/v0.16.0...v0.16.1
#    A release a user must do anything for opens with ### Upgrading: the
#    update command, the gate self-test, and what to change — and, for a
#    MINOR, the one sentence on why it is not a PATCH.

# 4. The suite, including the version and changelog guard.
npm test

# 5. The package, packed as npm will ship it, loads in Open Code: the script
#    installs the tarball into a throwaway Open Code server and reads back
#    from the server the plugin's state, its commands and its agents.
#    Linux and macOS; CI runs it again at the minimum and the latest Open Code.
node scripts/check-plugin-load.js

# 6. The gate, against a real podman-desktop fork. This is the only check that
#    answers "is the gate actually on"; the suite stays green without it.
node bin/pdkit doctor --gate-selftest --repo /path/to/podman-desktop

# 7. Commit, and push the release commit and nothing else yet.
git commit -am "chore(release): 0.16.1"
GIT_NO_REPLACE_OBJECTS=1 git push origin main

# 8. Wait for CI on that commit (the run takes a few seconds to be listed),
#    then read every job: the minimum legs do not fail the run yet, so a green
#    run is not enough. Stop here if any job but a `latest` leg is not
#    `success`.
run="$(gh run list --commit "$(git rev-parse HEAD)" --workflow ci.yml --event push -L 1 --json databaseId -q '.[0].databaseId')"
gh run watch "$run" --exit-status
gh run view "$run" --json jobs -q '.jobs[] | "\(.conclusion)\t\(.name)"'

# 9. Only then tag. The tag starts the publish workflow.
git tag -a v0.16.1 -m "opencode-pdkit 0.16.1"
GIT_NO_REPLACE_OBJECTS=1 git push origin v0.16.1
gh run list --workflow publish.yml -L 1        # the run the tag started
gh run watch <its id> --exit-status

# 10. npm has it: this prints the version, if not always at once (below).
#     Then the GitHub release, from the changelog. The section's links are
#     relative to the repository, and a release page would resolve them
#     against itself, where there is nothing, so each one goes into the tag:
#     a file at its path there, an anchor in the tag's CHANGELOG.md.
npm view opencode-pdkit@0.16.1 version
notes="$(mktemp)"
blob=https://github.com/vzhukovs/opencode-pdkit/blob/v0.16.1
sed -n '/^## \[0\.16\.1\]/,/^## \[/p' CHANGELOG.md | sed '$d' |
  sed -E -e "s,]\(#,]($blob/CHANGELOG.md#,g" \
         -e "s,]\(([^)#:]+)([#)]),]($blob/\1\2,g" > "$notes"
grep -E ']\((#|[^):]+[#)])' "$notes"   # prints nothing: all are absolute
gh release create v0.16.1 --verify-tag --title "0.16.1" --notes-file "$notes"
```

A pull request does as well as the push in step 7, merged by rebase like any
other change here. Pull `main` after the merge: the commit on `main` then has
another hash than the branch's, and steps 8 and 9 are about `main`'s.

Steps 5 and 8 stand where two of the Claude Code version's stood. It ran
`claude plugin validate . --strict` on the manifest; Open Code has no command
that validates a plugin, and when one fails to load, the server runs on without
it and every CLI command still exits 0, so step 5 asks the server. It also
loaded the release with `claude --plugin-dir . -p "/pd:doctor"` to invoke one
skill. In Open Code every `/pd:` command runs on a model, and `opencode run`
does not execute a plugin's command at all — the text goes to the model, which
can imitate the answer from the plugin's source. The check that takes a model
through the plugin is CI's `receipt-gate`, read at step 8. None of this
replaces use. In Open Code the routes have run on real models only against a
private copy of podman-desktop, and no podman-desktop issue has been worked
through the plugin yet — see
[Status and limitations](README.md#status-and-limitations).

Step 8 exists because steps 4–6 run on one machine. CI runs the suite on
Ubuntu, macOS and Windows, and a path separator or a shell quirk shows up only
on the platform that has it. The Claude Code version learned this at 0.10.0,
which was tagged and published before CI had finished: its Windows job then
failed on two tests that every local run had passed, and the fix had to ship
after the release. A red run at step 8 costs a new commit. A red run after the
tag means a release that is already public, and that cannot be taken back: npm
never publishes a version twice, and once a user has run `opencode plugin
update`, it is on their machine.

If step 8 is red, fix it on `main`, push, and wait for green again. Do not move
the release commit to the fix: the version bump and the fix are two commits,
and the tag goes on whichever is newest once CI passes.

Step 8 reads each job because of the `minimum` legs of `plugin-load` and
`receipt-gate`. They are a condition of the release — the minimum is the version
the package promises to load and hold on — but not yet of a merge: they run with
`continue-on-error` until a record of green runs shows they are reliable enough
to stop one, and until then a red leg leaves the run green. The `latest` legs
never block: a red one says a newer Open Code changed something, a reason to run
the hand check above, not to hold a release that promises nothing about that
version. If `receipt-gate` was skipped — the run had no key — run the check by
hand on the minimum before the tag. The publish workflow reads the jobs the same
way, and warns that it cannot tell whether a skipped check was run by hand.

Step 10's `npm view` may answer `E404` for a while after `publish` has passed.
npm kept the first version, 0.16.0, out of sight for about four minutes after
it was published, while the version's page on npmjs.com said "Validating:
Automated review hasn't finished"; whether it does so with every version is not
known yet. Ask again until it prints the version, and do not re-run the publish
workflow meanwhile: its `verify` asks npm the same question, and an `E404` would
send `publish` after a version npm already has.

## The publish workflow

[`.github/workflows/publish.yml`](.github/workflows/publish.yml) runs on a tag
`v*`, in two jobs.

`verify` publishes nothing and holds no token that could. It checks, in this
order:

1. the tag is `v` and the version `package.json` carries;
2. CI's run for the push of this commit to `main` has finished, and each job
   passed: the suite on all three systems, `plugin-load` and `receipt-gate` at
   the minimum, `receipt-gate-key`. The `latest` legs are listed and never
   block; a skipped `receipt-gate` is a warning, as above. A job missing from
   the run fails it, so a job renamed in `ci.yml` is renamed there too;
3. whether npm has this version already. If it has — the first release,
   published by hand, or a re-run after a publish that went through — the run
   says so and publishes nothing, and `publish` shows as skipped. It asks
   with `npm view`, which does not see a version npm is still validating (see
   step 10).

`publish` runs `npm publish` by trusted publishing: npm exchanges the job's OIDC
token for a one-time publish, so no npm token is kept in the repository's
secrets. The job has `id-token: write` and `contents: read`, and nothing else.
Trusted publishing needs a GitHub-hosted runner, npm 11.5.1 and Node 22.14.0 or
later; the job sets up Node 24 and checks both before it publishes. Provenance
comes with it, since the repository and the package are both public: the
version's page on npmjs.com links it to the commit and the workflow run that
built it.

npm trusts the workflow by its file name. Renaming `publish.yml` means changing
the trusted publisher on npmjs.com with it.

### When the publish workflow stops

Nothing reached npm, so the version is still free; `npm view` confirms it.

- **CI was still running.** Re-run the workflow once CI has finished:
  `gh run rerun <id>`.
- **The tag is not `package.json`'s version, or CI did not pass on the commit.**
  The tag is on the wrong commit. Delete it — `git push origin
  :refs/tags/v0.16.1` and `git tag -d v0.16.1` — fix `main` as for a red step 8,
  and tag again once CI is green. The version stays: npm never had it.
- **`npm publish` failed.** The job's log says why. A cause outside the
  repository, such as the trusted publisher's settings, is fixed there and the
  job re-run; one that needs a commit is the case above.

## First publication

Once, for 0.16.0. npm attaches a trusted publisher to a package that exists, so
the first version goes up by hand, from the maintainer's machine, and the
workflow publishes from the second on.

1. **The npm account.** Sign in to the `vzhukovs` account, with two-factor
   authentication on: npm requires it to create and to publish a package.

   ```bash
   npm login
   npm whoami                    # vzhukovs
   ```

2. **The name is free.** `npm view opencode-pdkit` answers `E404`.

3. **The release commit.** Steps 1 to 8 of every release, for 0.16.0, with one
   difference in step 3: no release comes before it in this repository, so its
   link goes to its own tag.

   ```text
   [Unreleased]: https://github.com/vzhukovs/opencode-pdkit/compare/v0.16.0...HEAD
   [0.16.0]: https://github.com/vzhukovs/opencode-pdkit/releases/tag/v0.16.0
   ```

4. **Publish by hand**, from that commit with a clean tree, in a terminal: npm
   asks for the second factor there. Started where no terminal can answer — a
   shell an agent runs for you, such as Claude Code's `!` — `npm publish`
   prints a link to sign in with and stops at once with `EOTP`, having
   published nothing. `npm publish --otp=<code>` takes a code from an
   authenticator app on the command line instead.

   ```bash
   git status --porcelain        # empty
   npm publish
   npm view opencode-pdkit@0.16.0 version    # again, until it prints 0.16.0
   ```

   The version did not appear at once. npm first put up a placeholder,
   `0.0.0-stage` ("Temporary package placeholder for staged publishing"), with
   `latest` on it, while the version's page said "Validating: Automated review
   hasn't finished" and `npm stage list` showed nothing staged. About four
   minutes after the publish, `npm view` found 0.16.0, and `latest` had moved
   to it. The placeholder stays in the package's list of versions.

   This one version carries no provenance: npm makes provenance only in a
   cloud CI.

5. **The tag**, as in step 9, once `npm view` prints the version. The publish
   workflow runs on it, finds 0.16.0 on npm, and publishes nothing; tagged
   earlier, it would find no version and send `publish` after it.

6. **The GitHub release**, as in step 10.

7. **The trusted publisher**, on npmjs.com in the package's settings: GitHub
   Actions, user `vzhukovs`, repository `opencode-pdkit`, workflow
   `publish.yml`, no environment. Under **Allowed actions**, allow publishing
   directly with `npm publish`: a configuration created after 2026-09-03
   allows only `npm stage publish` until told otherwise, and the workflow does
   not stage. npm does not check the settings when they are saved, and a new
   configuration must complete its first successful publish within two days —
   so save it when 0.16.1 is ready to tag, not before.

8. **The first release through the workflow** checks all of it: `publish`
   passes, and the version's page on npmjs.com shows its provenance. Should
   npm refuse the provenance over the repository, `repository.url` takes the
   form npm's error names, in a new version.

If npm refuses the name itself — too like another package's, which only a first
publish finds out — stop there. The fallback is the scoped name
`@vzhukovs/opencode-pdkit`, and switching to it is a change of its own, through
CI like any other: `name` in `package.json` and `"publishConfig": { "access":
"public" }` (a scoped package is private unless published public); the install
and upgrade lines in README.md and in this file; the trusted publisher; and
`lib/doctor.js` and `scripts/plugin-server.js`, which look for the plugin under
the package's name. The plugin's own id stays `opencode-pdkit`, so a config that
names it, such as `-opencode-pdkit`, does not change.

## How a user receives an update

Open Code does not update a plugin by itself. A server looks for a newer version
when it activates and once a day, and marks the plugin as outdated —
`pdkit doctor`'s `plugin` line then says an update is out — but taking it is the
user's:

```bash
opencode plugin check     # is a newer version out
opencode plugin update    # take it
```

`update` installs the new version and reloads the plugin in every directory of
the running server: there is nothing to restart. Another server under the same
home, such as one started with `--standalone`, keeps the old version until it
next activates.

An exact version is never updated, and a range only within itself. Pre-1.0 a
MINOR is the release that may ask something of the user, so a range on one
minor takes the fixes and leaves the rest for a deliberate step:

```bash
opencode plugin remove opencode-pdkit
opencode plugin add 'opencode-pdkit@^0.16.0'    # 0.16.x, never 0.17.0
```

Going back to a version is the same two lines, with that version:

```bash
opencode plugin remove opencode-pdkit
opencode plugin add opencode-pdkit@0.16.0
```

`plugin remove` takes the entry's `options` with it, the model map included:
put them back after (see [Model selection](docs/configuration/05-models.md)).

**After any upgrade, they should run one command**, in the fork:

```bash
pdkit doctor --gate-selftest
```

The gate is registered by the plugin's entry point and run by Open Code. An
upgrade that broke the wiring leaves every unit test green and the plugin
gating nothing, and this is the check that can tell — with the `plugin` line of
the same report, which says whether Open Code loaded the plugin at all.

`pdkit --version` prints the installed version, and, for a working copy that a
config names by its path, the commit it was built from, with `, modified` if the
checkout is dirty — worth asking for in any bug report, alongside
`pdkit doctor`.

## What a release must not do

- **Tag anything but the version in `package.json`.** The publish workflow
  refuses it; see [When the publish workflow stops](#when-the-publish-workflow-stops).
- **Change a format in `$PDKIT_HOME` without saying so.** The directory is
  shared with the Claude Code version 0.15, which reads it as it is today, and
  `state.json` carries no format version that would tell either side what wrote
  it. Any change to a format there — `state.json`, an issue's artefacts, a
  journal line, `active/`, the `cost` snapshots — comes with a CHANGELOG entry
  that says "the Claude Code version 0.15 no longer reads …". From that release
  on, going back to the Claude Code version is not safe, and that entry is the
  only thing that says where the line is (see
  [Moving from the Claude Code version, and back](README.md#moving-from-the-claude-code-version-and-back)).
  This version reads every older format, always.
- **Change `$PDKIT_HOME`'s layout without a migration.** State lives outside the
  repository precisely so it survives plugin updates. A release that renames a
  file under `issues/<n>/` orphans every issue in flight; if one has to, it needs
  a `pdkit` command that performs the move and a MINOR bump.
- **Widen what the gate allows without saying so in the changelog.** That is the
  one behavior whose failure mode is public and irreversible.
- **Raise the minimum Open Code** on a fact checked on the old one, or without
  the receipt gate checked by hand on the new one.
- **Push anything but the branch and the tag, by name.** A clone may hold refs
  that are not this repository's: a `git replace` graft onto the Claude Code
  version's history under `refs/replace/`, and `refs/remotes/cc/main` (see
  [Commits and pull requests](CONTRIBUTING.md#commits-and-pull-requests)).
  `git push origin main` and `git push origin v0.16.1` push what they name;
  `git push --mirror` and `git push origin 'refs/*'` would publish both.
