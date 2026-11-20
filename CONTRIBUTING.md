# Contributing to Podman Desktop Kit for OpenCode

This is a plugin for working on **somebody else's** repository, and most of its
design follows from that. It is an Open Code plugin, ported from a Claude Code
one. `opencode/` is the part that runs inside Open Code — the hook bridge and
the registrars. `lib/` is the core it was before; what it has to know of Open
Code — identifiers, the CLI and API, the session database — sits in modules of
its own, `lib/harness.js` and `lib/opencode-*.js`. Before changing anything, it
is worth reading
[`docs/specification/`](docs/specification/README.md) — at least
[section 2.2](docs/specification/02-plugin-structure.md#22-state-outside-the-repository), which
lists the five invariants a change must not break, and [section 6](docs/specification/06-hooks.md), which explains
why some rules are hooks rather than instructions. For the short version,
[`docs/architecture/`](docs/architecture/README.md) covers the same ground in
seven parts.

Every document under `docs/` is split one file per section, part or scenario,
and section numbers are stable: a comment in `lib/` that cites "section 7" means
[`docs/specification/07-preflight.md`](docs/specification/07-preflight.md). Keep
it that way — a new section is a new numbered file, linked from its directory's
`README.md` and from the previous and next files' footers, not a heading
appended to a neighbor.

## Environment

| Required | Why |
|---|---|
| Node.js >= 22.13 | `pdkit` is zero-dependency ESM and uses the built-in test runner; `pdkit cost` reads Open Code's session database with `node:sqlite`, which needs no flag from 22.13 |
| Open Code 2, >= 2.3.0 | to load your working copy, and for `scripts/check-plugin-load.js` — see the [README](README.md#requirements) for installing it |
| `git` | branch, worktree, and history primitives |
| [`gh`](https://cli.github.com/), authenticated | issues, pull requests, review threads |
| `pnpm` | only for exercising the plugin against a real podman-desktop fork |

```bash
git clone git@github.com:vzhukovs/opencode-pdkit.git
cd opencode-pdkit
npm test                            # no install step: there are no dependencies
node scripts/check-plugin-load.js   # does the packed package load in Open Code
```

There is no build. `lib/` is what runs: under plain Node, in `pdkit` and in the
process the hook bridge starts for each hook. `opencode/` runs inside the Open
Code server.

### Loading your working copy

Open Code loads a plugin from a directory as well as from a package. List the
checkout's absolute path in `plugins` of your global config,
`~/.config/opencode/opencode.json` — in place of `opencode-pdkit`, if you have
the package installed:

```json
{
  "plugins": ["/absolute/path/to/opencode-pdkit"]
}
```

Edit the file by hand: `opencode plugin add` takes only a package or a git
spec. Global, for the reason the README gives for the package: the fork and
each issue worktree beside it are separate places to Open Code, and only the
global config reaches all of them.

In a session in the fork, `!pdkit --version` says which copy runs there. The
plugin puts its own `bin/` first on the PATH of every command a session runs,
and from a checkout `pdkit` prints the commit as well, `<version> (<commit>)`;
an installed package prints the version alone.

Only `opencode/`, and the few modules of `lib/` it loads (`LEAVES` in
`test/invariants.test.js`), live in the server: they are loaded once, and
`opencode reload` loads them again. Every hook handler and every `pdkit`
command starts in a fresh `node`, so a change anywhere else in `lib/` applies
from the next call.

The hooks run in the Open Code server's environment, which is that of whatever
started the server, not your shell's: its PATH decides which `node` starts them
(the `hooks:node` line of `pdkit doctor`, from a session, says which), and its
`$PDKIT_HOME` is where they write.

## The one rule that decides where code goes

**Anything that must be *true* belongs in `lib/` or `lib/hooks/`, where it can be
tested. Anything that requires *judgment* belongs in `skills/` or `agents/`.**

A rule stated only in a prompt is a rule that holds most of the time. That is
usually fine; it is not fine for the rules this plugin exists to hold — that a
push cannot happen without consent, that "done" means captured output, that a
slice was actually built.

The corollary is the shape almost every module here has: **collect facts, reach
no verdict.** `lib/audit.js`, `lib/threads.js`, `lib/review.js`, `lib/backlog.js`
and `lib/archaeology.js` all follow it. If you find yourself adding a `score` or
a `recommendation` field, that is the boundary being crossed.

## Where things live

| You want to change | Touch | Test |
|---|---|---|
| a `pdkit` command | `lib/commands/<command>.js` (its handler and the flags it reads), its `REGISTRY` row and usage text in `lib/cli.js`, and the module that does the work | the module's own `test/<module>.test.js`; `test/invariants.test.js` and `test/flags.test.js` for the table |
| a deterministic rule | the owning module in `lib/` | same |
| a hook's behavior | `lib/hooks/<handler>.js`; the event map in `lib/hooks/events.js`, the deny rules as data in `lib/hooks/rules.js` | `test/rules.test.js`, `test/dispatch.test.js`, the event's `test/opencode-*.test.js`, and **`pdkit doctor --gate-selftest`** |
| where a hook stands in Open Code | `WIRING` in `opencode/bridge/hooks.js`; the payload it builds in `opencode/bridge/payload.js`, what Open Code makes of the answer in `opencode/bridge/answer.js` | `test/opencode-wiring.test.js`, `test/opencode-payload.test.js`, `test/opencode-answer.test.js`, and the gate self-test |
| how the plugin loads | `opencode/server.js`, whose order is the point of it; the registrars `opencode/agents.js`, `opencode/commands.js`, and beside them `access.js`, `allowed.js`, `environment.js`, `prompts.js` | their `test/opencode-*.test.js`; `test/invariants.test.js` for what of `lib/` the server may load; **`node scripts/check-plugin-load.js`** |
| a preflight check | one file under `lib/preflight/checks/` (exporting `needsBody` if it reads the body), its id added to `CHECK_IDS` in `lib/preflight/index.js` | `test/preflight.test.js`, `test/preflight-body.test.js` if it reads the body |
| an artefact's shape | `templates/*.md`, registered in `TEMPLATES` in `lib/render.js` | `test/render.test.js` |
| what a skill does | `skills/<name>/SKILL.md` | `test/invariants.test.js` checks that every `pdkit` command and every `/pd:*` a skill names exists, and that plugin files are reached through `${CLAUDE_PLUGIN_ROOT}/`; `test/opencode-commands.test.js` for what the frontmatter registers |
| what an agent does | `agents/pd-<name>.md` | the same `${CLAUDE_PLUGIN_ROOT}/` check; `test/opencode-agents.test.js` for its tools and its model |
| a default model | `model:` of the skill or the agent | `DEFAULTS` in `test/opencode-commands.test.js`, `EXPECTED` in `test/opencode-agents.test.js`; a model no default named before also goes into `SHIPPED`, the catalog both `test/opencode-commands.test.js` and `test/doctor.test.js` check the defaults against; and a line in the CHANGELOG — see below |
| a check CI runs on a real Open Code | `scripts/`, which the package does not ship; the jobs in `.github/workflows/ci.yml` | `test/check-plugin-load.test.js`, `test/check-receipt-gate.test.js` |
| the shipped knowledge base | `knowledge/*.md` | `pdkit knowledge check` |
| the documentation | `docs/<area>/`, one file per section, part or scenario; the four root files | `test/invariants.test.js` checks every `/pd:*` named in `docs/` and `README.md` |

### Adding a `pdkit` command

1. Implement it in the module that owns the data. If no module owns it, that is
   the finding — see below.
2. Write its handler as `lib/commands/<command>.js`, exporting `flags` and
   `run(args, flags)`. What two commands need goes in `lib/commands/support.js`,
   never in `lib/cli.js`: a command module does not import the dispatcher.
3. Add a row to `REGISTRY` in `lib/cli.js` — the module itself — and write the
   usage line. `COMMANDS` and `COMMAND_FLAGS` are read off the registry, and
   `main` dispatches through it, so there is no second list to keep in step.
   `lib/cli.js` keeps only argv parsing, the registry, `pdkit hook` and exit
   codes.
4. Declare every flag it reads in the module's `flags`. Every command refuses a
   flag it does not declare, and `test/invariants.test.js` fails on a flag a
   handler reads that no row declares, on a row that declares one nothing
   reads, and on a command module reading a flag it does not declare itself.
5. Document the flags in the usage text. A flag that exists in code and not in
   `--help` is a flag nobody uses — that happened to `close --confirmed`.
   A command with actions (`pdkit pr ci`, `pdkit task start`) dispatches through
   an exported `ACTIONS` table, so adding an action is a function, its row in
   `ACTIONS`, and its line in the usage text; `test/invariants.test.js` fails on
   a command or an action the usage text does not name.
6. If a person would type it, add it to [`CHEAT_SHEET.md`](CHEAT_SHEET.md). That
   file says the CLI is right when the two disagree, so a missing line there is
   only a gap, but it is the page people read.

### Adding a preflight check

A check exports `id`, `blocking` and `run` (and `needsBody` if it reads the PR
body), and returns `pass`, `skip`, `warn`
or `fail` with a summary and a remedy. Whether it blocks is the check's own
export, not the caller's choice. Add a row to the table in
[section 7](docs/specification/07-preflight.md) and to the preflight table in
[`CHEAT_SHEET.md`](CHEAT_SHEET.md), and correct the count in both.

- **A skip is never a pass.** If the check could not run, say so and say why. A
  check reporting success where it checked nothing devalues the whole gate.
- **If it reads the PR body, export `needsBody = true`** and add its id to
  `BODY_DEPENDENT`, which `test/preflight.test.js` holds equal to the checks
  that export it. Otherwise it stays forever at its first-pass result, which is
  `skip` — and that looks like a check that ran. When the body is what it
  lacks, return `skipForBody` from `lib/preflight/body.js` rather than writing
  the skip by hand: its `waitingFor: 'body'` is what the note after pass one
  counts, and the summary's wording is not.
- **The message must not be wider than the measurement.** Three separate defects
  in this repository were the same shape: a failure that asserted more about the
  input than the check had looked at. Say what you measured.

### Adding a state or a transition

`lib/state.js` is the **only** writer of `state.json` (invariant 1), and
`test/invariants.test.js` enforces that by refusing to let any other module name
the file. If a transition needs a fact from elsewhere, pass the fact in; do not
add a second writer.

Ask whether the new state is terminal, and be suspicious of yes. `answered`
looked terminal and was not: at the moment it is entered, the work is waiting on
somebody, and a terminal state cannot wait.

### Adding a skill or an agent

Open Code reads neither skills nor agents from a plugin's directory, so the
plugin registers them itself, from the files, once per load.

A skill is `skills/<name>/SKILL.md`, and every one becomes the command
`/pd:<name>` (`opencode/commands.js`). Orchestrating skills carry
`disable-model-invocation: true` — nothing in this plugin starts on its own.
Phrase-triggered skills (`package-map`, `upstream-rules`, `worktree-kit`) omit
it deliberately, and each of those is registered a second time, as the skill
`pd:<name>` the model may load by itself, with its `when_to_use` lines appended
to its description. The registrar reads the frontmatter Claude Code read:
`argument-hint` goes first in the command's description, which is all Open Code
shows beside its name; `allowed-tools` lets the shell commands it lists run
without a question until the person's next message (`opencode/allowed.js`;
only `Bash(...)` entries have a counterpart). In the body, `$ARGUMENTS` takes
what was typed after the command; a skill without it gets
`ARGUMENTS: <what was typed>` after the body.

An agent is `agents/pd-<name>.md`, registered as a subagent under the ID its
`name:` gives, `pd-<name>` like the file: the receipt gate knows the
implementer by that ID. `tools:` keeps Claude Code's names — `Read`, `Grep`,
`Glob`, `Bash`, `Write`, `Edit`, `mcp__<server>__<tool>` — and the registrar
turns each into the permission Open Code checks it by, after a first rule that
denies everything: what an agent was not given, it does not see. A tool with no
counterpart stays denied, and the server log says so.

In the body of either, a plugin file is written
`${CLAUDE_PLUGIN_ROOT}/knowledge/<file>.md`: skills and agents run in the
podman-desktop checkout, where a bare path names the wrong tree. Open Code has
no such variable; the name is kept from Claude Code as the plugin's own
placeholder, and the registrar puts the plugin's absolute root in its place —
in the body only, since the frontmatter reaches Open Code as written.
[AGENTS.md](AGENTS.md) has the rule, and `test/invariants.test.js` holds it.

A new skill or agent also goes into the tables its registrar's test holds them
to (`PHRASE` and `DEFAULTS`, `EXPECTED`), and `node scripts/check-plugin-load.js`
checks that a real Open Code lists it.

**Models.** A command or an agent names its default model in `model:` the way
Open Code names models, `provider/model#variant`. The variant is the effort, so
there is no `effort:` key. A value of any other form, a Claude Code alias such
as `sonnet` among them, is not read: the command runs on the session's model.
The three phrase-triggered skills name none, and run on the session's.

The default is the last of the sources, not the only one. A person overrides it
with the map `options.models` in the plugin's entry of their Open Code config,
keyed by command (`pd:<name>`) or agent (`pd-<name>`); for an agent, Open Code's
own `agents.<id>.model` is stronger than the map. So an agent runs on
`agents.<id>.model`, then `options.models`, then its `model:`, and a command on
`options.models`, then its `model:`. A key that names nothing, or a value not
in that form, is dropped with a line in the server log, and the default stays.
The `models` line of `pdkit doctor` shows what each of the 35 ended up on, and
where it came from. There is no key for models in `config.yaml`: the plugin's
options are the one lever, and it reaches commands and agents alike.

A command checks its model against the ones Open Code can use, refuses to start
on one it cannot, and otherwise switches the session to it. The session keeps
that model for the whole phase — the person's next messages, a TUI restarted on
the same session — until the person picks another in `/models` or runs the
next command. (In the Claude Code version a skill's `model:` held for one
turn.) `/new` and `/clear` carry the model of the old session into the new one
without its variant, until the next command sets both. An agent's model is its
own: every call runs on it, variant included, and the variant a person picks in
the session does not reach it. An agent that names none runs on the model of
the session that calls it.

Lowering a default — to a cheaper class of model or to a smaller variant —
comes with one sentence in the CHANGELOG saying what in that phase a machine
decides rather than the model. Without it the move is a bet, and nobody will
remember why it was made. Moving a default to another provider is an ordinary
user-visible change, with an ordinary entry; what a person puts in their own
map is theirs, and the CHANGELOG has nothing to say about it.

### Adding a hook

A hook is three things, each in one place:

1. **What it decides**: a handler, `lib/hooks/<handler>.js`, which
   `pdkit hook <event>` runs in a child process. It reads its payload on stdin,
   in the shape Claude Code gave its hooks, which the bridge builds; it refuses
   with exit 2 and the reason on stderr, adds context with JSON or text on
   stdout, and otherwise exits 0. It knows nothing of Open Code.
2. **That it exists**: its row in `HOOK_HANDLERS` in `lib/hooks/events.js`, the
   one list of events. `pdkit hook` dispatches on it, the bridge registers
   every event in it and no other, the doctor checks each module it names, and
   `PDKIT_HOOKS` tells the doctor which of them stood. An event where a handler
   that cannot run must mean "no" goes in `FAIL_CLOSED` too; today that is
   `pre-bash` alone, and every other hook fails open.
3. **Where it stands in Open Code**: its rows in `WIRING` in
   `opencode/bridge/hooks.js` — the hook point, and the bridge's function for
   it — with the payload in `opencode/bridge/payload.js` and what Open Code
   makes of the answer in `opencode/bridge/answer.js`. A callback there never
   throws, and waits on nothing but the run, which `invoke` in
   `lib/hooks/runner.js` stops at its deadline: Open Code waits on several of
   these points, and a throw or a hang there loses a compaction or what the
   person typed.

Test the handler on its own and the event through the bridge with a fake `ctx`;
`test/opencode-wiring.test.js` holds each event to its points and nowhere else.
Neither proves that Open Code calls a new point: it takes a hook under any name
and calls only the ones it has, so a misspelled or renamed point registers
without a word and stays idle. Only a session that reaches the point shows it;
the doctor's `hooks` line does not, since the registration stood.

## Testing

```bash
npm test                                       # everything, a few minutes
node --import ./test/helpers/isolate-home.js --test test/slice.test.js              # one file
node --import ./test/helpers/isolate-home.js --test --test-name-pattern "digest"    # one case, by name
```

Tests are `node --test`, zero dependencies, one file per module whose contract
holds something up. They run against the real `templates/` and `defaults/`
directories rather than fixtures, so a placeholder renamed in a template without
its caller being updated fails here.

No run touches your `$PDKIT_HOME`: `test/helpers/isolate-home.js`, loaded with
`--import`, gives each test file a fresh `PDKIT_HOME` in the temp directory
(unless one is set explicitly) and removes it on exit, and `test/isolation.test.js`
fails a run that arrives without it — hence the `--import` above.

**What a test in this repository is for.** The suite has never caught the
interesting bugs — every finding listed at the bottom of the changelog came from
running the thing against live upstream. What the suite does is stop those
findings coming back, and hold the invariants that have no runtime symptom. Write
the test that would have failed, and say in a comment what it is protecting.

Two checks the suite cannot replace, both required before you send a change:

```bash
pdkit doctor --gate-selftest --repo <a real podman-desktop fork>
```

This sends every command the gate must refuse, and the ones it must let
through, through `invoke` of `lib/hooks/runner.js` — the call the hook bridge
makes for each command a session runs: `node` from the PATH of the doctor's
environment (in a session's shell, the server's),
`<plugin root>/bin/pdkit hook pre-bash`, the deadline, and the `FAIL_CLOSED`
policy. A forbidden command counts only when the hook refused it, not when the
policy refused for want of an answer. The ownership hook gets the same
treatment on `pre-write`. Every unit test stays green while the hook a session
starts cannot run — there the gate refuses every command, and the other hooks
check nothing. Run it after any change under `lib/hooks/` or `opencode/`, or to
`bin/pdkit`, with the `pdkit` of the copy you changed: `bin/pdkit` of this
checkout, or `!pdkit` in a session that loads it. The probes go through that
copy's `bin/`.

```bash
node scripts/check-plugin-load.js
```

Packs the package, loads it into a throwaway `opencode serve`, and checks what
the server reports: the plugin active, every skill a `/pd:` command with the
description the registrar builds, every agent a subagent, every skill the model
may load listed as one. No model is called. There is no stricter mode to ask
for: Open Code does not check the fields of a plugin's package, so what it does
not accept shows only as a plugin that did not load — and a plugin that does
not load leaves the session running without the gate, every CLI command still
exiting 0. It needs `opencode` and `npm` on PATH, on Linux or macOS.

A third needs a model and a provider key, and CI runs it where the key is set:
`node scripts/check-receipt-gate.js --model <provider/model>` has a real
implementer stop without a receipt and checks that the gate holds it. Open Code
calls the hook the receipt gate stands on only after a model's step, so nothing
else reaches it.

## License headers

Every `.js` file and every YAML file carries the podman-desktop house header —
the Apache block with the copyright line and the SPDX identifier **inside** it,
not a bare `// SPDX-License-Identifier` line. A new file carries the same block
as the files ported from the Claude Code version, copyright line included:
`Copyright (C) 2026 Red Hat, Inc.`. `test/invariants.test.js` states the block
in full and checks every module of `lib/` and `opencode/` against it.

This is not pedantry about our own files: `knowledge/upstream-rules.md` tells
contributors that upstream rejects the bare form, and `lib/preflight/checks/spdx.js`
fails a pull request that ships one. A tool that does not follow the rule it
enforces is a tool a reviewer discounts.

`bin/pdkit` carries the header **after** the shebang. The other order leaves a
file the kernel will not execute.

## Commits and pull requests

- **Conventional commits**: `type(scope): subject`. The scope is optional but
  worth writing — it tells a reviewer which area they are being asked about.
- **One `Signed-off-by` trailer per commit.** If you need to squash, use
  `git reset --soft <base> && git commit`, never `git rebase -i`.
- **Say why, not what.** The diff already says what. Commit messages here are
  long because the reasoning is the part that does not survive in code, and the
  same applies to a pull request body.
- **The reasoning before the port is in another repository.** History here
  starts at a snapshot of podman-desktop-kit 0.15.0, one commit without
  parents, so `git log` and `git blame` stop there for every line written
  before it. The why behind that code is in the commit messages of
  [vzhukovs/podman-desktop-kit](https://github.com/vzhukovs/podman-desktop-kit),
  the Claude Code version. To read it here, graft that history onto the
  snapshot in your clone:

  ```bash
  git fetch --no-tags https://github.com/vzhukovs/podman-desktop-kit.git \
    refs/heads/main:refs/remotes/cc/main
  git replace --graft "$(git rev-list --max-parents=0 HEAD)" \
    d9805347f7e61d06d0651644c0a6bfe5d5bf7972
  ```

  The graft is a ref of your clone, under `refs/replace/`, and must stay there
  with `cc/main`. Push branches by name —
  `GIT_NO_REPLACE_OBJECTS=1 git push origin <branch>` keeps the graft out of the
  command altogether — and never `git push --mirror` or
  `git push origin 'refs/*'`, which would publish both.
- **Update `CHANGELOG.md`** under `## [Unreleased]` when the change is something a
  user would notice. `test/release.test.js` keeps that section present. If the
  user has to do anything about it, say what under `### Upgrading` — see
  [RELEASING.md](RELEASING.md).
- **Keep the status honest.** A change that makes something run for the first
  time against live upstream moves a row in
  [section 13](docs/specification/13-status.md), with the journal entry or
  artefact that proves it, and the summary in the README with it.
- Run `npm test`; the gate self-test for anything under `lib/hooks/` or
  `opencode/`, or in `bin/pdkit`; and `node scripts/check-plugin-load.js` for
  anything that changes what the plugin registers or how it loads. Say in the
  pull request what you ran.

## When you find that nothing owns something

This has happened once per stage, always somewhere new: an entity existed in the
design with no module responsible for it. The symptom is always the same — a
question you cannot answer without inventing a second place to store the answer.

The right move is a module that owns the record, with a single writer. The wrong
moves, both tried: a second writer for `state.json`, and a new state file for one
integer. When the fact is already in the append-only journal, derive it instead —
that is what `lib/attempts.js` does.
