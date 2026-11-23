# The ownership hook

[Workflows](../README.md) › [Reference](README.md)

While a task is marked active in a working tree, writes outside that task's files
are refused:

```
pdkit task sync --issue 12345          # read the Owns sets out of the task files
pdkit task start --issue 12345 --task T1
…
pdkit task stop
```

`task sync` is not optional. Without it the state record has no ownership for the
task, and the hook allows every write while saying so — which reads as nothing
having happened.

It also lets go. A task the plan dropped before its approval, its file deleted
the way `/pd:plan` drops one, loses its ownership at the next `task sync`, which
says so on a line of its own; its ID stays spent, and is not handed out again.
After the approval a task leaves the plan only by withdrawal, through an
amendment, and `task sync` drops nothing.

Two allowances are deliberate. With no active task nothing is constrained: the rule
belongs to executing a planned task, not to having the plugin installed. And with a
task whose ownership was never synced, the write goes through with a message naming
the command that fixes it, because blocking there would make an unsynced plan look
like a broken tool.

What catches a worker that ran outside all of this is `pdkit audit`, which reports
every file changed outside every task's ownership. The hook catches it in time; the
audit catches it for certain.

---

**The design** — [6 · Hooks](../../specification/06-hooks.md), [architecture · Hooks](../../architecture/06-hooks.md)

← [The push gate](push-gate.md) · [Reference](README.md) · [Receipts](receipts.md) →
