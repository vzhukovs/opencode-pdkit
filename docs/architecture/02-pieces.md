# The pieces

[Architecture](README.md) › 2 of 7

| Piece | Role |
|---|---|
| [`bin/pdkit`](../../bin/pdkit) + [`lib/`](../../lib/) | everything deterministic: state machine, IDs, slicing, gates, preflight, validation evidence |
| [`skills/`](../../skills/) | the workflow surface — what you invoke |
| [`agents/`](../../agents/) | bounded workers with their own context |
| [`lib/hooks/`](../../lib/hooks/) | the rules that a prompt cannot guarantee |
| [`knowledge/`](../../knowledge/) | upstream constitution, shipped with the plugin |
| [`templates/`](../../templates/) | the shape of every artefact |
| [`opencode/`](../../opencode/) | the part Open Code loads: it registers the commands and the agents, puts `bin/` on the PATH, and its hook bridge runs `lib/hooks/` on Open Code's events |

The split is not stylistic. Anything that must be **true** is in `lib/`, the
hook rules included, where it can be tested. Anything that requires
**judgment** is in `skills/` and `agents/`. A rule stated only in a prompt is a
rule that holds most of the time. `opencode/` is everything that knows Open
Code, and the rules and the prompts reach the host through it
([6 · Hooks](06-hooks.md)).

---

**In depth** — [`specification/`](../specification/README.md):

- [§2 — Plugin structure](../specification/02-plugin-structure.md)
- [§5 — Agents and model routing](../specification/05-agents.md)

← [The constraint](01-constraint.md) · [Contents](README.md) · [The lifecycle](03-lifecycle.md) →
