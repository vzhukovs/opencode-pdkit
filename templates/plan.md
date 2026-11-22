# PLAN: DESKTOP-{{issue}}

- Requirements: {{requirementIds}} (frozen on approval)
- e2e coverage: {{e2eCoverage}}   <!-- required | optional | no — with justification -->
- Slice hypothesis: {{sliceCount}} slices

## Context
<!-- Every point cites file:line from reconnaissance. A context line without a
     location was not verified. A point saying something is absent cites the
     search instead: `searched: <query> in <where> -> 0`. -->
{{context}}

## Reuse
<!-- What already exists that a task could reuse or would copy: for each thing
     a task adds — a function, a class, a component, a list, a constant, a
     test helper — `searched: <query> in <where> -> <n>`, what it found with
     file:line, and whether the plan reuses it, or why not. The critic's first
     question is whether something already does it; this is the answer, given
     before it is asked. -->
{{reuse}}

## Modes
<!-- Each mode the touched code runs in — rendering and async (what a
     component awaits before its first render, and what its spec then waits
     for), the operating systems, a packaged and a development build, the
     runners of its tests — and how the plan handles it: by which task, or why
     it does not apply. From research.md's "Modes of the environment". -->
{{modes}}

## Frozen interfaces
<!-- Real signatures shared between tasks. Written here once so two tasks
     cannot each invent their own version of the same boundary. -->
```ts
{{interfaces}}
```

## Tasks
<!-- One block per task, in exactly this shape — `pdkit plan check` reads them
     back, so it is a contract and not a suggestion:

       ### T1: <title>
       - Satisfies: R1, R3
       - Owns: packages/main/src/plugin/exec.ts
       - Done when: `pnpm test:main -- exec.spec.ts`
       - After: T4                (optional: tasks that must be done first)
       - Slice: S2                (optional: the slice it is meant for)
       - Intent: <one sentence: what the task changes, and for which requirement>

     That is the whole block. A task's Context, Tests, Steps and Notes are
     written in tasks/T1.md and nowhere else: this file is the index and the
     contracts, the task file is what the implementer is handed, and a step
     written in both is two places every revision edits and every review
     compares.

     Write the blocks in the order they should run. `After` is the order exec
     cannot break: `pdkit task start` refuses a task whose After is not done,
     and among tasks free to start, the one written first runs first. An order
     stated only in a step's prose is an order nobody picking a task reads.

     Owns is exclusive: two tasks sharing a file is a planning error, not a
     coordination problem, and the pre-write hook enforces it. Done when is an
     executable command, because "works correctly" cannot be checked by anyone
     except its author. One to three files per task.

     A task that writes nothing — a whole-suite gate, a measurement — says so:

       - Owns: (none — verification only, writes no files)

     That is read as no files at all, and it means what it says in both
     directions: the hook refuses every write such a task attempts, and every
     slice carries the requirements it satisfies, because a check over the whole
     tree is a claim every pull request cut from the change has to hold. -->
{{tasks}}

## Gates
<!-- Per task, the typecheck, the lint and the tests its Done when runs. Then,
     for each task that changes a file an earlier task's gate has passed, the
     gate that checks it again, after it: a gate that ran before the last
     change to a file is not a gate for that file. -->
{{gates}}

## Upstream compliance
- SPDX headers needed: {{spdx}}
- Schemas touched: {{schemas}}
- `extension-api.d.ts` touched: {{extensionApi}}
- Commit scope: {{scope}}

## Slice hypothesis
<!-- Not the final graph — /pd:slice produces that from the real diff. But
     tasks are ordered so that cutting is possible later. Planning without
     this produces an interleaved diff that cannot be split without redoing
     the work. -->
{{sliceHypothesis}}

## Body must disclose
<!-- What a slice's pull request body has to say because this plan decided
     it: a behavior that changes without being asked for, a duplication kept
     on purpose, a decision the person made. One line per item, naming its
     slice; `none` when there is nothing. -->
{{bodyMustDisclose}}

## Open decisions
<!-- [NEEDS DECISION] here blocks approval. An unasked question does not
     disappear; it becomes an assumption nobody agreed to. -->
{{decisions}}
