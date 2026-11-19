# Model selection

[Configuration](README.md) › 5 of 8

Not in `config.yaml`. Each command and each agent names its default model in
its own frontmatter — `model:` in `skills/*/SKILL.md` and `agents/*.md` — the
way Open Code names a model: `provider/model#variant`, the variant being the
effort. What you choose instead goes in one place outside this repository: a
map in the plugin's entry of Open Code's global config.

This is deliberate. `$PDKIT_HOME/config.yaml` has no `routing:` block, because
changing `pd-auditor`'s model changes what acceptance is worth, and that should
not turn on a key nobody notices. The map sits beside the plugin it configures,
and `pdkit doctor` shows, for every agent and command, the model it runs on and
where that came from.

## Where a model comes from

The first one set wins:

| For | Order |
|---|---|
| an agent | `agents.<id>.model` in an Open Code config, a project's over the global one → `options.models.<id>` → `model:` in `agents/<id>.md` |
| a command | `options.models["pd:<skill>"]` → `model:` in `skills/<skill>/SKILL.md` |

`agents.<id>.model` is Open Code's own key, and the plugin cannot turn it off:
for an agent it wins over the map. `package-map`, `upstream-rules` and
`worktree-kit` name no model, and their commands run on the session's.

## The map

`opencode plugin add opencode-pdkit` writes the plugin's entry as a string:

```json
{
  "plugins": ["opencode-pdkit"]
}
```

Write it as an object instead, with the same package name, and give it
`options.models`:

```json
{
  "plugins": [
    {
      "package": "opencode-pdkit",
      "options": {
        "models": {
          "pd:plan": "openai/gpt-6.1-terra#high",
          "pd-plan-critic": "openai/gpt-6.1-terra#high",
          "pd:exec": "deepseek/deepseek-flash#high",
          "pd-implementer": "deepseek/deepseek-flash#high"
        }
      }
    }
  ]
}
```

A key is a command as you type it, without the slash, or an agent's ID. A
command and the agents it calls are separate keys: mapping `pd:exec` leaves
`pd-implementer` on its default. Open Code's plugin commands know the object:
`opencode plugin add` again says the plugin is already configured,
`opencode plugin update` leaves the object and its options as they are, and
`opencode plugin remove opencode-pdkit` takes the whole entry, map included.

A running server picks the edit up within a second; there is nothing to
restart. What cannot be read is dropped and the default stays: a key that names
no agent or command of the plugin, a value that is not
`provider/model#variant`, any key of `options` other than `models`. Each one is
a line in the server's log and in `pdkit doctor`.

Keep the entry in the global config, `~/.config/opencode/opencode.json`. A
project config in the fork is a file git does not ignore there, and it reaches
none of the issue worktrees, each a directory of its own.

**Open Code 1 reads the same file.** If it runs on this machine again, it skips
`plugins` with a line in its log, and refuses the whole file when it finds a
`permissions` key, at the top level or under an agent. Nothing on this page
needs one.

## Where the strongest model goes

The defaults keep the strongest class where nothing re-checks the verdict by
machine, and a working one where a machine decides. That is the hint for your
map: whichever provider you use, these are the places for the best model you
have.

| Default | Where | Why |
|---|---|---|
| `claude-agent/opus#high` | `pd:triage`, `pd:plan`, `pd:plan-review` | verdicts nothing re-checks: what the issue is, how to build it, whether the plan holds before any code |
| `claude-agent/opus#high` | `pd:pr-sync` | a machine checks that a review fix compiles and passes, not which of a reviewer's alternatives to take, nor whether a reply answers what was asked. Its resolvers, `pd-thread-resolver`, stay on Sonnet: they carry out a decision the person has already approved |
| `claude-agent/opus#high` | `pd-auditor`, `pd-plan-critic` | acceptance against the plan, and the adversarial review of the plan before code |
| `claude-agent/opus#medium` | `pd-review-synth`, `pd:review-pr` | the axes of a review weighed into one verdict; a review of someone else's pull request is outside the issue's lifecycle, and no machine checks it |
| `claude-agent/opus#medium` | `pd-conflict-analyst` | the semantic conflict, which merges cleanly: the build is green, and the code no longer does what the plan intended |
| `claude-agent/opus#medium` | `pd:knowledge` | every later issue reads the knowledge base, and nobody re-derives what it states as settled |
| `claude-agent/sonnet#…` | the rest | a machine decides: receipts accept a task, `pdkit slice verify` a cut, preflight the push. `pd:audit` itself only runs `pdkit audit` and dispatches `pd-auditor`; the verdict is the agent's |
| `claude-agent/haiku#low` | `pd:editor`, `pd:open` | they open a directory |

On a tight budget, keep the strongest on `pd:plan` and on `pd-auditor`, and run
the rest on a working model. `pdkit doctor` does not judge whether a model is
strong enough: that is a judgement, not a fact. A release that moves a default
to a cheaper class or a smaller variant says in [CHANGELOG.md](../../CHANGELOG.md)
what decides in that phase instead of the model; your own map is yours.

`pdkit cost` weighs a model by Anthropic's list prices — any model without
"opus" in its name, of any provider, as Sonnet — and prints the tokens of each
model beside the totals, for whoever prices them otherwise
([workflows · cost](../workflows/reference/cost.md)).

## Variants: the effort

The variant is part of the model: `#high`, `#medium`, `#low`, or none. Which
variants exist is up to each model, not its provider: `deepseek/deepseek-flash`
has `none`, `low`, `high` and `max`, and no `medium`; some models have none at
all. `opencode models` lists only `provider/model`; `opencode api GET
/api/model` has each model's `variants`, and the doctor's table names the ones
a model has when yours is not among them. Without a variant, the provider's own
default applies.

There is no effort level for everything, as there was under Claude Code with
`effortLevel` and `CLAUDE_CODE_EFFORT_LEVEL`: each agent and each command
carries its own. An agent's variant is part of its model, so nothing in the
session reaches it — `pd-auditor` runs at `high` whatever the session is set
to, and a different effort for an agent is a different value in the map. Not
checked: whether `CLAUDE_CODE_EFFORT_LEVEL` in the environment of the Open Code
server still reaches the calls of the `claude-agent` provider, which runs
Claude through the Claude Agent SDK. Under Claude Code it overrode even a
skill's own effort, so leave it unset there.

## How long a command's model holds

**For the phase.** Running `/pd:<skill>` checks the command's model and variant
against the ones Open Code can use here, then switches the session to it before
its instructions reach the model. The session stays on it — every later
message, a restart of the TUI, `opencode run --session` — until you pick
another or run the next command. There is no `/model` to type before a phase,
and nothing reminds you to.

**A model Open Code cannot use is refused, not replaced.** The command does not
start: the TUI says why, naming the model and where it came from, your input
stays in the field, and the session stays on its model. An agent on such a
model fails when it is called.

**Your pick in `/models` is yours.** Choose another model mid-phase and it
applies from your next message until the next command, as typing a model in
the middle of a phase always did. `/variants` — also `/effort`, `/thinking`,
or `ctrl+t` — changes the session's variant the same way. Open Code remembers
your variant for that model in `~/.local/state/opencode/model.json`, and in a
new session it wins over a variant in your config.

**Outside the phases, the model is yours.** Before the first command, in a
conversation of your own, and in the three phrase-triggered skills, the session
runs on what you chose: a new session takes its agent's model, then `model` in
your Open Code config, then the model you last picked in `/models`. Nothing is
written into the fork for it. A `model` the Claude Code version's `pdkit init`
wrote into the fork's `.claude/settings.local.json` is Claude Code's: Open Code
does not read it, and this version neither writes nor removes it.

**`/new` and `/clear` carry the model, not its variant.** The new session
starts on the current one's model; its variant comes again from what you last
picked for that model, or from your config, until the next command sets its
own.

## What the doctor shows

The `models` line of `pdkit doctor` asks the running Open Code about the
directory it runs in: the config documents it read, the agents as registered,
and the models it can use there. The line counts the thirty-five — fourteen
agents, twenty-one commands with a model — by where each model came from, says
how many are missing from the catalog, and names every key it dropped or that
does nothing; a table under it has a row each. For the map above, with a variant
DeepSeek does not have:

```
optional:
  ! models                 35 agents and commands: 31 by their frontmatter, 4 by options.models in ~/.config/opencode/opencode.json; 2 not in Open Code's catalog for ~/podman-desktop, as the table says — an agent on such a model fails when it is called, a command refuses to run; pd:package-map, pd:upstream-rules, pd:worktree-kit set no model and run on the session's
      pd-archaeologist        claude-agent/sonnet#high        frontmatter     in the catalog
      pd-auditor              claude-agent/opus#high          frontmatter     in the catalog
      …
      pd-implementer          deepseek/deepseek-flash#medium  options.models  deepseek/deepseek-flash has no variant medium, only none, low, high, max
      pd-plan-critic          openai/gpt-6.1-terra#high       options.models  in the catalog
      …
      pd:exec                 deepseek/deepseek-flash#medium  options.models  deepseek/deepseek-flash has no variant medium, only none, low, high, max
      …
```

| Column | What it says |
|---|---|
| model | the one an agent runs on, as Open Code reports it; for a command, the one it switches the session to |
| source | `frontmatter`, `options.models` or `agents.<id>.model`; `unknown` when something after the plugin changed an agent's model — an agent file `<id>.md` in an Open Code config directory, or another plugin — and the line names the model it expected; `not registered` for an agent Open Code does not list here |
| catalog | `in the catalog`, or why not: no such model for this directory, the model is disabled, or no such variant |

It warns on any model not in the catalog and on any finding: a dropped key, a
map entry that `agents.<id>.model` wins over, an agent on a model none of the
plugin's sources gave it. It reports a skip, with the reason, when it cannot
ask Open Code — the background service is not running, or the plugin is not
loaded for the directory, which the `plugin` line explains.

---

**The design** — [5 · Agents and model routing](../specification/05-agents.md), [workflows · Which session, which model](../workflows/reference/sessions.md#which-session-which-model)

← [The package map](04-package-map.md) · [Contents](README.md) · [MCP servers](06-mcp-servers.md) →
