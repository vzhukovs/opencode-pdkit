# {{taskId}}: {{title}}

- Issue: {{issue}}
- Satisfies: {{satisfies}}
- Status: {{status}}
- Attempts: {{attempts}}
  <!-- The live count is not this line: `pdkit task attempts --issue <n>` reads
       it from the journal, where every failed capture of `Done when` is
       recorded. At exec.max_attempts the task is blocked — the completion hook
       and `pdkit task start` both refuse it — and the way past is
       `pdkit task unblock --task <T> --reason "<what is different this time>"`,
       which is a sentence a human writes. -->

## Owns
{{ownedFiles}}

## Done when
```bash
{{command}}
```
Expected: {{expected}}

## Context
{{context}}

## Tests
<!-- One row per case the implementer writes: every path the task adds or
     changes, the error path included; both sides of each condition it adds,
     and a change of state across it; every side effect; for anything
     asynchronous, an assertion on completion, not on a state the UI shows
     halfway. The last column says why the case fails without the change: a
     case that would pass anyway tests nothing. A task that adds no behavior
     lists the existing tests that hold it, passing before and after. A test
     the implementer adds beyond these is named in its report. -->
| Case | When | Asserts | Fails without the change because |
|---|---|---|---|
{{tests}}

## Steps
{{steps}}

## Notes
{{notes}}
