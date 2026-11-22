# Podman Desktop Kit for OpenCode

An [Open Code](https://opencode.ai) plugin for working upstream issues in
[podman-desktop](https://github.com/podman-desktop/podman-desktop): triage an
issue, plan it, implement it, slice the result into atomic pull requests, and
carry those pull requests through review — each phase and each agent on a model
of its own, from any provider Open Code is connected to.

It is the Open Code port of
[podman-desktop-kit](https://github.com/vzhukovs/podman-desktop-kit), the Claude
Code plugin, as of its 0.15.0. The Claude Code version gets no further updates;
this one carries on from it, state included — see
[Moving from the Claude Code version, and back](#moving-from-the-claude-code-version-and-back).

It is built around one fact — **you do not own the repository you are opening
pull requests against** — and most of what follows is a consequence of that.

> **Status: pre-1.0; in Open Code, run on copies of podman-desktop issues, not
> yet on a live one.** The Claude Code version was used on thirteen
> podman-desktop issues and carried seven of them all the way to `merged`. In
> Open Code, the `quickfix` route, the `standard` route as far as its first pull
> request, and `pr-sync` have run on real models, against a private copy of
> podman-desktop on GitHub. Nothing has been pushed, opened or answered in
> podman-desktop itself. Pre-1.0, a minor release may still change a command or
> the state machine — see [RELEASING.md](RELEASING.md).
> [Status and limitations](#status-and-limitations) has the full accounting.

## Why it exists

Working someone else's repository is different from working your own. You cannot
store workflow state in the tree, you cannot open scratch issues, and a sloppy
push is public noise in a project you do not own. The plugin encodes that
asymmetry:

- **State lives outside the repository**, in `$PDKIT_HOME`, keyed by issue
  number. Five worktrees see one state, not five copies of it.
- **Writes to GitHub pass a gate.** `git push` and `gh pr create` are denied by a
  hook unless a short-lived consent token exists for that exact branch. Writes to
  the issue tracker are denied outright — a human posts those.
- **"Done" means attached command output**, not a claim. Task completion is
  blocked without a receipt, and `pdkit` runs the command itself, so there is no
  parameter through which a summary could stand in for a run.
- **One change set becomes N atomic PRs.** Slicing is verified mechanically: a
  slice is independent only if it builds, lints, and tests standalone from
  `main`.

## Requirements

| Required | Why |
|---|---|
| Open Code 2, 2.3.0 or later | the plugin is written against Open Code 2's plugin API, and tested on 2.3.0. Below 2.3.0 it runs the gate alone, and every `/pd:` command refuses, naming the command that updates Open Code |
| Node.js >= 22.13 | `pdkit` is zero-dependency ESM, and so is every hook: the plugin starts them with the `node` on the PATH of the Open Code server. `pdkit cost` reads Open Code's sessions with `node:sqlite`, which needs no flag from 22.13. Installing the plugin does not need Node |
| `git` | branch, worktree, and history primitives |
| [`gh`](https://cli.github.com/) | issues, pull requests, and review threads |
| `pnpm` | the package manager podman-desktop uses |

### Open Code 2

Any one of these installs it:

```bash
brew install anomalyco/tap/opencode-v2           # Homebrew, the project's tap
brew install opencode                            # Homebrew core: built from the release tag, updated less often
npm install --global @opencode/cli
curl -fsSL https://opencode.ai/v2/install | bash
```

**Open Code 1 is not supported.** It is still published, under the names it
always had — `opencode-ai` on npm, the `anomalyco/tap/opencode` formula,
`https://opencode.ai/install` — and the two do not install side by side: one
`opencode` command, one config directory. Open Code 1 reads that config, skips
its `plugins` key with a line in its log, and runs without the plugin: no `/pd:`
commands, no agents, and no gate. `opencode --version` prints `opencode v2.…`
for Open Code 2; `opencode upgrade --major` moves from 1 to 2.

### Optional MCP servers

All detected by `pdkit doctor`, all degrading gracefully when absent:

| Server | Used by | Without it |
|---|---|---|
| Playwright | `/pd:validate` | `pd-validator` gets no browser tools. `/pd:validate` still launches the application; a step the validator cannot back with an artefact stays `unverified`, as a checklist for a human, and PASS needs an artefact either way |
| context7 | planning and review, for questions about someone else's library | the answer comes from the model's own knowledge of that library's versions, which goes out of date without saying so |

The plugin declares no MCP server on purpose: one declared by a plugin would load
for everyone, and these are meant to be optional. Configure them yourself; see
[`docs/configuration/`](docs/configuration/README.md).

Playwright is the one with a setup detail worth stating here. `pdkit validate
launch` starts the application with remote debugging on and prints the endpoint;
the server attaches to it, which is how podman-desktop's own e2e suite drives the
app. Once per machine, beside `plugins` in your global Open Code config,
`~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "servers": {
      "playwright": {
        "type": "local",
        "command": ["npx", "@playwright/mcp@latest", "--cdp-endpoint", "http://127.0.0.1:9222"]
      }
    }
  }
}
```

The global config matters: `opencode mcp add` writes the `opencode.json` of the
directory it runs in, and a project config there does not reach the issue
worktrees, each of which is a directory of its own. `pdkit doctor` reports the
endpoint it found and whether `pd-validator` is offered the tools it drives the
app with, not merely that a server exists.

## Install

**One clone, two remotes.** Upstream is never checked out separately — diffs
against `main` come from `upstream/main` in the same clone.

```bash
# fork podman-desktop on GitHub first, then
git clone git@github.com:<you>/podman-desktop.git
cd podman-desktop
git remote add upstream https://github.com/podman-desktop/podman-desktop.git
```

Then add the plugin:

```bash
opencode plugin add opencode-pdkit
```

Open Code installs the package into its own cache and adds it to `plugins` in
your global config, `~/.config/opencode/opencode.json`; a running server picks it
up within seconds. Global is the point. The plugin then loads in the fork and in
every issue worktree beside it (`pd-worktrees/DESKTOP-<n>`), even with
`OPENCODE_DISABLE_PROJECT_CONFIG` set. A project config would reach neither the
worktrees nor, being a file in the fork, stay out of your pull requests.

### First run

Start Open Code in the fork:

```bash
cd podman-desktop
opencode
```

and type these there. A line that starts with `!` goes to the shell, not to the
model:

```text
!pdkit init                      # state directory, config, package map
!pdkit doctor                    # what is missing and what degrades without it
!pdkit doctor --gate-selftest    # the only check that answers "is the gate on"
```

`pdkit` is on PATH there because the plugin puts its `bin/` first on the PATH of
every command an Open Code session runs: the model's, a subagent's, and yours
after `!`. On Windows that command runs in PowerShell when Open Code finds one,
and in Git Bash or cmd.exe otherwise; `pdkit` runs in all three.

`init` reads your fork's name from the `origin` remote and writes it into
`$PDKIT_HOME/config.yaml` — there is nothing to configure by hand before running
it, nothing to type that the clone does not already know, and nothing it writes
into the fork.

Among the lines of `doctor` about Open Code: `opencode`, the version of the
server running the plugin, against the minimum; `plugin`, whether Open Code loads
`opencode-pdkit` for this directory, and whether an update is out; `hooks:node`,
the `node` the server starts the hooks with; and `models`, below. `/pd:doctor`
runs the same report and goes through it with you — on a model, as every `/pd:`
command does, which is why the first run uses `!`.

Run the self-test after installing and after any upgrade. It sends every command
the gate must refuse, and the ones it must let through, through the runner the
hook bridge calls when Open Code hands it a command: a `node` from PATH, the
plugin's `bin/pdkit hook`, the deadline, and a refusal when no answer comes.
Every unit test in the suite stays green on a machine where the hooks cannot
start — there the gate refuses every command, and the other hooks check nothing
— so it is the one check that cannot be replaced by the test suite. Whether Open
Code runs the bridge at all is the `plugin` line.

### Upgrading

```bash
opencode plugin check     # is a newer version out
opencode plugin update    # take it
```

`update` reloads the plugin in every directory of the running server; there is
nothing to restart. To stay on a version, or go back to one:

```bash
opencode plugin remove opencode-pdkit
opencode plugin add opencode-pdkit@<version>
```

An exact version is never updated. A range is, within itself:
`opencode-pdkit@^0.16.0` takes 0.16.x and leaves 0.17.0 alone, and pre-1.0 a
minor release is the one that may ask something of you. `plugin remove` takes
the entry's `options` with it, models included: put them back after.

See [RELEASING.md](RELEASING.md) for what a release contains and how versions are
decided.

## Models

Each command and each agent runs on a model of its own, named the way Open Code
names models: `provider/model#variant`, the variant being the effort. Out of the
box they name models of three providers — Open Code's Claude Agent provider,
OpenAI and DeepSeek:

| Default | Commands | Agents |
|---|---|---|
| `openai/gpt-6-astra#high` | `pd:plan` | — |
| `openai/gpt-6.1-sol#high` | `pd:triage` | `pd-archaeologist`, `pd-auditor`, `pd-review-architecture`, `pd-review-tests` |
| `openai/gpt-6.1-terra#medium` | `pd:validate` | `pd-validator` |
| `claude-agent/opus#high` | `pd:plan-review`, `pd:pr-sync`, `pd:review-pr`, `pd:audit`, `pd:slice`, `pd:resume` | `pd-plan-critic`, `pd-conflict-analyst`, `pd-slicer`, `pd-review-api-compat` |
| `claude-agent/opus#medium` | `pd:knowledge` | `pd-review-synth` |
| `claude-agent/sonnet#high` | `pd:exec`, `pd:quickfix` | `pd-implementer`, `pd-scout`, `pd-thread-resolver`, `pd-review-product` |
| `claude-agent/sonnet#medium` | `pd:pr` | — |
| `deepseek/deepseek-flash#low` | `pd:preflight`, `pd:doctor`, `pd:sync`, `pd:pr-status`, `pd:close`, `pd:reset` | — |
| `deepseek/deepseek-flash#none` | `pd:editor`, `pd:open` | — |

`package-map`, `upstream-rules` and `worktree-kit` name no model, and run on the
session's.

So the defaults need all three providers connected in Open Code
(`opencode auth login`). A command whose model Open Code cannot use refuses to
start, and an agent on one fails when it is called; `pdkit doctor` lists each
such model before you find out that way. With fewer providers, map the rest to
the ones you have:
[One provider only](docs/configuration/05-models.md#one-provider-only).

To put any of them on another model, another provider's included, give the
plugin's entry a map. `opencode plugin add` wrote the entry as a string; write it
as an object instead, with the same package name:

```json
{
  "plugins": [
    {
      "package": "opencode-pdkit",
      "options": {
        "models": {
          "pd:plan": "anthropic/claude-opus-5-5#high",
          "pd-plan-critic": "anthropic/claude-opus-5-5#high",
          "pd:exec": "deepseek/deepseek-flash",
          "pd-implementer": "deepseek/deepseek-flash"
        }
      }
    }
  ]
}
```

A key is a command as you type it, without the slash, or an agent; a command and
the agents it calls are separate keys. A running server picks the edit up within
seconds, and `opencode plugin update` leaves the object and its options as they
are. What wins:

- for an agent, `agents.<id>.model` in an Open Code config (a project's over the
  global one), then `options.models`, then the agent's default;
- for a command, `options.models`, then the command's default.

A key that names nothing in the plugin, or a value that is not
`provider/model#variant`, is dropped, and the default stays. A command checks its
model against the ones Open Code can use before it switches to it, and refuses to
start on one it cannot use, saying which model and where it came from; the
session stays on its model. An agent on such a model fails when it is called.
`opencode models` lists what your providers offer, and the `models` line of
`pdkit doctor` lists all 35 agents and commands with the model each one runs on,
where that came from, and whether Open Code can use it — and every key it
dropped. To try another model on one phase or one agent, and go back:
[Trying another model](docs/configuration/05-models.md#trying-another-model).

A command switches the session to its model and leaves it there for the phase:
until you pick another with `/models`, or run the next command. Outside the
commands, the session runs on whatever model you chose. Your variant does not
reach the plugin's agents: theirs is part of their model.

[`docs/configuration/05-models.md`](docs/configuration/05-models.md) has the rest.

## Commands

All orchestrating skills are manual only — nothing starts on its own.

| Command | What it does |
|---|---|
| `/pd:doctor` | environment report |
| `/pd:sync` | fork and worktree status |
| `/pd:editor [<issue>]` | open the issue's worktree in the IDE set as `editor.path`; without a number, the issue of the current branch |
| `/pd:open home\|issue\|tree [<issue>]` | open `$PDKIT_HOME`, the issue's directory in it, or its worktree in the file manager |
| `/pd:triage [<issue>]` | classify the issue, draft requirements, pick a route. Anything typed after the first line is kept as prior context — related work, an approach to repeat, a trap to avoid. Without a number: shortlist the backlog by what can actually be started |
| `/pd:plan <issue>` | scout the code, then produce a plan with executable done-criteria |
| `/pd:plan-review <issue>` | adversarial review of the plan, before any code |
| `/pd:exec <issue> [task]` | implement, one task per worker, receipts required |
| `/pd:validate <issue>` | drive the built app, collect evidence, propose an e2e test |
| `/pd:audit <issue>` | diff against plan, fresh context |
| `/pd:slice <issue>` | turn the change set into a verified graph of atomic PRs |
| `/pd:preflight <issue\|slice>` | deterministic gates (tests, lint, SPDX, commits, schemas, …) |
| `/pd:pr <issue> [slice]` | branches, PR bodies, and the only place that writes to GitHub |
| `/pd:pr-status` | dashboard across open PRs |
| `/pd:pr-sync <pr>` | triage review threads, fix, reply, resolve |
| `/pd:resume <issue>` | come back after a break: drift analysis, rebase, amend |
| `/pd:review-pr <pr>` | review someone else's PR along four parallel axes |
| `/pd:quickfix <issue>` | small fix without the planning ceremony |
| `/pd:close <issue>` | harvest knowledge, clean up worktrees |
| `/pd:reset <issue>` | start one issue over: forget its plan, research and artefacts. No other issue, and nothing upstream |
| `/pd:knowledge` | revise the shipped knowledge base |

Three more skills trigger by meaning rather than by slash: `package-map`,
`upstream-rules`, `worktree-kit`.

Everything they do rests on `pdkit`, a zero-dependency CLI the plugin puts on
`PATH`. `pdkit --help` lists it; you can drive the whole workflow from a terminal
without an Open Code session — `bin/pdkit` of a clone at the same version — which
is how most of it was tested.

Two `pdkit` commands measure rather than act, and no skill runs them. `pdkit
stats` checks the guessed config thresholds against what upstream merges.
`pdkit cost` measures the tokens each issue cost, from Open Code's session
database, split by phase and normalized per task, slice, requirement and changed
line. It can snapshot a baseline and compare later issues to it. See
[docs/workflows/reference/cost.md](docs/workflows/reference/cost.md).

The cycle is walked one session per phase, not in one sitting. Context is re-read
whole on every call, so one session carried from triage to merge pays for the
triage again on every turn of the review; each phase's artefacts are on disk, and
a new session opens on a summary of where the issue stands. `pdkit next <n>`
prints the one command to run, and
[docs/workflows/reference/sessions.md](docs/workflows/reference/sessions.md)
says which session each command runs in.

## Moving from the Claude Code version, and back

Both versions keep their state in one place: `$PDKIT_HOME`,
`~/.pdkit/podman-desktop` unless you set it, in the formats of the Claude Code
version's 0.15.0. Nothing is imported. An issue begun in Claude Code carries on
in Open Code — its state, plan, tasks, pull requests and journal are where they
were — and so does what earlier issues left for later ones.

Once, before the first work in Open Code, with the Claude Code version's `pdkit`,
in the fork:

```bash
tar -czf ~/pdkit-home-backup.tgz -C ~/.pdkit podman-desktop   # or wherever $PDKIT_HOME points
pdkit cost --snapshot
pdkit cost --planning --snapshot
pdkit task show
```

The copy comes first, because nothing in that directory is under version control
and its journal is only ever appended to: an entry written there stays. The two
snapshots are what the issues cost by Claude Code's transcripts: the "before"
that `pdkit cost --compare <date>` puts later issues beside, and the point where
Open Code's measuring starts. `pdkit task show` must answer `no task is running
in any working tree`.

While both are installed:

- **One issue, one harness at a time.** Two harnesses on one issue work like two
  Claude Code sessions on it: the journal takes both, and the cost of each is
  attributed approximately.
- **A task begun in Claude Code is started again in Open Code.** Until `pdkit
  task start` runs here — `/pd:exec` runs it — the task belongs to a Claude Code
  session, which to Open Code is somebody else's, as it would be to a new Claude
  Code session.
- **`pdkit cost` here sees Open Code only.** For an issue with work from before
  the switch, it prints no total: it says where measuring starts, `measured
  since` the newest snapshot read from Claude Code's transcripts, and that what
  came before is outside Open Code's data and not measured. Not measured is not
  zero.

Going back to the Claude Code version: run `pdkit cost --snapshot` here first.
The Claude Code version reads what this one wrote, but none of its model calls,
so in its own `pdkit cost` an issue carried on in Open Code looks cheaper than it
was, and nothing says so; the snapshot is the record. A task under way is started
again there too. Going back is safe while the two read the same formats: a
release that changes one says so in [CHANGELOG.md](CHANGELOG.md) — "the Claude
Code version 0.15 no longer reads …" — and from that release on, going back is
not.

## Status and limitations

Stated in full, because "the plugin is tested" should not be read more widely
than it is.

**In Open Code, in CI.** What runs on every change:

| What | How |
|---|---|
| The test suite | on ubuntu, macOS and Windows; all three block |
| The plugin loading | the packed plugin, installed into a fresh Open Code at the minimum, 2.3.0, and at the latest release: Open Code reports it active for the project |
| The receipt gate holding | on a real model, at the minimum and at the latest release, an implementer that stops without a receipt is held exactly once, and `pdkit doctor` finds its stop in the journal. It runs when the repository has a provider key to run it with |

The last two do not block a change yet.

**In Open Code, live, against a copy of podman-desktop.** On macOS, in Open
Code 2.3.0, on real models of the three providers the defaults name, with the
plugin in the global config. The gate and the ownership hook were tried in a
clone of a podman-desktop fork, with nothing able to leave it. The routes ran
against a private copy on GitHub — an upstream repository with podman-desktop's
history and one quick check for CI, a fork of it, issues copied from
podman-desktop's without their links and mentions, and a second account to
review — and every push, pull request, review and reply went there. **No
podman-desktop issue has been worked in Open Code yet**: nothing has been
pushed, opened or answered there.

| What | How far |
|---|---|
| The gate | Asked to in a session in the fork, a model tried `git push`, `gh pr create`, `gh issue comment`, `git add -A`, a force push and a commit with `--no-verify`. Each was refused before it ran, in the Claude Code version's words. With no `node` on the server's PATH, and with a hook that never answered, it refused rather than let a command through. On the copy, a push and `pdkit pr create` went through on consent, and a second push on that consent was refused; replies to a review went through on a reply token for that pull request |
| The ownership hook | In an issue's worktree, `write`, `edit` and `patch` from models of two providers — with no task running, with a task that owns files, and with one that owns none. Each call was let through or refused as the Claude Code version's hook decides the same write, and the files `patch` deletes or moves were checked as well |
| The `quickfix` route | One issue: `/pd:triage`, `/pd:quickfix`, `/pd:preflight`, `/pd:pr` with its self-review, a push and a pull request on consent, then `/pd:pr-status` |
| The `standard` route | One issue: `/pd:triage`; `/pd:plan` and two rounds of `/pd:plan-review`; `/pd:exec`, the receipt gate holding implementers that stopped without a receipt; `/pd:validate` without the Playwright server, which ended `unverified`; `/pd:audit`, whose finding went back through an amendment, two reviews of it and `/pd:exec` again, to `audited`; `/pd:slice` into two slices, the second stacked on the first; `/pd:pr` for the first, published by `pdkit publish`. The second slice was never published: its self-review still had findings open after the third round, the limit, and the person stopped there |
| `pr-sync` | A review from the second account on the `quickfix` pull request: four threads, one of them already answered by the author, and a request in its body. `/pd:pr-sync` had three fixed and the request deferred, pushed on consent, replied on a reply token, and resolved two threads |
| Models of different providers | Those issues ran on the defaults: the plan by an OpenAI model, the code by a Claude one, preflight on DeepSeek. `pdkit cost` measured them by issue, by model and by planning round, and set them beside a snapshot taken in Claude Code, saying the two scales differ |
| Installing | 0.16.0 from npm with `opencode plugin add opencode-pdkit`, then [First run](#first-run) as written, in a fork whose `$PDKIT_HOME` the Claude Code version had used, after the steps in [Moving from the Claude Code version](#moving-from-the-claude-code-version-and-back): `init` kept the config it found, and the self-test passed |

Not run in Open Code, or not on a real model:

- **Anything in podman-desktop itself**, and so whatever the copy lacks: its CI,
  other people's open pull requests to tell a flaky check from a real failure,
  its maintainers and review bot, branch protection and the review decision
  GitHub reports with it, and history that links to its issues and pull
  requests.
- **A stack of slices published from a fork.** The run stopped before the
  stacked slice went out; what the plugin does about a base that exists only in
  the fork was seen by calling its code, not in a session. **`slice join`** has
  not run in Open Code.
- **The Playwright server driving the application.** The live `/pd:validate`
  ran with no server: `pd-validator` drove the application with Playwright as a
  library from `shell`. The server, attached with `--cdp-endpoint`, has run in
  Open Code only on a scripted model, against a headless browser standing in
  for podman-desktop.
- **A compaction.** None of the sessions was compacted: neither `pre-compact`
  nor whether a command's instructions outlast a provider's own compaction has
  been seen.
- **Nine of the twenty-one commands** — `/pd:doctor` (its report ran as
  `pdkit doctor`), `/pd:sync`, `/pd:editor`, `/pd:open`, `/pd:resume`,
  `/pd:review-pr`, `/pd:close`, `/pd:reset` and `/pd:knowledge` — and the three
  skills that trigger by meaning ran in Open Code only on a scripted model,
  while they were ported. `pd-archaeologist`, which only the `redo` route calls,
  and `pd-conflict-analyst` have not run in Open Code, nor has the `redo` route.
- **Seven of the ten hook events.** `pre-bash`, `pre-write` and `subagent-stop`
  are the ones seen deciding in a live session. The other seven are registered
  in every session, which `pdkit doctor` reports, but what they add was not
  checked there.
- **Windows, beyond CI.** On a Windows 11 machine, on a scripted model, the
  plugin loaded, `pdkit` ran from PowerShell, cmd.exe and Git Bash, and the gate
  refused what it must. No issue has been worked on Windows.

The receipt gate rests on a hook Open Code calls experimental,
`experimental.idle`. A version that renames or reshapes it switches the gate off
without a word. The CI check above notices, and so does `pdkit doctor`, on its
`hooks:agent-done` line, once subagents have stopped and none of their stops was
recorded.

**In the Claude Code version, before the port** — evidence about that version,
not about this one. Used on thirteen podman-desktop issues: fifteen pull
requests published upstream, seven of them merged, and seven issues carried all
the way to `merged` — four on the `standard` route, three on `quickfix`. One
issue went out as a two-slice graph into two pull requests; another as three
slices that review asked to be one, rejoined by `slice join` into a single pull
request that superseded the three. Fourteen of the twenty-four skills ran as
`/pd:*` in a session; `editor`, `knowledge`, `open`, `pr-status`, `reset`,
`resume` and `review-pr` did not, nor did the three that trigger by meaning.
[Section 13 of `docs/specification/`](docs/specification/13-status.md) keeps
that accounting, with the evidence per line, as the history of 0.15.0.

## Documentation

| Document | What it answers |
|---|---|
| [`docs/workflows/`](docs/workflows/README.md) | every use case, with the commands and the decision points |
| [`docs/specification/`](docs/specification/README.md) | the design: what each piece guarantees, and why the guarantees stop where they do |
| [`docs/architecture/`](docs/architecture/README.md) | the same in five minutes, in seven parts of a file each |
| [`docs/configuration/`](docs/configuration/README.md) | the three config layers and what every key decides |
| [`CHEAT_SHEET.md`](CHEAT_SHEET.md) | the cycle on one page: what to run, what it needs first, what a refusal means |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | how to add a command, a skill, an agent or a check — and how to test it |
| [`RELEASING.md`](RELEASING.md) | versioning, the release runbook, and how users get updates |
| [`CHANGELOG.md`](CHANGELOG.md) | what each release contains |

## Layout

```text
opencode/          the Open Code plugin: registers the commands, the agents and
                   the hook bridge, and puts bin/ on PATH
bin/pdkit          deterministic CLI, put on PATH by the plugin; pdkit.cmd beside
                   it is the same CLI for PowerShell and cmd.exe on Windows
lib/               its implementation: state machine, slicing, gates, preflight,
                   validation, reviews of other people's pull requests
lib/hooks/         the hook rules; events.js is the one list of hook events,
                   with the module each one runs
skills/            24 skills — the workflow surface, each a /pd: command
agents/            14 agents — scouts, implementers, auditors, reviewers
knowledge/         upstream constitution, maintainer review rules, package map, known traps
templates/         issue, plan, task, receipt, validation, slices, PR body, amendment,
                   deferral, blocker, findings, archaeology, review report
defaults/          the shipped configuration, which your config.yaml overrides
scripts/           CI checks against a real Open Code: the plugin loads, the
                   receipt gate holds. Not shipped
test/              node --test, zero dependencies
docs/              workflows/, specification/, architecture/, configuration/ —
                   one file per scenario, section or part
```

## License

Apache-2.0. See [LICENSE](LICENSE).
