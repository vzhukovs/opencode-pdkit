# Measuring what a cycle costs

[Workflows](../README.md) › [Reference](README.md)

A token total for one issue says nothing on its own: an issue with fourteen tasks
is supposed to be dearer than a one-task fix. `pdkit cost` reads Open Code's
session database and puts each issue's cost beside the size of the work:

```
pdkit cost                          # every issue in the journal, grouped by route
pdkit cost --issue 12345            # one cycle, split by phase
pdkit cost --since 2026-10-01       # only calls in a window
pdkit cost --snapshot               # also write $PDKIT_HOME/cost/<date>.json
pdkit cost --compare 2026-10-16     # that snapshot beside the issues journaled since
pdkit cost --planning --issue 12345 # planning, round by round (below)
```

Open Code keeps one database for every project: `opencode.db` in its data
directory — `$XDG_DATA_HOME/opencode`, or `~/.local/share/opencode` — or the file
`OPENCODE_DB` names. `--db <file>` names another, for `--planning` as well. The
database is only read, and a session's steps count when they were taken in the
clone, its subdirectories or a worktree under `worktrees.root`, wherever the
session moved. So run it from the podman-desktop clone, pass `--repo`, or set
`repo.path`: anywhere else both reports refuse, `--db` or not, and name the
remote that says so, since every figure would be the sessions of the directory
it was run in. Without a database, or with one whose tables it does not know,
it reports a skip that says why, not zeros. Where the database is, and what
`$PDKIT_HOME` shares with the Claude Code version:
[configuration · `$PDKIT_HOME`](../../configuration/02-pdkit-home.md).

What it prints, per issue: API calls — one per step of a session, the parent
session's and its subagents' apart — the four token counters, cost units,
average and peak context, sessions, compactions, the Opus share, agent runs, a
split by phase at the state transitions, the tokens and units of each model,
and the cost per task, slice, requirement, changed line, merged pull request and
agent run. A denominator that is not known says so and why.

The scale is **cost units**: `input + 0.1·cache-read + 1.25·cache-write +
5·output`, times five on Opus. They are Anthropic's list-price ratios, so a
"before" and an "after" months apart are on the same scale; a model with no
"opus" in its name, of any provider, weighs as Sonnet, which is why each
model's tokens are printed beside the units, for whoever prices them otherwise.
Dollars are printed beside them for orientation; compare in units, or a price
change will read as an improvement.

Read the caveats it prints:

- **Attribution is approximate.** A call belongs to the issue of the nearest
  earlier journal entry within six hours, and the share of calls that matched
  nothing is always printed. Work before an issue's first journal entry is not
  counted as its triage.
- **Changed lines include lockfiles and generated output**, as in `pdkit stats`.
- **Routes are not compared.** A quickfix and a multi-slice cycle differ in kind,
  so each route is a separate group.
- **Nothing before the move from Claude Code is measured.** `$PDKIT_HOME` is
  shared with the Claude Code version, so the journal holds work this database
  never saw. Measuring starts at the newest snapshot in `cost/` taken from
  Claude Code's transcripts: a call before it is not counted, and the coverage
  says `measured since` that snapshot, with how many calls came before it. An
  issue with work before it is printed under
  `before <date>  outside Open Code data, not measured`, with no figure per unit
  of work, since part of its cost is not the issue's. Not measured is not zero.
- **Compactions are measured, and kept out of the totals**, on a line of their
  own: Claude Code's transcripts never carried them, and the totals stay on the
  scale earlier snapshots were taken on.
- **Some steps are not counted**: title and `generate` calls, and steps a revert
  removed, which are only in Open Code's session totals, with no model and no
  time; nor what a forked session copied from its source.
- `--compare` counts as "after" only the issues the snapshot did not contain, and
  says `the scales differ` when the snapshot was read from another source or with
  other weights — one from Claude Code's transcripts.

**One snapshot a day, except on the day of the move.** A second `--snapshot` on
the same day replaces the first — unless that one was taken from Claude Code's
transcripts, where measuring starts. Then this one goes beside it, as
`cost/<date>.opencode.json`, with a line on stderr saying so, and
`--compare <date>.opencode` reads it.

It recommends nothing and exits 0: what the numbers mean for how to work is your
call.

## Planning, round by round

The phase split puts everything between `planned` and `plan-approved` into one
figure, reviews and revisions together. `pdkit cost --planning` cuts it by the
journal entries each round leaves: `plan-reviewed`, which `/pd:plan-review`
writes with `pdkit plan reviewed` once the round's report is written, and
`plan-revised`, which `/pd:plan` writes when the decisions reached the plan. A
call belongs to the first of them at or after it — up to `plan-reviewed
round-k`, the review of round k; from there up to `plan-revised round-k`, its
revision.

```
pdkit cost --planning                       # every issue with a plan in its current cycle
pdkit cost --planning --issue 12345         # one issue, by round
pdkit cost --planning --snapshot            # also write $PDKIT_HOME/cost/planning/<date>.json
```

Per issue: the first plan and the whole phase after it; per round, its mode,
its A, B and C items, the decisions accepted, rejected and neither, and what
its review and its revision cost. After approval, counts only: amendments,
stop reports, tasks with a failed capture, and findings in `audit.md`. It reads
the same database as `pdkit cost`, with the same `--db`, refuses outside the
clone as it does, and starts measuring where it does.

- **A round with no `plan-reviewed` entry costs `unknown`.** Every round from
  before the entry existed has none. Its cost is not divided by a guess: the
  windows `plan-revised` alone closes are printed as one sum.
- **The decisions fall in the revision's window**, since the review session
  writes them after its report.
- **Only the current cycle.** After `pdkit reset`, rounds and windows start
  again.
- **A letter or a decision section a review does not have is `—`, not 0.**
  Reviews from before the template was fixed have their own shapes.
- **A window that opened before the move reads `outside`** — the first plan of
  an issue triaged under Claude Code, a round reviewed there — not a figure and
  not `—`, whether it lies before the point where measuring starts or across it:
  what came after is only part of its cost. Such an issue is printed under
  `before <date>  outside Open Code data, not measured`, and the coverage says
  what it is measured since, with the calls before it not counted. A round
  known only from its review file is `outside` when the plan was approved before
  the move, and `unknown` otherwise.
- **The day of the move keeps its snapshot.** A planning snapshot taken that
  day under Claude Code holds the rounds measured before the move, so one taken
  here goes beside it, as `cost/planning/<date>.opencode.json`, with a line on
  stderr.

---

**The design** — [13 · Status](../../specification/13-status.md)

← [One session per phase](sessions.md) · [Reference](README.md) · [Decision points that stay yours](decision-points.md) →
