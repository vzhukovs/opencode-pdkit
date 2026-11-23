# `/pd:audit <issue>` — the diff against the plan, the branch against the rules

[Specification](../README.md) › [4. Contracts](README.md) › `/pd:audit`

Two readings in fresh context, and neither sees the implementer's reasoning —
that is what makes them capable of disagreeing. `pd-auditor` holds the diff to
the plan. The four review axes read the whole branch against the maintainer's
rules, once, before it is cut into pull requests, while a fix is still one task
away.

The machine goes first here too. `pdkit audit <n> [--base main] [--json]`
collects facts and reaches no verdict:

| Collected | Why |
|---|---|
| state, route, R-set and whether it is frozen | without the freeze, tracing means nothing |
| tasks with their `Owns` and `satisfies` | the map the diff is checked against |
| receipts: absent / invalid / non-zero exit | "done" without proof is visible before reading any code |
| changed files `base...HEAD` | |
| **files outside every `Owns`** | the auditor's third question, answered mechanically |
| R-IDs with no task, tasks with no R-ID | the first and second questions, at the level of the map |

Files outside `Owns` are the insurance against the hole in `pre-write`: the hook
says nothing when there is no active task, so an implementer launched around
`pdkit task start` is unconstrained. The hook catches it in time; the audit
catches it for certain.

What is left to `pd-auditor`: a requirement with code against it that is the
wrong code; code answering no requirement that nevertheless looks reasonable; a
change inside `Owns` that the task did not ask for. None of the three is
greppable.

## The review of the whole branch

What the maintainer's rules say about the added lines is the review's, not the
auditor's. `pdkit self-review target --issue <n> --audit` prints what the four
`pd-review-*` axes read — the diff of the whole branch against its base, the
commit, the triage record, the plan and the `## Tests` each live task owes — and
starts a round. The greppable part goes first: it runs `maintainer-rules` on that
commit and refuses one the grep fails, naming the task that owns each line, so a
failure is fixed before any model reads the code; the lines of a rule with a
condition of its own are printed for the axes. `pd-review-synth` merges their reports, and
`pdkit self-review record --issue <n> --audit --findings <f>` keeps the result
in `self-review.json` under its own key, with no body: bodies are written per
pull request, and the self-review of each one reads them. Its rounds are counted
apart from those of the pull requests, against the same
`review.self_review_rounds`.

`record` and `show` name, for each open finding, the live task whose `Owns`
cover its file. That task is where the fix goes: `pdkit task start` accepts a
task that is done, `pd-implementer` makes the fix inside its `Owns`, `pdkit
receipt write` captures `Done when` again, and the fix is a commit of its own.
A finding in a file no live task owns, or whose fix needs a file outside the
task's, is a finding about the plan, and goes the way of a stop report and an
amendment.

`pdkit state <n> --to audited` is earned rather than asserted: it is refused
until a review of the branch is recorded, and while a review that left an
`issue:` or an unanswered `question:` open is about the commit the branch still
stands on. Whether the fix is right is not asked there. The self-review of each
pull request in `/pd:pr` reads the commit and the body being published, and
after this review it confirms rather than discovers.

---

← [`/pd:validate`](validate.md) · [Contents](../README.md) · [`/pd:slice`](slice.md) →
