---
name: audit
description: "Audit the diff against the plan, and review the whole branch once, in fresh context."
argument-hint: "<issue-number>"
disable-model-invocation: true
model: claude-agent/opus#high
---

Two readings in fresh context, and neither sees the implementer's reasoning,
which is exactly what would make it agree: `pd-auditor` holds the diff to the
plan, and the four review axes read the whole branch against the maintainer's
rules — once, before it is cut into pull requests, while a fix is still one
task away. Once the change is sliced, every fix means verifying the slice
again.

## Preconditions

`pdkit state <issue>` says `validated`. Auditing before validation means
auditing a diff nobody has run.

## 1. The facts

```
pdkit audit <n> --base main
```

State and route, the frozen requirement set, every task with its `Owns` and
`satisfies`, the state of every receipt, the changed files, and three findings
that need no judgment at all:

- **files changed outside every task's ownership** — the pre-write hook is
  silent when no task was ever started, so this is the only place such a change
  is certain to be seen;
- requirements with no task;
- tasks with no requirement;
- tasks no `pd-implementer` ran for, from the `agent-done` entries the journal
  tied to each task. A task started before the journal recorded any subagent
  is `not recorded`, which is not the same as none.

This command reports and never decides. It exits zero whatever it finds.

`pd-auditor` runs it, not this session. On a large issue the report lists
every task and every changed file, and that belongs in the context that reads
the diff.

## 2. The three questions

Dispatch `pd-auditor` with the issue number and the base, and nothing else.
It runs `pdkit audit` and reads `git diff main...HEAD` and the plan in its own
context. Do not read the diff here, not even to hand it over: the auditor's
context ends when it returns, and this session's is paid for again on every
turn until it ends. What comes back is the short form at the end of
`${CLAUDE_PLUGIN_ROOT}/agents/pd-auditor.md`, and that is all this session needs.

It does not get the implementer's account of the work — a summary of why the
code is right is the most persuasive thing in the room and the least
evidential.

1. Which requirements have no code? (The map says which have no *task*. Whether
   the code under a task actually implements the requirement is the question.)
2. Which code answers no requirement?
3. What changed inside `Owns` that the task never asked for?

Whether the added lines keep the maintainer's rules is not the auditor's
question: the review in step 3 reads the whole branch for that. Both read the
same commit, so dispatch the auditor once `target` in step 3 has started the
round, beside the axes.

## 3. The review: the whole branch, once

Upstream's review agent reads every pull request against
`${CLAUDE_PLUGIN_ROOT}/knowledge/maintainer-rules.md`. Read the branch the same
way now, while each fix is one task away.

```
pdkit self-review target --issue <n> --audit
```

It prints the diff of the whole branch against its base, the commit, the
changed files, the triage record, the plan and each task's `## Tests`, and
starts a round. First it runs what a grep sees, `maintainer-rules`, on that
commit. A **fail** is a rule with no exception, and no round starts until it
is fixed: `target` names the task that owns each line, and step 4 fixes it as
it fixes a finding. A warning is a rule with a condition of its own; `target`
prints its lines, and the axes rule on them.

- the four `pd-review-*` axes, in parallel. Each gets what `target` printed,
  as it printed it, the grep's warnings included, and is told this is our own
  branch before it is cut into pull requests: there is no title or body yet,
  and no threads. A row of a task's `## Tests` is a test the branch owes.
  Together they cover all twelve sections of the rules;
- wait for all four axis reports, then `pd-review-synth` on the four reports
  and the same triage record. It ends with the findings as JSON;
- `pdkit self-review record --issue <n> --audit --findings <f.json>`. It
  prints each open finding with the task that owns its file.

Do not read the diff here either: the axes read it in their own contexts, and
what comes back is their reports. **Never edit the findings to make the record
clean.** The record is what the review said.

## 4. Fixes, by `pd-implementer`

Every open finding — an `issue:`, a `question:` with no answer — on code this
branch wrote is fixed here, and so is a step 2 finding answered `revert the
code`, and a line the grep in step 3 failed. A `question:` can be answered
instead: put the answer in the finding's `answer` field and record again,
with the line of the plan, the triage record or the validation that answers
it. An answer nothing on disk supports is a question for the person. A `nit:`
is fixed only on lines the fix of an `issue:` changes anyway, never in a round
of its own; a pre-existing one is left as it is.

A fix is never written in this session. Per task that `record` names — or
`target`, for a line the grep failed — one at a time:

1. `pdkit task start --issue <n> --task T<k>`. It accepts a task that is
   done; from here, writes outside its `Owns` are refused.
2. A `pd-implementer`, briefed as "A finding to fix" in
   `${CLAUDE_PLUGIN_ROOT}/agents/pd-implementer.md`: its task file, and the
   findings on its files as `record` or `target` printed them. Nothing else.
3. `pdkit receipt write --issue <n> --task T<k>`. The receipt the task already
   has was captured before the fix, and the completion hook accepts it, so
   capturing again is yours.
4. `pdkit preflight <n> --only maintainer-rules`, read as `/pd:exec` step 5
   reads it.
5. Commit: conventional subject, one `Signed-off-by`. Then `pdkit task stop`.

A finding whose fix needs a file outside the task's `Owns`, or one in a file
no live task owns, is a finding about the plan: `pdkit task stop --finding`,
as `/pd:exec` describes under "When the plan is wrong", and the amendment
comes before `audited`. A step 2 finding answered `amend the plan` takes the
same route.

The fixes are not reviewed again here. The self-review of each pull request
in `/pd:pr` reads them, on the commit and the body being published: after
this review, that round confirms rather than discovers.

## 5. The verdict

`audit.md` under the issue is the auditor's answer as it came back: findings
first, each with a file and a line, then what it could not judge by reading.
Write it as returned. Opening the files to check a finding is reading the diff
here after all; a finding you doubt goes back to `pd-auditor` as a question,
and a review finding you doubt goes back to the axis that raised it, with the
code that answers it. If the axis keeps it, it is fixed.

Two disciplines, both from the same failure mode. A reader told to find
problems will find them in correct code, so: an empty findings section is a
valid result, and formatting the linter enforces is not a finding. The
maintainer's rules are not formatting, and a review finding is never waved
off as style. And where you are uncertain, say uncertain — fresh context
catches drift from the plan, not blind spots shared with the model that wrote
the code.

## Then

Show the person what the review left, `pdkit self-review show --issue <n>
--audit`. The nits do not hold the audit; fixing one is their call, and it
goes to an implementer like an issue.

`pdkit state <n> --to audited` when the auditor's findings are addressed or
accepted and every open review finding is fixed or answered. It is refused
until a review of the branch is recorded, and while a review that left
something open is about the commit the branch still stands on. A review
finding is addressed, never accepted: a rule the maintainer's agent will raise
on the pull request cannot be accepted here. Unaddressed findings are not a
reason to skip the transition quietly — they stay in `audit.md` and in the
record, and the state stays where it is.

**The rounds end** as in `/pd:pr` step 5. When `/pd:audit` runs again on a
new commit — after an amendment, say — that is a new round, and at
`review.self_review_rounds` the next one is refused. Stop and ask the person;
going on is theirs to word:

```
pdkit self-review continue --issue <n> --audit --reason "<what is different this time>"
```

## When the phase runs long

`budget.turns.audit` is low on purpose. The facts come from `pdkit audit`, the
reading from `pd-auditor` and the axes, the fixes from `pd-implementer`, and an
audit that runs long is usually this session reading the diff or writing the
code itself — their jobs, in their own contexts. The number is a guide rather
than a count anyone keeps. Past it, write what has been found to `audit.md` and
ask for a restart: the review is in its record, and `pdkit task list` says which
fixes have their receipts.

## Next

`/pd:slice <issue>` — the change set becomes a verified graph of atomic pull
requests, even when the graph turns out to have one node.

**In a new session.** Slicing works from the finished diff and from
`slice suggest`, and what it needs of the audit is in `audit.md`. The
conversation that produced the findings has no further vote, and carrying it
forward means paying for it on every turn of the slicing. `pdkit next <issue>`
prints the line.
