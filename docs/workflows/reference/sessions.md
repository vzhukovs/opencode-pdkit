# One session per phase

[Workflows](../README.md) › [Reference](README.md)

The cycle is walked in several sessions, not one: a new session for each phase,
one per slice through preflight and pr, and one per review round. Every
orchestrating skill ends its `## Next` by saying so.

The reason is arithmetic. Context is re-read whole on every call, so a session
that grows steadily to C tokens over N calls reads about N·C/2 in total — its
cost grows as the square of its length. The dearest session measured (issue
18967, 26 August to 16 October) made 676 calls and grew to 878 k tokens of
context without one compaction. N·C/2 predicts 297 M input tokens against 331 M
observed, and 82 % of the issue's cost was cache reads — re-reading what had
already accumulated. The same work in eight sessions of about 85 calls is about
41 M. `pr` and `pr-sync`, at the end of such sessions, were a third to over half
of each cycle. `pdkit cost --issue <n>` repeats the measurement for any issue.

Nothing is lost at the boundary that the next phase reads. `issue.md`,
`research.md`, `plan.md`, `tasks/`, `receipts/`, `validation.md`, `audit.md` and
`slices.json` are on disk, under `$PDKIT_HOME`, which is why state lives there.
What does not survive is the informal part of a conversation — and for that,
triage takes whatever follows the first line of the command into
`## Prior context`, verbatim.

What makes a restart cheap rather than merely possible:

```
pdkit next 12345              # one line: the command to run now
```

and the summary the `session-start` hook gives a new session with its first
prompt in the issue's worktree — the issue, state, route, the running task and
its files if there is one, failed captures, the command to run, the phase's
turn budget and the last few journal entries. It goes into the session's
instructions, which the model reads with every request:

```
pdkit: issue 12345 — plan-approved, standard
  task    : none running
  next    : implemented
  run     : /pd:exec 12345
  budget  : about 80 turns per task, then a fresh session — a guide, nothing counts them
  recent  :
    …
```

**The budget is a guide and cannot be a limit.** `budget.turns.*` in the config
holds a soft ceiling per phase, in turns. No command can see how many turns a
session has taken, and the model cannot count its own precisely, so nothing
refuses anything at the ceiling. It is the number a skill names when it suggests
stopping — and stopping means writing what is settled to disk and asking for a
restart, not finishing the phase in a context that is already the expensive part.

Compaction is not the same thing. A compacted session keeps a summary of
everything before it and costs a call to produce; a new one keeps only what the
files and the summary above hold, which is what the next phase was designed to
work from.

## Which session, which model

### The command sets the model

Each command switches the session to its own model before its instructions
reach the model, and the session stays on it for the phase — every later
message, until you pick another in `/models` or run the next command. There is
no `/model` to type before a command, and nothing reminds you of one. With the
defaults, one cycle runs like this:

```
cd <fork> && opencode          ──► the model you chose, until the first command

/pd:triage                                 sol#high
/pd:plan                                   astra#high
/pd:plan-review                            opus#high
/pd:exec                                   sonnet#high
/pd:validate                               terra#medium
/pd:audit, /pd:slice                       opus#high
/pd:preflight                              flash#low
/pd:pr                                     sonnet#medium
/pd:pr-sync                                opus#high, every review round
```

with `/pd:review-pr` on `opus#high` and `/pd:knowledge` on `opus#medium`. Here
and in every table of these pages the defaults the commands and agents name in
their frontmatter are written short: `opus` and `sonnet` are
`claude-agent/opus` and `claude-agent/sonnet`; `astra`, `sol` and `terra`,
`openai/gpt-6-astra`, `openai/gpt-6.1-sol` and `openai/gpt-6.1-terra`; `flash`,
`deepseek/deepseek-flash`. They use three providers, and all three have to be
connected for a cycle to run as shipped
([One provider only](../../configuration/05-models.md#one-provider-only)). A
model you map to
a command in the plugin's `options.models` takes the default's place, and the
command switches the session to yours. A model Open Code cannot use is refused,
not replaced: the command does not start, and says which model it was and where
it came from. Where a model comes from, the map, the variants, and what
`/models`, `/new` and `/clear` do to the model of a phase:
[5 · Model selection](../../configuration/05-models.md#how-long-a-commands-model-holds).

Outside the commands — before the first one, in a conversation of your own, and
in `package-map`, `upstream-rules` and `worktree-kit`, which name no model — the
session runs on the model you chose.

`pdkit next <n>` prints the command alone. It does not name `/pd:pr-sync`: from
`pr-open` it points at `/pd:pr-status`, and going to a review round is your
call.

**The effort** is the variant, part of the same default — `#high`, `#medium`,
`#low`, `#none` — and the command sets it with the model. `/effort`, Open
Code's `/variants`, changes the session's, never a subagent's. The verdict of
`/pd:audit` is `pd-auditor`'s, on `sol#high`, and the four review axes', each
in its own context: the session reads neither the diff nor the code, and a fix
is `pd-implementer`'s.

### The columns

Every **Sessions and models** table in these pages uses the same four columns.

**Session.** **new** means a fresh session for this step: `/new` or `/clear`
in the TUI, or quit Open Code and start `opencode` again — the `session-start`
hook gives a new session the summary above with its first prompt. A session you
reopen, from `/sessions` or with `--continue`, is not a new one and gets no new
summary ([6 · Where Open Code differs](../../specification/06-hooks.md#where-open-code-differs-and-what-stands-in)).
Where it is opened is the second half:

| Where | What it is |
|---|---|
| **main checkout** | the podman-desktop fork itself, standing on the base branch. `opencode` is started here, and triage, planning and reviews of other people's work run here: nothing in them writes code |
| **issue tree** | `DESKTOP-<n>`, beside the fork, made by `/pd:exec` or `pdkit worktree create`. Every phase from validation on runs here. You do not `cd` into it: on `/pd:<skill> <n>` the `prompt-submit` hook has the model move the session there with Open Code's `session_move`, and a session started here gets the summary of the issue |
| **terminal** | a plain `pdkit` command: no model is involved. `!pdkit …` in whichever Open Code session is open, where the plugin puts `pdkit` on PATH, or a shell of your own with `bin/pdkit` of a clone at the plugin's version ([README · Commands](../../../README.md#commands)) |

One session works one issue. To change issue, quit and start `opencode` in the
fork again; the hook moves the new session into the other tree. How the move
works, and what to do when it does not happen:
[Where a session works](trees.md).

**Default model.** The model the command switches the session to, as its
frontmatter names it: `opus#high` is `claude-agent/opus#high`. A command your
`options.models` maps runs on yours instead. A dash means the step involves no
model.

**Subagents.** Each runs on its own model, variant included — its frontmatter's,
or the one your map or Open Code's `agents.<id>.model` gives it — and never on
the session's: `pd-auditor` is `sol#high` under an `opus#high` `/pd:audit`,
and `pd-review-synth` is `opus#medium` under an `opus#high` `/pd:review-pr`.

### Every command

From the `model:` frontmatter of `skills/*/SKILL.md` and `agents/*.md`, where
the defaults are set. What each one runs on with your map applied is the
`models` line of `pdkit doctor`
([What the doctor shows](../../configuration/05-models.md#what-the-doctor-shows)).
The turn budget is `budget.turns.*` in the config: a guide for when to stop and
restart, not a limit.

| Command | Session | Default model | Subagents | Budget, turns |
|---|---|---|---|---|
| `/pd:doctor` | new · anywhere in the fork | `flash#low` | — | — |
| `/pd:sync` | new · main checkout | `flash#low` | — | — |
| `/pd:editor`, `/pd:open` | anywhere | `flash#none` | — | — |
| `/pd:triage` | new · main checkout | `sol#high` | `pd-scout` · `sonnet#high`, `pd-archaeologist` · `sol#high` on `redo` | 40 |
| `/pd:plan` | new · main checkout | `astra#high` | `pd-scout` · `sonnet#high` | 60 |
| `/pd:plan-review` | new · main checkout | `opus#high` | `pd-plan-critic` · `opus#high` | — |
| `/pd:exec` | new · main checkout or the issue tree; it moves itself into the tree | `sonnet#high` | `pd-implementer` · `sonnet#high`, one per task | 80 per task |
| `/pd:quickfix` | new · the checkout that will carry the branch | `sonnet#high` | — | — |
| `/pd:validate` | new · issue tree | `terra#medium` | `pd-validator` · `terra#medium` | 80 |
| `/pd:audit` | new · issue tree | `opus#high` | `pd-auditor` · `sol#high`; the four `pd-review-*` · `sol#high` for architecture and tests, `opus#high` for api-compat, `sonnet#high` for product, `pd-review-synth` · `opus#medium`; `pd-implementer` · `sonnet#high` for a fix | 40 |
| `/pd:slice` | new · issue tree | `opus#high` | `pd-slicer` · `opus#high` | 60 |
| `/pd:preflight` | new · issue tree | `flash#low` | — | — |
| `/pd:pr` | new · issue tree, one per slice | `sonnet#medium` | the four `pd-review-*` and `pd-review-synth`, for the self-review; `pd-implementer` · `sonnet#high` for a fix | 50 |
| `/pd:pr-status` | new · anywhere in the fork | `flash#low` | — | — |
| `/pd:pr-sync` | new · issue tree, one per review round | `opus#high` | `pd-thread-resolver` · `sonnet#high`; `pd-implementer` · `sonnet#high` for our own findings; first round of an adopted issue: the four `pd-review-*` · `sol#high` for architecture and tests, `opus#high` for api-compat, `sonnet#high` for product, `pd-review-synth` · `opus#medium` | 60 |
| `/pd:resume` | new · issue tree | `opus#high` | `pd-conflict-analyst` · `opus#high` | — |
| `/pd:close` | new · issue tree; it leaves the tree before removing it | `flash#low` | — | — |
| `/pd:reset` | new · main checkout | `flash#low` | — | — |
| `/pd:review-pr` | new · main checkout, one per pull request | `opus#high` | the four `pd-review-*` · `sol#high` for architecture and tests, `opus#high` for api-compat, `sonnet#high` for product, `pd-review-synth` · `opus#medium` | — |
| `/pd:knowledge` | new · anywhere in the fork | `opus#medium` | — | — |
| `/pd:package-map`, `/pd:upstream-rules`, `/pd:worktree-kit` | anywhere | none: the session's | — | — |

### Where the decisions are taken

The [decision points](decision-points.md) are not phases and get no session of
their own. Each is taken at the end of the session that produced what is being
decided, or in a terminal afterwards — the artefact waits on disk either way:

| Decision | Taken in |
|---|---|
| plan approval | the `/pd:plan-review` session, or a terminal: `pdkit ids freeze`, `pdkit state --to plan-approved` |
| slice graph approval | the `/pd:slice` session, or a terminal: `pdkit state --to slices-approved` |
| push confirmation | the `/pd:pr` or `/pd:pr-sync` session, in the turn that shows the push |
| plan amendments from review | the `/pd:pr-sync` session that raised them |
| additions to `knowledge/` | the `/pd:close` or `/pd:knowledge` session that proposed them |

---

**The design** — [5 · Agents and model routing](../../specification/05-agents.md), [3 · Commands](../../specification/03-commands.md), [architecture · Hooks](../../architecture/06-hooks.md)

← [Calibrating the thresholds](thresholds.md) · [Reference](README.md) · [Measuring what a cycle costs](cost.md) →
