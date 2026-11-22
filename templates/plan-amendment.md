# AMENDMENT A{{index}}: DESKTOP-{{issue}}

- Raised by: {{source}}     <!-- review thread, upstream drift, validation finding -->
- Date: {{date}}
- Status: {{status}}        <!-- proposed | approved | rejected -->

## What changed upstream or in review
{{trigger}}

## Requirements affected
<!-- New R-IDs continue the existing numbering. Existing ones are never
     renumbered: every trace from requirement to commit to PR table would
     break at once.

     One row per change, from the `rows` array in the values file:
       {"rid": "R7" | ["R2", "R6"], "change": "<word>", "detail": "<why>"}
     Change is one of: added | withdrawn | unchanged | superseded by R<k> |
     replaced by R<k>. `pdkit amendment approve` applies the table to the
     issue's requirement set and to the plan's Requirements line, and refuses a
     word outside that list rather than guessing what it means. -->

| R-ID | Change | Detail |
|------|--------|--------|
{{rows}}

## Slices affected
<!-- A task this amendment adds is written here in exactly a plan's shape —
     `pdkit amendment approve` reads it with the plan's parser, renders
     tasks/T<k>.md from it, adds it to plan.md and re-runs `task sync`:

       ### T5 (replaces T2 and T3): <title>
       - Satisfies: R1, R7
       - Owns: packages/main/src/index.ts
       - Done when: `pnpm typecheck:main && pnpm exec eslint packages/main/src/index.ts && npx vitest run packages/main/src/index.spec.ts` -> exit 0
       - After: T4
       - Tests:
         | <case> | <when> | <asserts> | <fails without the change because> |
       - Steps:
         1. <step>

     In a plan whose task files list their tests, a task here that owns code
     lists its own under `- Tests:`, in the rows of a task file's `## Tests`,
     and runs the typecheck and the lint of its files in its `Done when`;
     approval refuses one that does not.

     A replacement takes the place in the order of the first task it replaces,
     and an `After` elsewhere that names a replaced task means its replacement.
     `pdkit amendment draft` writes these blocks from the open stop reports.

     New tasks take the next free T-ID. `(replaces …)` withdraws the tasks it
     names: their files are marked `withdrawn by A<k>`, they lose their Owns,
     and they keep their IDs. A heading that starts `### T<k>` and is not in
     this shape stops the approval rather than being skipped. -->
{{slices}}

## Why the original plan no longer holds
{{rationale}}

## Approval
<!-- Nothing moves until this is approved. An amendment applied silently makes
     the plan a record of what happened rather than what was intended. -->
{{approval}}
