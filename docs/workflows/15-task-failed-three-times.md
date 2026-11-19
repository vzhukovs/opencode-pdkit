# 15. A task that has failed three times

[Workflows](README.md) › Part III — Living with an open pull request · [Sessions and models](#sessions-and-models)

```
pdkit task attempts --issue 12345
pdkit task unblock --issue 12345 --task T1 --reason "plan amended: A1 splits the fixture"
```

Every failed capture of `Done when` is counted, and the count comes from the
captures rather than from anyone's account of them. At `exec.max_attempts` — three
by default, zero switches it off — the task is blocked in three places, because
there are three ways past it: the completion hook, `pdkit task start`, and the
summary a new session prints. That last one matters most: three failures live in
the context a restart just discarded.

**The reason on `unblock` is required, and it is the whole mechanism.** Twice, "fix
it and try again" is right. The third time it is the advice that built the loop, and
the question worth forcing is what changed between the second attempt and the third.
If nothing did, the plan is wrong rather than the code.

## Sessions and models

Where each step runs and on which model — the columns are explained in
[Which session, which model](reference/sessions.md#which-session-which-model).

What you type, session by session — `/clear` starts the next one:

```
pdkit task attempts --issue 12345
pdkit task unblock --issue 12345 --task T1 --reason "…"     the reason is yours

/clear
/pd:exec 12345 T1
```

| Step | Session | Default model | Subagents |
|---|---|---|---|
| `pdkit task attempts` | **terminal** | — | — |
| `pdkit task unblock … --reason` | **terminal** — the reason is yours | — | — |
| next: `/pd:exec 12345 T1` | **new** · issue tree | `sonnet#medium` | `pd-implementer` · `sonnet#medium` |

If the reason is that the plan is wrong, the amendment is planning work, on
planning's model — `opus#high` by default. No command switches to it for an
amendment, so pick it in `/models` for the session that writes one.

---

**The design** — [6 · Receipts, and why the ceiling holds](../specification/06-hooks.md#receipts-and-why-the-ceiling-holds)

← [14 · Two issues at once](14-two-issues.md) · [Contents](README.md) · [16 · Starting one issue over](16-starting-over.md) →
