# Hooks other plugins install, and what they can do to the gate

[Configuration](README.md) › 7 of 8

In Open Code a hook is code a plugin runs inside the server, and the gate is
one of them. This plugin loads from your global config into every session on
the machine, and so does any other plugin there. Hooks on a tool call run in
the order the plugins load — Open Code's own first, then the plugins of your
config in the order `plugins` lists them, then the rest of Open Code's own —
and each sees what the one before it left.

**A plugin before this one cannot get a command past the gate.** It can rewrite
a command — wrap it, prefix it, add to it — and the gate then judges what it
produced, not what the model wrote. That is why `lib/hooks/command-parse.js`
strips wrapper programs — `sudo`, `env`, `nice`, `nohup` and the rest — before
any rule is applied, and why `/pd:doctor --gate-selftest` probes that exact
shape. The question the parser answers is never "did somebody mean to wrap it"
but "what is going to run". Open Code itself rewrites before the gate: a model
that calls a `bash` tool reaches it renamed `shell`.

**Nor can a tool of its own.** The gate reads every tool call whose input
carries a `command` string, not only Open Code's `shell`, so a command sent
through another plugin's tool, or an MCP server's, is held to the same rules.

**A plugin after this one can.** Its hook runs once the gate has let a command
through, and may change it; nothing checks the command again. None of Open
Code's own plugins does, in 2.3.0. The gate guards against the model, not
against code inside the server, which could as well run `git push` itself. So
read what a plugin does to commands before you add it, keep one that rewrites
them before `opencode-pdkit` in `plugins`, and run the self-test afterwards. It
sends every command the gate must refuse, wrapped ones included, through the
runner the gate calls — not through another plugin's hook: what one after this
one does is outside every check.

**Switched off, there is no gate.** `-opencode-pdkit` in `plugins` of any
config, a policy that denies the plugin, an install or a load that failed: Open
Code starts the session without the plugin and its gate, since it has no notion
of a plugin a session cannot do without. The `plugin` line of `pdkit doctor`
says whether Open Code runs this one for the directory, and why not.

**Receipts are unaffected either way.** `lib/evidence.js` spawns the command
itself from Node, so no hook on a tool call is consulted, before the gate or
after it, and nothing sits between the command and the output that lands in the
receipt.

---

**The design** — [6 · Hooks](../specification/06-hooks.md#where-open-code-differs-and-what-stands-in), [workflows · The push gate](../workflows/reference/push-gate.md)

← [MCP servers](06-mcp-servers.md) · [Contents](README.md) · [Retired keys](08-retired-keys.md) →
