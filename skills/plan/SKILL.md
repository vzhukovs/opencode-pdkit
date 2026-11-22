---
name: plan
description: "Plan an issue: scout the code, resolve the open choices, and produce a plan with executable done-criteria."
argument-hint: "<issue-number>"
disable-model-invocation: true
model: openai/gpt-6-astra#high
---

The plan is the only artefact that carries intent to the implementer. Three
phases, in order — unless a review is waiting to be applied, which is phase 0
and replaces them.

## Phase 0 — a revision, when the review has been decided

`pdkit next <n>` says it: from `planned`, when `plan-review.md` has a
`## Operator decisions (round N)` section that `pdkit plan revised` has not
marked applied, the next step is this skill again, not another review. The
decisions are read from that file. Nothing has to be pasted after the command,
and anything pasted is read as one more decision, not a substitute for them.

What a revision is:

1. Read `plan-review.md` — the findings, its `## Notes for exec` and the
   latest `## Operator decisions` section — then `plan.md`, `tasks/` and
   `research.md`. Earlier rounds are in `plan-review.r<k>.md`; their decisions
   stand and are not reopened.
2. Apply what was accepted, item by item, and nothing else. A rejected item is
   left alone; an item with no decision is left alone and named at the end. A
   decision that needs a code fact `research.md` does not hold gets one
   `pd-scout` for that fact, not a new reconnaissance.
3. Append each line of `## Notes for exec` to `## Notes` in the task file of
   the task it names, as the critic wrote it. No decision is asked for and
   none is recorded: a note is what the implementer would learn from its own
   files or the first run of its `Done when`, and Notes is not a part
   execution reads, so it does not send the plan to another round. A note
   naming a task the plan no longer has is left out and named at the end.
4. Edit `plan.md` and the task files in place. A task's header and its
   `Intent:` are in `plan.md`; its Context, Tests, Steps and Notes are in its
   task file, and a decision about them is applied there. A plan written before
   that split also has Steps, and often Context, in `plan.md`: change both
   copies. Task IDs never change; a task the revision drops is deleted from
   both files before approval, which is the only time that is allowed. Then
   `pdkit task sync --issue <n>` and `pdkit plan check <n>`. The review
   already copied the plan it read into `reviews/r<k>/`, and the next review
   compares with it: leave `reviews/` alone.
5. `pdkit plan probe <n> --task <every task whose Done when changed>`, from
   the main checkout. Before step 6, whatever step 6 then prints.
6. `pdkit plan revised <n>`, which records that the round is in the plan and
   prints the step after it, `next:`, with the reason, `why:`. Follow that
   line, not this one. It is `/pd:plan-review <n>`, in a new session, when an
   A item was accepted or left with no decision, when the revision changed a
   task's Owns, After, Done when, Satisfies or Slice, the set of tasks, Frozen
   interfaces or the slice hypothesis, or when there is no snapshot to compare
   with. Otherwise it is the approval — `pdkit ids freeze <n> && pdkit state
   <n> --to plan-approved` — and that is the person's to run: put the line and
   its `why:` in front of them, and do not run it. They can still ask for a
   round.

Say to the person, at the end, which items were applied, where, and which
were left for lack of a decision; and how many notes went to which tasks.

## Phase 1 — reconnaissance

First, what is already known, so the scouts do not find it again.

**Earlier attempts.** An issue that was reset or rolled back has its earlier
reviews archived, and nothing else reads them:

```
pdkit plan lessons <n>
```

It prints every archived round's A and B items with the decision lines
recorded on them, or that there is no archive. Write what was decided to
`research.md` under `## From earlier attempts`, one line per item: an accepted
item as what it established about the repository, with its `file:line`; a
rejected one with the reason given. An item with no decision line is left out,
and the section says how many were. A review printed as the same text as
another archive's is read there.

**The traps.** `${CLAUDE_PLUGIN_ROOT}/knowledge/pitfalls.md` holds traps this
repository has set before, each with where it lives.

**What triage mapped.** Triage's scouts asked three questions — where the
behavior lives, what already resembles the fix, how the area is tested — and
their maps are in `research.md`. Read it before sending anyone. A question it
answers, with `file:line`, for the region the plan will change, is not asked
again: on one issue the planning scouts re-read what triage's had, at four
times the cost.

Then `pd-scout` agents **in parallel**, one per gap, each with a question
`research.md` does not answer:

- any of those three it leaves open, answers without `file:line`, or answers
  for another region than the one the plan will change;
- the **local rules** and the **modes of the environment** below, which
  triage does not ask for — one scout for the region the change touches, or
  one per region when it spans several;
- a fact one of the choices in phase 2 turns on.

With no `research.md`, or one that answers none of the three, it is a scout
per question, three at least. Each scout's prompt carries, with its question,
the `pitfalls.md` entries that bear on the region it maps (the whole file,
while it stays near 300 lines and the region is unclear) and the lines of
`## From earlier attempts` that touch it. A scout handed an entry checks it
against the code it reads and cites the current `file:line`; one the code no
longer bears out is a finding, not a premise.

Every scout's prompt also names the directories of its region the change will
likely touch, and asks for two sections after its answer:

- **Local rules** — the `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING*` and
  `README*` in those directories and in each one above them, with every
  obligation a change there is held to ("in the same change, update X", "do
  not do Y") quoted word for word with `file:line`; none found, the search.
  The root's files are the same for every scout, so one scout goes up to the
  root — the one asked where the logic lives, or, when `research.md` answers
  that, the one asked for the local rules; the others stop below it.
- **Modes of the environment** — the modes the component it maps runs in
  (the operating system, a packaged or a development build, more than one
  runner or provider, a flag) and how the neighboring code handles each, a
  skip or a branch, with `file:line`.

A scout answers what it is asked and nothing beside it. A directory's rule
about what else changes with the code, or a runner that drops what the others
pass, reaches the plan from reconnaissance only when a brief asks for it;
otherwise a plan review finds it, one round at a time.

Their format is fixed: ≤ 50 lines with those two sections, every claim with
`file:line`, no recommendations. A scout that proposes a solution has exceeded
its brief, and its proposal has not been checked against the others.

Do not read the code broadly yourself. Scouts exist so you read 40 lines
instead of 4000; reading both is the failure mode this structure was built
against.

Wait for every scout's report, then add the compressed map to `research.md`,
below triage's, and after it two sections that merge what the scouts returned:
`## Local rules`, one line per obligation with its `file:line` and the
directory it binds, the same rule from two scouts once; and
`## Modes of the environment`, one line per mode with how the neighbors
handle it and where. A section with nothing in it keeps its heading and the
searches that came back empty, so a reader can tell "none" from "not asked".

## Phase 2 — the choices

Anything a scout flagged as a decision goes to the user through
the `question` tool, with the options and what each costs.

A question you do not ask becomes `[NEEDS DECISION]` in the plan, and that
blocks approval. This is deliberate: an unasked question does not disappear,
it becomes an assumption nobody agreed to and nobody can find later.

## Phase 3 — the plan

Fill `${CLAUDE_PLUGIN_ROOT}/templates/plan.md`, and one `${CLAUDE_PLUGIN_ROOT}/templates/task.md` per task.

**The plan is the index, the contracts and the slices.** In `plan.md` a task
is its header — Satisfies, Owns, Done when, After, Slice — and one `Intent:`
sentence. Its Context, Steps and Notes are written in `tasks/T<k>.md` and
nowhere else: written twice, every revision edits two places and every review
compares them. What `plan.md` holds beyond the headers is what tasks share —
the requirements, the plan's Context, the frozen interfaces, the slice
hypothesis, upstream compliance.

**Do not plan what the implementer will see in its own files.** A step names
the file and the requirement that has to hold in it; the implementer reads
the file. The argument order of a helper the owned file already calls, the
fixture a spec already loads, a flag the first run of `Done when` asks for —
written into the plan, each is a claim about code that every review round
then checks, and when it is wrong it costs exec one attempt. Write a detail
down when the implementer cannot learn it that way: a fact in a file the
task does not own, or one without which `Done when` would pass while the
requirement is unmet. The cases a task's tests have to prove, and the design
the maintainer's rules hold it to, are not such details: the plan decides
them, in requirements 11 and 12 below.

Every one of these is a requirement, and a plan that misses one gets redone
rather than patched:

1. **Every task owns its files exclusively.** Two tasks sharing a file is a
   planning error, not a coordination problem. A task that writes nothing — a
   whole-suite gate, a measurement — writes `Owns: (none — verification only,
   writes no files)`, which is read as no files: `plan check` accepts it as long
   as its `Done when` runs, the hook refuses every write it attempts, and every
   slice inherits the requirements it satisfies.
2. **`Done when` is a command and its expected output.** Prose is refused:
   "works correctly" cannot be checked by anyone except its author. For a task
   that owns code, the command runs the typecheck and the lint of its files
   beside its tests — `pnpm typecheck:<package>` and
   `pnpm exec eslint <its files>`, say. An error a task's own command does not
   show surfaces in a later task, which may not write the file.
3. **Interfaces between tasks are frozen, with real signatures**, so two tasks
   cannot each invent their own version of the same boundary.
4. **One to three files per task.**
5. **Every context line cites `file:line`** from phase 1. A context line
   without a location was not verified. A line saying something is **absent**
   from the codebase or an API has no line to cite, so it cites the search:
   `searched: <query> in <where> -> 0`, run case-insensitive, with no window,
   for the concept as well as the name. "Not found" is not "not there" until
   that search says so. `pdkit plan check` refuses an absence that cites
   neither.
6. **Every task declares `satisfies: [R…]`.** A requirement with no task and a
   task with no requirement are both errors.
7. **`Upstream compliance` is filled in** from `${CLAUDE_PLUGIN_ROOT}/knowledge/upstream-rules.md`:
   SPDX on new files, schemas touched, `extension-api.d.ts` touched, commit
   scope. The plan must also not contradict section 1 of
   `${CLAUDE_PLUGIN_ROOT}/knowledge/maintainer-rules.md`:
   - existing tests are not changed in the same slice as the implementation
     they test;
   - prerequisite refactors are planned as their own task, ahead of the change
     that needs them;
   - no drive-by renames or moves.

   Upstream's review agent rejects all three.
8. **`e2e coverage:` is decided here** — `required`, `optional` or `no` with a
   reason. Deciding afterwards produces a test for what was built rather than
   for what was required.
9. **The order is written down, as `- After:`.** A task that cannot start
   until another is done says so: `- After: T4, T6`. A task written ahead of
   others because it has to run on the untouched tree — a safety-net test of
   current behavior — goes first in `## Tasks`, and every task that changes
   that behavior names it in `After`. Among tasks free to start, exec runs them
   in the order the blocks are written, so write them in the order they should
   run. `pdkit task start` enforces `After`; prose in a step ("run only after
   T20") enforces nothing and is read by nobody who picks a task. A task in a
   slice carries `- Slice: S<k>`, which is what `pdkit task list` shows beside
   it.
10. **`Slice hypothesis` is written.** Not the final graph, but tasks are
   ordered so cutting is possible later. Planning without it produces an
   interleaved diff that cannot be split without redoing the work.

   The slicer is held to it: `pdkit slice set` refuses more slices than the
   header's count unless the slicer says why. So the count in the header is a
   number, and the reasoning under the heading is written for somebody who will
   see only the diff.

   **Every slice leaves main working on its own.** A contract change, such as
   an IPC signature through main, preload and renderer or a type every consumer
   reads, has no subset that does. It is one slice, with a commit per layer if
   the reviewer should read the layers apart. If it should be several pull
   requests, plan expand/contract: add the new path beside the old one, move the
   callers, remove the old one. Each step then leaves main working, and that
   split has to be in the tasks, because no slicer can cut it out of a diff that
   replaced the old path.
11. **Every task that owns code lists its tests**, under `## Tests` in its
    task file: a row per case — the behavior or path, the conditions, what the
    test asserts that a reader can observe, and why it fails without the
    change. The list is whole when it has every path the task adds or changes,
    the error path included; both sides of every condition it adds — what it
    now leaves out and what it still lets through — and a change of state
    across it; every side effect: what is written, cleaned up, removed or sent;
    and, for anything asynchronous, an assertion that waits on completion
    rather than on what the UI shows halfway. A case whose last column is empty
    is one the implementer can make green with the requirement unmet. A task
    that adds no behavior — a refactor, a move — lists the existing tests that
    hold it, each passing before and after. `pd-implementer` writes exactly
    these cases and names any it adds. `plan check` refuses a task that owns
    code, not only specs, with no `## Tests`.
12. **The design follows the maintainer's rules, and is decided here.** Read
    sections 1 to 10 of `${CLAUDE_PLUGIN_ROOT}/knowledge/maintainer-rules.md`,
    and the calibration above them. Most of those rules are a design before
    they are a line of code, and the plan is where the design is chosen: §2 how
    a behavior is tested, §3 the shape of the state, how data loads and where
    logic lives, §4 how errors are handled and what runs in `finally`, §6 how
    main-process code is structured, §8 the UI, §10 what is reused and how it
    is named — and §5, §7 and §9, which a plan breaks before any code exists.
    Where a task's Intent, Steps or Tests settle one of these — a value kept
    in state, a computation placed in a component, a list copied under a new
    name, a test that waits on a halfway state — they settle it the way the
    rule says, and name the rule when that is not obvious. A design left to
    the implementer is decided twice: once in the code, and again by the
    review that sends it back. Only the syntax is the implementer's: how a
    mock is written, a cast, a rune.

**Four sections answer what the review would ask.** Each is a question
`pd-plan-critic` puts to every plan; left to it, they are answered one round
at a time.

- `## Reuse` — what already exists that a task could reuse or would copy. For
  each thing a task adds — a function, a class, a component, a list, a
  constant, a test helper — the search for one that exists, as
  `searched: <query> in <where> -> <n>`, and what it found, with `file:line`;
  then what the plan reuses, and why not the rest. A list, a rule or a card
  copied under a new name is the finding this section pre-empts. A grep is
  yours to run; reading what it finds is a scout's.
- `## Modes` — each mode the touched code runs in, from `research.md`'s
  `## Modes of the environment`, and how the plan handles it: by which task,
  or why it does not apply. Rendering and async are a mode — what a component
  awaits before its first render, and what its spec then has to wait for — as
  are the operating systems, a packaged and a development build, and the
  runners a test runs under.
- `## Gates` — the commands that check the change: per task, the typecheck,
  the lint and the tests its `Done when` runs; and for each task that changes
  a file an earlier task's gate has passed, the gate that checks it again,
  after it. A gate that ran before the last change to a file is not a gate
  for that file.
- `## Body must disclose` — what a slice's pull request body has to say
  because the plan decided it: a behavior that changes without being asked
  for, a duplication kept on purpose, a decision the person made. One line
  per item, naming its slice; `none` when there is nothing.

A section with nothing to say says so, with the search that came back empty.

## Then

`pdkit render plan --issue <n> --values <f> --path plan.md`, one
`pdkit render task --issue <n> --values <f> --path tasks/T<k>.md` per task —
the task's values carry its Context, Tests, Steps and Notes — then
`pdkit task sync --issue <n>` so the ownership map the pre-write hook enforces
comes from the task files rather than from anyone's memory of them.

**Then read it the way the critic will, before anyone else does.** Take each
task through the checklist in `${CLAUDE_PLUGIN_ROOT}/agents/pd-plan-critic.md`
and the columns of its coverage map — order, runs on base, fails if unmet,
neighbor's pattern, local rules, environment modes, duplication, tests,
maintainer's rules — against `research.md` and the plan's own sections. A
check you cannot answer from them is a gap to close now, with a scout or a
`[NEEDS DECISION]`; a check the plan fails is a fix to make now. Each one the
critic finds instead costs a round.

`pdkit plan check <n>` before showing the plan to anybody: everything it finds
is something `/pd:plan-review` would find anyway, and finding it here costs one
command instead of a review round. Beside the shape, it refuses a task that
owns code with no `## Tests`, and one whose `Done when` leaves out the
typecheck or the lint of its files.

Then **run every `Done when`**, from the main checkout, which is on the base
branch:

```
pdkit plan probe <n>                      every live task
pdkit plan probe <n> --except T10,T12     leave out what takes an hour; say so
```

Read each command before it runs: the probe runs what the plan says. A plan
was approved after four review rounds and then stopped five times in exec on
commands that could never pass: a typecheck that fails on the base branch with
a config error, a lint on lines the task may not touch, a docs build that needs
an artefact nothing builds. Each was one run away. A red run here is often
expected — the spec file is not written yet — and that is fine; a red run for
any other reason is a `Done when` to fix now. A green run of a task that
changes code is the other warning: the command passes before the change it is
meant to prove — a script that passes with no test files, a spec that already
exists and runs only its old cases. Make it fail there: a new spec file, a
filter that names the new cases, a guard that fails on the base. A refactor's
command passes on both sides, and its `## Tests` says so. `pdkit plan check`
then lists every task whose command was never run, did not exit 0, or exited
0 while the task changes code, for the review.

Then `pdkit state <n> --to planned`.

Approval is a human action. On approval — and only then — `pdkit ids freeze
<n>` and `pdkit state <n> --to plan-approved`. The freeze is what makes R-IDs
a trace rather than a numbering: after it, they cannot be renumbered under a
PR that already cites them.

## When the phase runs long

`budget.turns.plan` is the ceiling here — a rough one, since no part of this
can count turns, you included. Well past it, stop at a point the files can
hold: `research.md` once phase 1 is done, open choices as `[NEEDS DECISION]` in
a draft plan. Then ask for a restart. A plan finished in a second session from
`research.md` costs less than one finished at the end of a long first, and
nothing in it depends on having watched the scouts work.

## Next

`/pd:plan-review <issue>` — before approval, not after. On approval, and only
then, freeze and move to `plan-approved`; what runs from there is
`/pd:exec <issue>`.

After the review, when the person has decided its findings: the review
records the decisions in `plan-review.md`, and the next step is this skill
again, in phase 0 — `pdkit next <issue>` says so. No context to pass.

**In a new session**, and the reason is sharper here than anywhere: the review
is meant to be read cold. A session that wrote the plan and then reviews it
carries every justification its author gave itself, and pays to re-read them on
every turn. `plan.md`, `tasks/` and `research.md` are what the review works
from. `pdkit next <issue>` prints the line to run.
