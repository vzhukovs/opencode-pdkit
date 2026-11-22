# 5. Agents and model routing

[Specification](README.md) › Section 5

| Agent | Model | Tools | Role |
|---|---|---|---|
| `pd-scout` | sonnet#high | Read, Grep, Glob, Bash (ro) | reconnaissance, ≤ 40 lines (50 with local rules and modes of the environment), every claim `file:line`, proposes nothing |
| `pd-implementer` | sonnet#high | everything except push/gh | one task, only files from `Owns`, the tests its `## Tests` lists and those it adds named, a receipt with real output |
| `pd-auditor` | sol#high | Read, Grep, Glob, Bash (ro) | diff against plan, fresh context |
| `pd-plan-critic` | opus#high | Read, Grep, Glob | adversarial review of the **plan**, before code: the whole plan, some of its areas, or one axis across it; checks the plan's written answers and the design it settles against the maintainer's rules 1–10 |
| `pd-slicer` | opus#high | Read, Grep, Bash | the slice graph, from the finished diff |
| `pd-validator` | terra#medium | Bash + Playwright MCP tools | drives the built application, collects evidence |
| `pd-archaeologist` | sol#high | Read, Bash (git log/blame) | history: reverts, regressions, who and why |
| `pd-conflict-analyst` | opus#high | Read, Grep, Bash | mechanical conflict or semantic |
| `pd-thread-resolver` | sonnet#high | Read, Edit, Bash | one review thread → fix + draft reply |
| `pd-review-architecture`, `pd-review-tests` | sol#high | Read, Grep, Glob | two of the review axes |
| `pd-review-api-compat` | opus#high | Read, Grep, Glob | the third |
| `pd-review-product` | sonnet#high | Read, Grep, Glob | the fourth |
| `pd-review-synth` | opus#medium | Read | synthesis into one verdict |

The Model column is each agent's default, `model:` in its frontmatter, in
short: `opus` and `sonnet` are `claude-agent/opus` and `claude-agent/sonnet`,
Open Code's Claude Agent provider; `sol` and `terra` are `openai/gpt-6.1-sol`
and `openai/gpt-6.1-terra`. The part after `#` is the variant — the effort. As
shipped, what one provider's model writes, another's checks: `pd-implementer`
writes the code on a Claude model and `pd-auditor` accepts it on an OpenAI one,
as `pd-plan-critic`, on a Claude model, reviews a plan `/pd:plan` wrote on an
OpenAI one; the review axes are split between the two. The whole list, commands
included, is in
[`configuration/05-models.md`](../configuration/05-models.md#what-the-defaults-are).

**The Tools column is the `tools:` field in agent frontmatter, and there are no
other levers.** The plugin registers each agent from its file
(`opencode/agents.js`) and reads `name`, `description`, `model` and `tools`
from the frontmatter, and the body as the system prompt; nothing else.
`tools:` becomes the agent's permissions, in an order that is the point: first
a rule that denies everything, then an allow for the action Open Code checks
each listed tool by (`Read` → `read`, `Grep` → `grep`, `Glob` → `glob`,
`Bash` → `shell`, `Write` and `Edit` → `edit`, an MCP tool
`mcp__<server>__<tool>` → `<server>_<tool>`), and last, reading in two
directories outside the project — the plugin's root, for its knowledge and
templates, and `$PDKIT_HOME`, for the plans the critic reads. What an agent was
not given, it does not see; a tool with no counterpart stays denied, with a line
in the server's log. Two consequences follow:

- **An MCP server lives at session level, not agent level.** Playwright is not
  "granted" to `pd-validator`; the user connects the server, and `tools:` decides
  which agents can see its tools. The main session sees the server too, as it
  did under Claude Code; the other thirteen agents do not.
- **The `pd-implementer` restriction is its permissions plus the hooks**: the
  gate on every command it runs (`pre-bash`) and the ownership check on every
  file it writes (`pre-write`). A prompt does not hold that, which is why it is
  duplicated by a hook.

Where Open Code's permissions differ from what `tools:` gave under Claude Code,
the registrar holds to Claude Code's set where it can, and the differences are
named:

- **`edit` shows more than writing files.** The action that allows `write`,
  `edit` and `patch` also offers Open Code's `opencode_worktree_remove`, which
  no agent had; the plugin takes that tool out of every request of the agents
  it would reach (`EXTRA_TOOLS`).
- **Reading outside the project is narrower.** An agent reads outside it only
  under the plugin's root and `$PDKIT_HOME`; any other path there is refused to
  its `read`, `grep` and `glob` without a question, though not to a shell
  command of an agent that has `shell`. Under Claude Code an agent's `Read`
  reached any path. The
  two directories cover everything a prompt or a brief names outside the
  project.
- **The person's own rules come last.** Permissions at the top level of an Open
  Code config are appended to every agent's, the plugin's included; after them
  come `agents.<id>.permissions` of the config and the `permissions` of an
  agent file `<id>.md` in a config directory, for that one agent. They widen
  what `tools:` gave — `shell` allowed there reaches a read-only reviewer too —
  or narrow it: `playwright_* deny` takes the Playwright tools away from
  `pd-validator` ([section 8](08-mcp-servers.md)). The plugin cannot stand
  after a config, and does not fight it; the gate and the ownership check hold
  whatever an agent may run. `pdkit doctor` (`permissions`) compares each
  agent's rules, as Open Code reports them, with the ones the registrar built
  from `tools:`, by the registrar's own code, and names every rule after them
  that lets an agent do more than its `tools:` give or keeps from it what they
  give: the agent, the rule, the config document it is in, and what it
  changes. What it does not see: what a person allowed with "always" and a
  session's own rules, which Open Code keeps apart from an agent's; and which
  line of an agent file a rule comes from — Open Code reports the directory,
  not the file, so the doctor names the agent's file when there is one. Open
  Code asking before the plugin's own files is not a change: the plugin
  answers that itself.
- **`skill` is listed and refused.** An agent without `Skill` in `tools:` still
  sees the `skill` tool, because a built-in plugin of Open Code adds a rule of
  its own after every plugin's; a call is refused by the first rule, and no
  skill runs.

**Model routing starts from `model:` in frontmatter** — in `skills/*/SKILL.md`
and `agents/*.md`, one string each, `provider/model#variant`, with the effort
as the variant rather than a key of its own. That is the default, and the
plugin's own config, `$PDKIT_HOME/config.yaml`, deliberately has no `routing:`
block: changing `pd-auditor`'s model changes the properties of acceptance, and
that should not switch on an unnoticed parameter. What overrides a default is
the person's choice, named in one place: a map in the plugin's entry of Open
Code's global config, `options.models`, keyed by agent or by command
(`pd:plan`). For an agent, Open Code's own `agents.<id>.model` wins over both;
for a command, the map does. A value that is not `provider/model#variant`, or a
key that names nothing in the plugin, is dropped with a line in the log, and
the default stays. `pdkit doctor` lists all thirty-five — fourteen agents,
twenty-one commands with a model — with the model each runs on, where it came
from, and whether this Open Code can use it. How to write the map is in
[`configuration/05-models.md`](../configuration/05-models.md).

**A command's model holds for the phase.** Running `/pd:<skill>` checks the
command's model against the ones Open Code can use and switches the session to
it, variant included, before the command's instructions reach the model; a model
it cannot use is refused before anything about the session changes, with the
model and where it came from. The session then stays on it — on every later
message, across a restart of the TUI, on `opencode run --session` — until the
person picks another in `/models` (the variant in `/variants`, also `/effort`
or `ctrl+t`) or runs the next command. Outside the commands the session runs on
whatever model the person chose, as any session in Open Code does; nothing is
written into the fork. `/new` and `/clear` carry the current model into the new
session without its variant, until the next command. The three phrase-triggered
skills name no model, and their commands run on the session's.

An agent's variant is part of its model, so `/variants` in the session does not
reach it: `pd-auditor` runs at `high` whatever the session is set to, and a
different effort for an agent is a different value in `options.models`. Under
Claude Code an agent without `effort:` ran at the session's level.

This replaces what the Claude Code version had to work around. There, a
skill's `model:` held for its first turn and the session's model ran the rest
of the phase, surviving `/clear`, so the frontmatter routed the phase only if
the person typed `/model` at the start of the session: `pdkit init` wrote a
default model into the fork, `pdkit next` and the session summary printed the
`/model` line before the command, the `UserPromptSubmit` hook said so when the
session was on the wrong one, and `effort:` had to be typed as `/effort`. None
of that is needed when the command sets its own model, and none of it is left.

**Honestly about token economics.** "A strong model plans, a working one
implements" saves less than it appears: to plan well, the planner has to
understand the code, which causes a double investigation — first the scouts,
then itself. The real saving comes from three other things: the scouts
compressing the map (the planner reads 40 lines instead of 4000), fresh context
per task (no accumulation of failed attempts), and receipts instead of diffs at
acceptance. The model split is a consequence, not a cause. On a tight budget,
keep the strongest model you have on `plan` and on `pd-auditor`, and run
everything else on a working one.

---

**In brief** — [`architecture/`](../architecture/README.md): [2 · The pieces](../architecture/02-pieces.md)

← [`/pd:knowledge`](04-contracts/knowledge.md) · [Contents](README.md) · [6 · Hooks](06-hooks.md) →
