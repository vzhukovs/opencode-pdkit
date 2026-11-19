# `$PDKIT_HOME`

[Configuration](README.md) › 2 of 8

Defaults to `~/.pdkit/podman-desktop`. Holds config, the package map, gate
tokens, per-issue state and artefacts, the journal, review reports, and the
snapshots `pdkit cost --snapshot` writes to `cost/` and `pdkit cost --planning
--snapshot` to `cost/planning/`.

`pdkit cost` also reads outside it: Open Code's session database,
`opencode.db` in Open Code's data directory — `$XDG_DATA_HOME/opencode`, or
`~/.local/share/opencode` — or the file `OPENCODE_DB` names. `--db <file>`
overrides that, for `--planning` as well; a build of Open Code that is not a
release keeps its database under another name, and `--db` is how to name it.
The database is only read. Of its steps, those taken in the clone, its
subdirectories or a worktree under `worktrees.root` count, wherever the session
moved. Without a database, or with one whose tables it does not know, the
command reports a skip that says why, not zeros. Both reports refuse to run
outside the clone.

Resolution order:

1. the `PDKIT_HOME` environment variable
2. `state.root` in `<repo>/.pdkit.yaml`
3. `state.root` in `defaults/config.yaml`

`$PDKIT_HOME/config.yaml` deliberately has no say in where `$PDKIT_HOME` is — a
file cannot be consulted about its own location.

Keeping it in its own private git repository is worthwhile — losing the
directory loses the reasoning behind every decision — and committing is yours:
`pdkit` writes the files and commits nothing. It must be a **separate**
repository, never the fork.

## Shared with the Claude Code version

The default path is the one the Claude Code version 0.15 uses, the formats are
its formats, and no record says which harness wrote it, so an issue begun under
Claude Code carries on here. Three things depend on the harness, and each is
told apart by its data:

- `active/` — a task's pointer names the session it was started in: Claude
  Code's session ID there, Open Code's `ses_…` here. A task started under one
  belongs, for the other, to somebody else's session until `pdkit task start`
  runs again.
- `agent-done` in the journal names a subagent's run as its host does.
  `pdkit doctor` counts only this harness's entries when it asks, on its
  `hooks:agent-done` line, whether the hook runs.
- `cost/` — a snapshot says where its calls came from: Claude Code's
  transcripts, or Open Code's database. This version reads only the database,
  and measures from the newest snapshot read from the transcripts. For an
  issue with work before it, `pdkit cost` prints `measured since` that
  snapshot, and what came before as outside Open Code's data, not measured —
  never as zero; `pdkit cost --planning` prints `outside` for a planning window
  that opened before it. A snapshot taken here on the day of a Claude Code one
  goes beside it, as `<date>.opencode.json` in `cost/` or `cost/planning/`,
  never over it.

One issue is worked under one harness at a time. What to do once before the
first issue in Open Code, and before going back, is in the README:
[Moving from the Claude Code version, and back](../../README.md#moving-from-the-claude-code-version-and-back).

## Creating it

In an Open Code session started in the fork, where the plugin puts `pdkit` on
PATH; a line that starts with `!` goes to the shell, not to the model
([README · First run](../../README.md#first-run)):

```text
!pdkit init          # creates the directory, copies the config, builds the map
!pdkit doctor        # says what is missing and what degrades because of it
```

**One clone, two remotes — not two clones.** The upstream repository is never
checked out separately; diffs against `main` come from `upstream/main` in the
same clone. So the requirement is:

```
origin    git@github.com:<you>/podman-desktop.git       your fork
upstream  https://github.com/podman-desktop/podman-desktop.git
```

**`repo.fork` is not something you type.** It ships empty, because a config file
that ships to everyone cannot know whose fork you cloned, and `init` reads it
from the `origin` remote and writes it into `$PDKIT_HOME/config.yaml`:

```
  fork        : jdoe/podman-desktop (read from the "origin" remote)
```

That file, rather than a `.pdkit.yaml` in the checkout, is deliberate: worktrees
are separate directories and an untracked file in the main checkout is not in
any of them, so a fork configured there would silently revert to the default in
every issue worktree — where the work actually happens.

Two ways this can go wrong, both refused rather than guessed:

- **No `origin`.** Nothing to read; add the remote or set `repo.fork` by hand.
- **`origin` is upstream itself.** You cloned the project rather than a fork.
  Adopting it would aim every push at podman-desktop, and the consent gate would
  be guarding a branch in somebody else's repository.

`init` still refuses a repository whose remotes *disagree* with a fork slug that
is already set, unless you pass `--force`. A key with no value is what init is
for; a key with the wrong value means the map would be built for a workspace
nothing else will act on, and every later command would inherit it.

The config is **copied** from `defaults/config.yaml` rather than generated, so
the comments explaining each decision come with it. An existing file is kept;
`--force` overwrites it.

One consequence of copying the whole file: a default the plugin changes later is
shadowed by your copy, and it looks exactly like a setting you chose. That is
how `slicing.layer_order` stayed at its stage-0 value after the plugin extended
it. Where it matters, `doctor` names the file that decides a key —

```
! package-map:layers  no layer claims @podman-desktop/core-api, … — extend
                      slicing.layer_order in ~/.pdkit/podman-desktop/config.yaml
                      and re-run `pdkit init`
```

— so the fix is to edit that key in your own file, or delete it there and let
the shipped default through.

---

**The design** — [2.2 · State, outside the repository](../specification/02-plugin-structure.md#22-state-outside-the-repository), [architecture · The constraint](../architecture/01-constraint.md), [workflows · Where the state lives](../workflows/reference/state.md)

← [Layers](01-layers.md) · [Contents](README.md) · [What each key does](03-keys.md) →
