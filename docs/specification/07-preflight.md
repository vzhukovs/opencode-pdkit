# 7. Preflight — the deterministic gates

[Specification](README.md) › Section 7

`pdkit preflight [--slice N]` returns a machine-readable report. Twenty-six checks,
in the order `CHECK_IDS` in `lib/preflight/index.js` runs them:

| Check | How | Blocking |
|---|---|---|
| **working tree** | `git status --porcelain` is empty. First in the report: without it the rest are ambiguous | ✅ (untracked files ⚠️) |
| **quickfix size** | diff lines counted separately for code and tests, against `quickfix.max_changed_lines` and `max_files`. Only on the `quickfix` route | ⚠️ never blocks |
| tests | `pnpm test:<project>` per affected package, falling back to `pnpm test:unit` | ✅ |
| lint | `pnpm lint:check` | ✅ |
| typecheck | `pnpm typecheck`, the whole repository — a type error lands in the consumer of a change. `preflight.typecheck_scope: packages` narrows it to `pnpm typecheck:<package>` and says so | ✅ |
| SPDX | every added file carries the header in the repository's house format — the Apache block with the copyright line, the identifier inside it | ✅ |
| conventional commits | every commit on the branch: a type from the list in `CONTRIBUTING.md`. **Scope is not required by upstream** — its absence is a note on a passing check, not a failure | ✅ on type, a note on scope |
| Signed-off-by | exactly one per commit | ✅ |
| schemas | `pnpm generate:schemas` produces no diff | ✅ |
| extension-api | if `extension-api.d.ts` is touched, the body must carry a backwards-compatibility and disposal section | ✅ |
| **API-surface grep** | every new or changed exported type is grepped in `extension-api.d.ts`; found means it is public API, not an internal utility | ✅ |
| slice standalone | the `pdkit slice verify` result from `slices.json` plus a digest comparison. A stale result is `fail`, not `pass`; a red run against a red baseline is `warn`, marked inconclusive | ✅ for slices with `base: main` |
| **merge order** | every merge order the body states — `#A → #B`, "depends on #A", "after #A merges" — between this issue's slices is a stack in the graph. An order between independent slices is a dependency nobody verified, and main is broken between those merges | ✅ |
| branch name | matches `DESKTOP-<n>/[<i>-]<slug>` | ✅ |
| **PR body from the template** | every section, fixed line and footer `templates/pr-body.md` declares is in the body. Eleven checks read the body and each reads a part of it; this one asks whether it is the shape upstream's template wants at all | ✅ |
| **PR body size** | each section of the body against its budget in characters, and the total. `How to test this PR?` is bounded by its heading and not counted: it is the one section a reviewer executes rather than reads | ⚠️ never blocks |
| steps-to-check | ≥ 3 steps, each with an expected result. Applies on `quickfix` too | ✅ |
| e2e stability | a new `tests/playwright` test passed `validation.e2e_stability_runs` times in a row; the series is tied to a digest of the spec, and a stale one is `fail` | ✅ if e2e was added |
| e2e environment | a test needing an environment CI does not have requires a `Notes for reviewers` entry | ✅ |
| **validation evidence** | a validation step with no attached artefact is named in `Notes for reviewers`. Skipped on `quickfix` and when `validation.require_evidence: false` | ✅ |
| **UI evidence** | a pull request that changes a component (a `.svelte` file in its diff) shows it in `Screenshot / video of UI`: an image or a video — a markdown image, an `<img>` or `<video>` tag, the link GitHub writes for an uploaded file. A screenshot placeholder left in the body, or a section that shows nothing and says no `n/a`, fails; `n/a` beside a changed component warns, for the self-review to judge whether nothing visible changed. The first pass lists the components and the validation's screenshots with their files: nothing in the plugin can upload an image, so the person does | ✅ |
| debug leftovers | `console.log`, `.only`, `.skip`, `@ts-ignore`, `any` in the diff | ⚠️ warn, listing them |
| **maintainer rules** | the greppable part of `knowledge/maintainer-rules.md` in the added lines, each pattern scoped to the files its rule covers. **Strict** patterns are rules with no exception: `vi.spyOn`, `Object.defineProperty(window)`, `vi.stubGlobal`, `clearAllMocks`, `afterEach`, a real `setTimeout` sleep, `toBeDefined()`, a typed `Mock` (`: Mock`, `: MockInstance<…>`, `as Mock`) and a cast of a value (`card as HTMLElement`; not `as const`) in unit specs; `as unknown as`, `any`, `!`, `eslint-disable` (bar the empty-interface exception section 4 names), `*Sync(`, an empty `catch`, `void` on a promise, `../` imports, built-ins without `node:`; an exported or file-scope function and `app.name` in `packages/main`; `<style>`, `$:`, `tick()` and Node types in renderer code; a hardcoded "Podman Desktop", a hex color in the color registry; a copyright year other than this one; **a comment the branch adds**, the plugin's own rule (below). **Judged** patterns are rules with a condition a grep cannot see: a `vi.mock` factory, `vi.hoisted`, `vi.importActual`, `mockImplementation(async () =>`, a cast of an object or array literal in a unit spec (a fixture), `sort()`, `await import()`. `pdkit self-review target` runs this check on the commit it hands the review axes and refuses one it fails, before a round starts | ✅ on a strict hit; ⚠️ warn on a judged one, which the self-review rules on |
| **self-review** | the four review axes and the synthesis read this commit and this body (`pdkit self-review record`, keyed by slice in `self-review.json`), and nothing they found that upstream's agent rejects a pull request for is open: no `issue:`, no unanswered `question:`. A `nit:`, on new code or old, stays in the record and is counted in the summary, and does not block — upstream's agent accepts a pull request with nits. A review of another commit or another body is a `fail`. After `review.self_review_rounds` commits in a row reviewed without a clean review — a round starts at `pdkit self-review target` — the remedy is to stop and ask the person rather than to run another round. Reads the body | ✅ |
| CI blind spots | the diff touches build, packaging, platform-specific behavior or the **dependency graph** — CI will not check it; a `Notes for reviewers` entry is required, worded per the area that fired | ✅ |
| **body must disclose** | the plan's `## Body must disclose` names lines for this pull request — a line naming `S<i>` is slice `i`'s, one naming none is every pull request's — and `Notes for reviewers` is written: not empty, not `n/a`. Whether it says each line a grep cannot tell, and the summary says so; the self-review judges it. The first pass lists the lines. Skipped on `quickfix`, with no plan, and for a plan written before the section | ✅ |

Four results, and the difference between them matters: **pass** (the check ran
and was satisfied), **skip** (it did not run, and the summary says why), **warn**
(an advisory check found something), **fail** (blocking, unless the check is
advisory). A skip is never a pass. Whether a check is advisory is its own
`blocking` export — three are: `quickfix-size`, `pr-body-size`, `debug-leftovers`.
`maintainer-rules` is blocking and still answers `warn` when every hit is a
judged one: a warning from a blocking check does not stop a push.

**A comment is the plugin's rule, not upstream's.** Section 4 of the
maintainer's rules only asks that comments adding nothing be removed, a
`nit:`. `agents/pd-implementer.md` allows none a rule does not ask for, and
`maintainer-rules` holds every code file of the repository to it — `.ts`,
`.js`, `.mjs`, `.cjs`, `.tsx`, `.jsx`, `.svelte`, `.html`. An added line fails
when a comment the branch wrote is on it: `//`, `/* */`, JSDoc, `<!-- -->` in
Svelte and HTML markup, at the end of a line of code, an edited one, a
directive such as `@ts-expect-error` or `svelte-ignore`. It passes the
comments a rule asks for — a new file's license header (its first comment,
the house block the `spdx` check asks for, in Svelte inside `<!-- -->` too),
JSDoc in `packages/extension-api`, the `eslint-disable` of an empty
interface — and a comment whose text the diff removes elsewhere, which moved
with its code rather than being written. Under `packages/` an `eslint-disable`
is its own pattern's to report. The check reads each changed file at the ref
(`lib/preflight/comments.js`), not the added line alone: `//` inside a string,
a template literal or a regular expression is not a comment, and a line added
inside a block comment opened above it is one.

**There is no R-ID coverage check any more.** `r-coverage` required every R-ID to
appear in the published body, and was removed: `requirementProblems()` in
`lib/slice.js` already refuses to store a graph in which a frozen requirement
reaches no slice, so the check added no guarantee — only a demand on the shape
of the body. See the `Removed` entry in `CHANGELOG.md`.

**API-surface grep** is a direct codification of the `RunOptions` trap: the type
lives in `packages/main/src/plugin/util/exec.ts` and looks like an internal
utility, but it is also declared in `extension-api.d.ts`, making it public API.
This is not a heuristic for an agent, it is a grep, and it belongs in preflight
rather than in a prompt.

**The dependency-graph area of `ci-blind-spots` is keyed on the lockfile, not on
`package.json`.** The difference is measurable: a manifest edited on its own — a
renamed script, a version field — installs exactly what was installed before, and
demanding a paragraph for it would price the gate where there is no risk. The
lockfile (plus `pnpm-workspace.yaml`, `.npmrc`, `patches/`) is a statement that
the resolved graph changed, and that is precisely what unit tests on one platform
do not exercise: the breakage arrives transitively, a level below the diff.

That check's requirement is worded **by the area that fired**. It used to ask
about the platform whatever the finding was, and a requirement naming the wrong
thing gets answered with the wrong thing — after which the check passes on a note
about nothing. The same defect was fixed in `steps-to-check` and in the config
arrays message: **a message wider than its measurement**.

**validation evidence** is what makes `unverified` different from silence. It
does not require validation to have passed; it requires the unverified to be
**named** to the reviewer. The form is taken from `ci-blind-spots` and the
argument is the same: in both cases something exists that the gate did not check,
and silence about it reads as checked.

Both of those read the PR body, and both must say so by exporting `needsBody`,
which puts them among the checks in `BODY_DEPENDENT` that the second pass runs —
all eleven: `extension-api`, `merge-order`, `pr-body-template`, `pr-body-size`,
`steps-to-check`, `ci-blind-spots`, `e2e-environment`, `validation-evidence`,
`self-review`, `ui-evidence`, `body-must-disclose`. A check that depends on the
body without declaring it stays forever at its first-pass result, `skip` — the
worst possible outcome, because it looks like a check that ran. Not every one of
the eleven needs the body on every diff, so the note after pass one counts only
those that actually skipped for lack of it, and names them. It knows them by the
field `waitingFor: 'body'` on the result — not by the summary's wording, which
each check is free to change — and the field stays out of `--json`.

Under each check that waits for the body, the report of pass one prints what it
lists for the body: the areas CI cannot judge, the validation steps with no
artefact, the lines the plan's `Body must disclose` names for this pull request,
the components it changes and the screenshots the validation took. The body is
written from that list. Any other check's output is a run's, and stays in
`--json`.

Pass two reads the body from `--body <file>`, or, for a pull request that is
already open, from `--body-from-pr <k>` — after a rebase or a review round, where
the body that matters is the one upstream has.

**working tree** was not added out of tidiness. The checks in this table read two
different states: file checks (`spdx`, `api-surface`, `debug-leftovers`) look at
the committed diff `base...ref`, while command checks (`tests`, `lint`,
`typecheck`) run whatever is on disk. On a clean tree those are one thing. On a
dirty one the report mixes two and can go green on a diff that will not be
pushed. Not hypothetical: the first full run on the fork produced a red
`test:renderer`, caused by uncommitted work in `packages/preload` that the
renderer tests pick up — while the file checks were reading a commit without it.

**The base is a ref, not a branch name.** `repo.base_branch` names a branch, and
on a fork the local branch of that name is a copy of the base as fresh as the
last pull. First live run: a local `main` 491 commits behind turned a two-file
diff into an 805-file one, and preflight reported four blocking failures about
other people's work — a license header on a file we never touched, 87 commits
with the wrong sign-off, eight public API symbols. Nothing looked wrong. The base
now resolves to `<upstream_remote>/<base_branch>` when that ref exists, and **the
report prints which ref it read, at what sha and from what date**: a
remote-tracking ref goes stale too, and a measurement has to say what it saw.

**And the ref comes from there too.** Taking the base from the graph was half the
rule: the ref stayed `HEAD`, so the report was about the slice exactly when
preflight was run from the slice's own worktree. From anywhere else every file
check read an unrelated change without a sign, because `HEAD` always resolves. So
the ref is now the slice's branch; if the branch does not exist yet the run
**refuses**, because the flow materializes before preflight and answering about
`HEAD` would answer a question nobody asked. An empty diff under a slice is also
refused: every check passes on nothing, and a green report would open the gate on
a branch with nothing on it.

**The scripts are held to the same ref.** The file checks read `base...ref`, but
`tests`, `lint`, `typecheck` and `schemas` run what the tree has checked out.
When that is another commit than `ref` — the issue's tree on the branch its
slices were cut from, `preflight --slice 1` — each of them **fails without
running**, names both commits, and says where to run it. A green there would be
about the other branch and reported as the slice's. A `slice verify` run on the
slice's own commit still counts (below): it is about the right commit wherever
the tree stands.

**The base comes from the graph, not from the config.** Every file check reads
`base...ref`, and for a stacked slice the base is the predecessor's branch. From
`main` the stack's diff contains the previous slice's changes, and `spdx`,
`api-surface`, `debug-leftovers` and `conventional-commits` start reporting on
somebody else's work — confidently, with no sign they are reading the wrong
thing.

**A run `slice verify` has just made is not made again.** `tests`, `lint` and
`typecheck` reuse the slice verification's run when its receipt validates,
exited 0, names this exact commit, covers every script the check would run, and
the tree has no tracked change. The commit says what was verified while the
scripts run the working tree, which is why a tracked change disqualifies it.
Verify and preflight back to back had outlived a 600-second timeout, running the
same scripts on the same commit twice.

**A tree is tested once.** `tests`, `lint`, `typecheck` and `schemas` take the
pass of an earlier run of the same issue on the same tree — `git rev-parse
<commit>^{tree}` — when that run's `working-tree` found nothing uncommitted, its
scripts cover every script the check would run now, and the tree has no tracked
change. A squash or a reworded message makes a new commit, not a new tree, and
on the quickfix route the same tree used to go through the whole of preflight
three times: at the end of `/pd:quickfix`, in `/pd:preflight`, and in `/pd:pr`
after its squash. The summary names the commit and the time of the run that
measured the pass. The latest such run on the tree decides, so a failure is
never taken and a pass a later red run contradicts is not either: the scripts
run again. Each run in `preflight.json` records its `tree`, and each script
check's pass the `scripts` it covered; a run recorded before has neither and is
never taken.

**The environment is not the code.** A script that could not start — exit 127,
or 9009 on Windows, `pnpm` not on `PATH` — is reported as `could not run: … —
the environment, not the code`, not as failing tests with a remedy for broken
tests. It still blocks: nothing was measured.

**Script names are not hard-coded.** The "How" column above shows a shape, not a
constant: preflight resolves the name from the repository's own `package.json`,
walking a candidate chain and taking the first that exists. The package for
`<project>` / `<package>` comes from `package-map.json`. The reason is direct:
podman-desktop has no `pnpm lint`, and its `pnpm test` drags in the e2e suite, and
upstream renames scripts without notice. A hard-coded name, after a rename,
becomes a check that silently does not run — the worst possible outcome for a
gate. If no candidate is found the check returns **`skip` with an explanation,
not `pass`**. The override is the `preflight:` block in the config, empty by
default: the config is the emergency exit, not the first source.

**conventional commits** is calibrated against the real repository.
podman-desktop's `commitlint.config.cjs` is a bare `config-conventional`, and its
`CONTRIBUTING.md` writes the format as `<type>[optional scope]`; commits without
a scope reach `main` regularly. Requiring a scope as blocking would reject valid
pull requests. We still write scopes — they tell a reviewer which area they are
being asked about — but that is our discipline, not upstream's rule, and it is
never raised in a review of somebody else's PR.

---

**In brief** — [`architecture/`](../architecture/README.md): [4 · The slicer](../architecture/04-slicer.md)

**In practice** — [`workflows/`](../workflows/README.md):

- [What preflight actually runs](../workflows/reference/preflight.md)

← [6 · Hooks](06-hooks.md) · [Contents](README.md) · [8 · MCP servers](08-mcp-servers.md) →
