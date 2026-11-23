# 9. Configuration

[Specification](README.md) › Section 9

Three layers, each overriding the previous per key:

```
defaults/config.yaml        shipped with the plugin
  ↓
$PDKIT_HOME/config.yaml     your settings
  ↓
<repo>/.pdkit.yaml          per-repository
```

**Maps merge key by key; lists are replaced whole, never merged.** A
`layer_order` assembled from two halves is a list nobody wrote, and it decides
the order in which slices merge. The cost is stated rather than hidden: a list
`init` copied and you never edited stays at the value shipped that day, so a
later change to the default never reaches you — silently, because the pinned
value is still perfectly valid. `doctor` reports it as `config:arrays`.

## The YAML subset

`lib/yaml.js` reads nested maps, block and inline sequences, scalars, quotes and
comments. It **refuses** anchors, multiline scalars (`|`, `>`), tags and
multi-document files, naming the line. This is deliberate: a reader that skipped
a construct it did not understand would hand back a config that looks loaded and
is missing a key, and the loss would surface later as a wrong decision somewhere
unrelated. One departure from YAML 1.1: `on` and `off` stay strings, because the
config uses them as enum members next to `auto`.

## What the keys decide

| Key | Effect |
|---|---|
| `repo.upstream` | checked against the git remotes by `init` and `doctor` |
| `repo.fork` | the same, but ships **empty** and is filled by `init` from the `origin` remote — a file that ships to everyone cannot know whose fork you cloned |
| `repo.upstream_remote`, `repo.fork_remote` | which remote names carry them |
| `repo.path` | optional; work on this repository regardless of the working directory |
| `state.root` | where `$PDKIT_HOME` lives, unless the environment says otherwise |
| `branches.single`, `branches.sliced` | branch name templates; `{issue}`, `{index}`, `{slug}` |
| `slicing.layer_order` | merge order for slices, and the layer each package is filed under. A package no entry claims is **reported** rather than filed under the nearest match |
| `slicing.strategy` | `prefer-independent` by default |
| `slicing.max_files_per_slice` | a warning threshold, not a refusal. Size is a conversation |
| `slicing.verify.worktree` | `reuse` keeps one tree per issue so `node_modules` survives; `ephemeral` rebuilds and pays a full install per slice |
| `slicing.verify.install` | `on-lockfile-change` (default), `always`, `never`. The marker recording which lockfile is installed lives **inside** `node_modules`, so wiping one wipes the other |
| `worktrees.root` | beside the fork, never inside it: a checkout under the repository shows up in `git status` and eventually in a pull request |
| `worktrees.copy_files` | copied into every new tree, and again after each verification reset — `git clean` takes them |
| `quickfix.max_changed_lines`, `quickfix.max_files` | thresholds above which a quickfix escalates back to triage |
| `gates.push_ttl` | how fast consent goes stale. **Which states a token may be issued from is not configurable** — see `state.GATE_ELIGIBLE` |
| `validation.e2e` | `prefer`, `required`, `off`. The per-issue decision is made at planning |
| `validation.e2e_stability_runs` | consecutive green runs a new e2e test needs |
| `validation.require_evidence` | when false, `validation-evidence` skips. It exists for a repository where the application cannot be driven at all, not as a way past a step you would rather not demonstrate |
| `validation.app.binary` | a packaged application to drive; empty by default |
| `validation.app.debug_port` | where CDP listens. `validate launch` refuses a port something else already answers on rather than fighting it |
| `validation.app.startup_timeout` | how long to wait for `/json/version` |
| `preflight.scripts.*` | overrides for script-name resolution. **Empty by default**: names resolve from the repository's own `package.json`, and that is the right source. Filling one in is worth doing exactly when the resolver got it wrong — which is a reason to fix the resolver |
| `preflight.typecheck_scope` | `repo` (default) or `packages` — what `typecheck` means in preflight and in `slice verify`. The whole one, because a type error lands in the consumer of a change |
| `exec.max_attempts` | how many failed captures block a task; zero switches blocking off |
| `review.bots_collapsed`, `review.bot_escalate` | which accounts collapse, and which words expand one back |
| `review.self_review_rounds` | how many commits in a row the self-review may run on without a clean review before the next round waits for a person (`pdkit self-review continue`); a round starts at `self-review target`; the review of the whole branch in `/pd:audit` counts its own rounds against the same number; zero switches the limit off |

There is **no `routing:` block** and no model selection here at all, and that
is deliberate: changing `pd-auditor`'s model changes what acceptance is worth,
and that should not turn on a key nobody notices. Each command and agent names
its default model in its own frontmatter, `model:`. What overrides a default is
the person's choice, made in one place: a map in the plugin's entry of Open
Code's global config, `options.models`, which reaches commands and agents alike
(for an agent, Open Code's own `agents.<id>.model` is stronger still).
`pdkit doctor` shows, for every agent and command, the model it runs on and
where that came from. The order in which the sources win is in
[section 5](05-agents.md); how to write the map, in
[`configuration/05-models.md`](../configuration/05-models.md).

## The package map

`init` generates `package-map.json` from `pnpm-workspace.yaml`, so it cannot
drift from the workspace. `doctor` warns when the map is older than the workspace
file.

---

**Every key in full** — [`configuration/`](../configuration/README.md): the three config layers, and every key in [part 3](../configuration/03-keys.md).

← [8 · MCP servers](08-mcp-servers.md) · [Contents](README.md) · [10 · Scenario coverage](10-scenarios.md) →
