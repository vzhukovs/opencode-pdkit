# `/pd:plan <issue>` — the plan as the only handoff artefact

[Specification](../README.md) › [4. Contracts](README.md) › `/pd:plan`

**Phase 0, a revision.** When `plan-review.md` holds `## Operator decisions
(round N)` that `pdkit plan revised` has not marked applied, `pdkit next` names
`/pd:plan <n>`, and the skill starts here instead of at phase 1: it applies the
accepted items to `plan.md` and the task files, appends the review's
`## Notes for exec` to the Notes of the tasks they name without a decision,
scouts only for a fact a decision needs, re-probes the commands it changed,
and ends with `pdkit plan revised <n>`. Nothing is pasted after the command.

**Phase 1, reconnaissance.** First what is already known: triage's scouts
asked where the behavior lives, what resembles the fix and how the area is
tested, and their maps are in `research.md`; when the issue was reset or
rolled back before, `pdkit plan lessons <n>` prints what the archived reviews
raised and what was decided, and `research.md` gets it under
`## From earlier attempts`. Then `pd-scout` runs **in parallel**, one per gap
— a question of the three that `research.md` leaves open or answers for
another region, the local rules and modes below, which triage does not ask
for, a fact a choice turns on — and, with no `research.md` to start from, at
least three, on those three questions. Each is handed the entries of
`knowledge/pitfalls.md` and of the earlier attempts that bear on its region,
and asked, besides its question, for two sections: the **local rules** of the
directories the change will likely touch and of those above them — the
obligations in their `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING*` and `README*`,
quoted — and the **modes of the environment** its component runs in, with how
the neighbors handle each. `research.md` merges both into sections of those
names. The scout's response format is strict — ≤ 50 lines with those two
sections, every claim carrying `file:line`. The host does not read files
broadly itself.

**Phase 2, forks in the road.** Anything the scouts flagged as a choice goes to
the human. A question not asked becomes `[NEEDS DECISION]` in the plan, and that
blocks approval.

**Phase 3, the plan** by `templates/plan.md`, and a task file per task by
`templates/task.md`. The plan is the index, the contracts and the slices: in
`plan.md` a task is its header and one `Intent:` sentence, and its Context,
Tests, Steps and Notes are in its task file only. A plan written before that
split, with Steps in `plan.md`, is still read as it was. Eleven requirements;
a breach means a rewrite:

1. Each task owns its files **exclusively**. Overlap is a planning error. A task
   that writes nothing — a whole-suite gate, a measurement — declares
   `Owns: (none — verification only, writes no files)`, which is read as no files
   at all; it is legitimate exactly while its `Done when` runs, the hook refuses
   every write it attempts, and every slice inherits what it satisfies.
2. `Done when` is an executable command with expected output. Prose is forbidden.
   For a task that owns code it runs the typecheck and the lint of the task's
   files beside its tests.
3. Interfaces between tasks are hoisted into `Frozen interfaces` as real signatures.
4. A task is 1–3 files.
5. Every context item cites `file:line` from the reconnaissance. An item saying
   something is absent from the codebase or an API has no line to cite, and
   cites the search instead: `searched: <query> in <where> -> 0`.
6. Every task declares `satisfies: [R1, R3]`. A requirement with no task and a
   task with no requirement are both errors.
7. `Upstream compliance` is filled in from `knowledge/upstream-rules.md`.
8. The order is written down: `- After: T4` on a task that cannot start
   before another is done, and the blocks in the order they should run.
   `pdkit task start` enforces `After`; `pdkit task list` shows the queue.
9. `Slice hypothesis` — a preliminary guess at the cut.
10. Every task that owns code lists its tests under `## Tests` in its task file,
    a row per case: the behavior or path, the conditions, the assertion, and
    why it fails without the change — every path it changes, the error path
    included, both sides of a condition it adds, every side effect, and an
    assertion on completion for anything asynchronous. `pd-implementer`
    writes exactly these cases and names any it adds.
11. The design follows sections 1 to 10 of `knowledge/maintainer-rules.md`,
    decided here: how a behavior is tested, the shape of the state, how data
    loads and where logic lives, how errors are handled, what is reused and
    how it is named. Only the syntax is left to the implementer.

Four sections of `plan.md` answer what the review would ask: `## Reuse` (what
exists that a task could reuse or would copy, each search with what it found),
`## Modes` (each mode the code runs in, rendering and async included, and how
the plan handles it), `## Gates` (the typecheck, lint and tests of each task,
and the gate that checks again a file a later task changes) and
`## Body must disclose` (what a slice's pull request body has to say because
the plan decided it). Before `pdkit plan check`, the plan is read against the
critic's checklist and coverage map, so that a question the critic would ask is
answered or closed first.

Then `pdkit plan probe <n>` runs every `Done when` on the base branch and
records what each printed, so the review sees which commands fail for want of
code and which can never pass — and, of a task that changes code, which one
passes before the change it is meant to prove.

Item 9 is the non-obvious one and it is critical. Plan without slicing in mind
and the diff comes out interleaved, and cutting it into atomic pull requests
afterwards is impossible without rewriting the work.

---

**In practice** — [`workflows/`](../../workflows/README.md):

- [§1 — A bug fix](../../workflows/01-bug-fix.md)

← [`/pd:triage`](triage.md) · [Contents](../README.md) · [`/pd:plan-review`](plan-review.md) →
