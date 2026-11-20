# 1. A bug fix

[Workflows](README.md) › Part I — Choosing and starting work · [Sessions and models](#sessions-and-models)

```
/pd:triage 12345      → route, drafted requirements
/pd:plan 12345        → reconnaissance, open questions, plan     [you approve]
/pd:plan-review 12345 → adversarial review of the plan
/pd:exec 12345        → implementation, one task per worker, receipts
/pd:validate 12345    → evidence from the running application
/pd:audit 12345       → diff against plan, fresh context
/pd:slice 12345       → usually one slice                        [you approve]
/pd:preflight 12345   → deterministic gates
/pd:pr 12345          → branch, PR body, PR                      [you confirm push]
```

**Each line is its own session.** Close the session when a phase ends and open a
new one for the next; `pdkit next 12345` prints what to run. This is not a
preference about tidiness — see [one session per phase](reference/sessions.md)
for what carrying one session through the whole list costs.

**The code is written in the issue's own tree.** `/pd:exec` starts by creating
`DESKTOP-12345` with `pdkit worktree create --issue 12345 --slug <slug>` and
moving the session there. The main checkout stays on the base branch as the
template trees are made from, and `pdkit task start` refuses to run a task in
it.

**Starting with what you already know.** The first line is the command;
everything after it in the same message is kept verbatim as prior context:

```
/pd:triage 12345
Fourth pass of the pattern from #18831 — containers (#18889) and networks
(#19048) are in. Repeat the #19048 approach: convert in the store fetcher,
not in the consumers. Trap: EventStore.performUpdate has no catch, so a
throwing converter drops the whole update rather than one screen.
```

That reaches `## Prior context` in `issue.md` and stays there. Said in a chat
message instead, it would be gone by the time `/pd:plan` runs in a new session
— and a requirement drawn from it is tagged `[operator]`, so later readers can
tell what the issue asked for from what you brought to it.

## Sessions and models

Where each step runs and on which model — the columns are explained in
[Which session, which model](reference/sessions.md#which-session-which-model).

What you type, session by session — `/clear` starts the next one:

```
cd <fork> && opencode               the fork, on main

/pd:triage 12345

/clear
/pd:plan 12345

/clear
/pd:plan-review 12345
pdkit ids freeze 12345              your approval
pdkit state 12345 --to plan-approved

/clear
/pd:exec 12345                      moves the session into DESKTOP-12345

/clear
/pd:validate 12345

/clear
/pd:audit 12345                     pd-auditor is sol#high on its own

/clear
/pd:slice 12345
pdkit state 12345 --to slices-approved   your approval

/clear
/pd:preflight 12345

/clear
/pd:pr 12345                        one session per slice
```

| Step | Session | Default model | Subagents |
|---|---|---|---|
| `/pd:triage 12345` | **new** · main checkout | `sol#high` | `pd-scout` · `sonnet#high` |
| `/pd:plan 12345` | **new** · main checkout | `astra#high` | `pd-scout` · `sonnet#high` |
| `/pd:plan-review 12345` | **new** · main checkout | `opus#high` | `pd-plan-critic` · `opus#high` |
| approve: `pdkit ids freeze`, `pdkit state --to plan-approved` | the plan-review session, or **terminal** | — | — |
| `/pd:exec 12345` | **new** · main checkout, then the skill moves it into `DESKTOP-12345` | `sonnet#high` | `pd-implementer` · `sonnet#high`, one per task |
| `/pd:validate 12345` | **new** · issue tree | `terra#medium` | `pd-validator` · `terra#medium` |
| `/pd:audit 12345` | **new** · issue tree | `opus#high` | `pd-auditor` · `sol#high` |
| `/pd:slice 12345` | **new** · issue tree | `opus#high` | `pd-slicer` · `opus#high` |
| approve: `pdkit state --to slices-approved` | the slice session, or **terminal** | — | — |
| `/pd:preflight 12345` | **new** · issue tree | `flash#low` | — |
| `/pd:pr 12345` | **new** · issue tree, one per slice | `sonnet#medium` | — |

No model to type on this path. Each command switches the session to its own —
`astra#high` for the plan, `sonnet#high` for `/pd:exec`, and so on down the
table — before its instructions reach the model, and the session keeps it
until the next command, whatever it was on before: the planning model does not
carry over into the implementation.

---

**The design** — [`/pd:plan`](../specification/04-contracts/plan.md), [`/pd:plan-review`](../specification/04-contracts/plan-review.md)

← [0 · Picking what to work on](00-picking-what-to-work-on.md) · [Contents](README.md) · [2 · A one-line fix](02-one-line-fix.md) →
