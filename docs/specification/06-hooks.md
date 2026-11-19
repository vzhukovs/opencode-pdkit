# 6. Hooks — where a prompt does not guarantee

[Specification](README.md) › Section 6

Instructions in skills are advisory. Hooks are deterministic.

**The constraint that shapes the whole construction.** A hook is tied to a
point in the host — at most to a tool — never to a command string. In Open Code
a plugin's hook is a callback at a point of the server — before a tool runs,
after it, on a prompt, when a session is about to go idle — and it is called
for every call at that point, whatever the tool and whatever the command. Under Claude Code the
`matcher` of `hooks.json` was compared only against the tool name, so
`Bash(git push*)` could not be written either. Either way the conditions on the
command string are applied by code in `lib/hooks/`, and the hook itself stays
thin.

The ten events are one table, `lib/hooks/events.js`, with the handler each one
runs. Where each stands in Open Code is the hook bridge's (`WIRING` in
`opencode/bridge/hooks.js`), and a test holds the two to the same events. On
every call the bridge first filters by tool, so a call no event looks at
starts nothing; then it builds the payload Claude Code would have sent for the
same moment, starts `node <plugin>/bin/pdkit hook <event>` with it on stdin,
with a deadline of ten seconds, and turns the answer into what Open Code does
with the call. The handlers were written against that payload and did not
change: what changed is the host, not the rules.

| Event | Where it stands in Open Code | What it looks at | Under Claude Code |
|---|---|---|---|
| `pre-bash` | `execute.before`, registered first, by the entry point | every call whose input has a string `command`: `shell`, and any other tool with such a field | `PreToolUse` on `Bash` |
| `pre-write` | `execute.before`, after the gate | `write`, `edit`, `patch`: one run per file the call would touch | `PreToolUse` on `Write\|Edit` |
| `post-write` | `execute.after` | the same tools, a call that completed: each file it left on disk | `PostToolUse` on `Write\|Edit` |
| `post-claim` | `execute.after` | the same, markdown files only, with the text the call wrote | `PostToolUse` on `Write\|Edit` |
| `post-bash` | `execute.after` | `shell`, a command that exited 0 | `PostToolUse` on `Bash` |
| `post-read` | `execute.after` | a `read` that returned a page of a file; a `grep` cut at its limit | `PostToolUse` on `Read\|Grep` |
| `subagent-stop` | the session hook `experimental.idle` | a child session about to go idle | `SubagentStop` |
| `session-start` | the session hooks `prompt` and `fork`, and the event `session.compaction.ended` | a session's first prompt, a fork, a compaction that ended | `SessionStart` |
| `pre-compact` | the session hook `compaction` | a compaction, before the summary is asked for | `PreCompact` |
| `prompt-submit` | the session hook `prompt`, beside `session-start` | a prompt a `/pd:` command labeled as its own | `UserPromptSubmit` |

What a handler's answer becomes is the bridge's to say (`opencode/bridge/answer.js`):

- **a refusal before a tool** — exit 2 from `pre-bash` or `pre-write` — refuses
  the call, and the model gets the handler's reason as the call's error;
- **text after a tool** — `additionalContext`, and the reason of a `post-write`
  exit 2 — becomes the last text part of the tool's result, which is the one
  thing of a call Open Code hands the model; the call stays a success;
- **a refusal of a subagent's stop** goes into the child session as a message,
  and the subagent carries on with it ([below](#receipts-and-why-the-ceiling-holds));
- **the session summary** becomes an instruction entry of the session, which
  the model reads as `<context key="opencode-pdkit">`;
- **the context of `prompt-submit`** is attached to the prompt as a text file,
  `pdkit-context`;
- what has no way to anyone here — a message meant only for the person, what a
  handler wrote to stderr while it allowed, a handler that could not run on an
  event that fails open — is one line in the Open Code server's stderr, where
  Claude Code put the same lines: its debug log.

The rules the handlers apply:

| Handler | Rule | Behavior |
|---|---|---|
| `pre-bash` | `git push`, `gh pr create` | deny without a valid **`push`** token for that branch; otherwise allow and spend the token. Allowed without a token where the command is proven to act outside podman-desktop (below) |
| `pre-bash` | `gh pr edit/review/merge/comment`, `gh api` with a mutation | deny without a valid **`reply`** token for that PR. Such writes belong to no branch, and the token is not spent: the unit of consent is the batch |
| `pre-bash` | `gh issue comment`, `gh issue create/edit/close` | **deny always.** No state authorizes a write to the tracker, and the one route that produces issue text says a human posts it. A gate that cannot open is worse than a refusal that says what to do |
| `pre-bash` | `git push --force` without `--force-with-lease` | deny always |
| `pre-bash` | `git add -A`, `git add .` | deny always, with a hint to list paths |
| `pre-bash` | `git rebase -i` | deny, hint `git reset --soft <base>` — husky's `commit-msg` appends `Signed-off-by` and then rejects the duplicate it created |
| `pre-bash` | `git commit --no-verify` | deny |
| `pre-write` | a path outside the active task's `Owns` | deny |
| `pre-write` | the active task's `Owns` is recorded and **empty** | deny every path: the plan made it a verification, and a verification writes nothing. Empty is not missing |
| `pre-write` | no `Owns` recorded for the active task | allow with a message naming `pdkit task sync` — nobody has synced the plan, so nothing is known rather than nothing is owned |
| `pre-write` | no active task in this working tree | allow — the restriction belongs to executing a planned task, not to having the plugin installed |
| `post-write` | a new file without the SPDX header | exit 2 with the text to paste |
| `post-write` | `*.ts` under schemas | remind about `generate:schemas`, mark `schemas_dirty` |
| `post-bash` | a command with a window (`grep -A/-B/-C`, `sed -n a,bp`, `awk` on `NR`, `head`/`tail` reading a file, itself or piped from `cat`, `bat`, `nl` or `git show`) whose output ends with more `{` opened than closed | add the context: the block was cut, what lies past the window is unread rather than absent, and the rule in `knowledge/pitfalls.md`. Never blocks. Runs in every repository: the rule is true anywhere, and the reads it exists for include a clone of a reference project. A message after a tool reaches the model only as part of the tool's result: `pdkit hook` sends it as `additionalContext`, and the bridge adds it to the result as its last text part |
| `post-read` | a `read` that returned a page of a file — it started past the first line, or lines follow it — or a `grep` whose matches were cut at its limit (`grep limit N`), whose output ends with more `{` opened than closed | the same context as `post-bash`, from the same module (`cut.js`), so the two cannot word the rule differently. Exists because files are read with the `read` and `grep` tools as much as with the shell, and a plain `read` of a file over 50 KB returns a page of at most 2000 lines. A page says where it starts and whether lines follow, not how many the file has; for one with lines after it the bridge counts the file on disk, as the tool counts it, and a file it cannot count gets no reminder. `grep` has no context lines (`-A`/`-B`/`-C`): context read through the shell is `post-bash`'s. Never blocks; runs in every repository |
| `post-claim` | a markdown write that says a backticked name is missing, asks whether a name is needed or should be added (any name: the question's premise is the absence), or proposes adding a dotted name (a member of something that exists), and the name matches nothing in podman-desktop outside that document | add the context: a name with no match is not yet evidence the concept is absent; translate a name borrowed from another project, search the concept, and write the search next to the claim as `searched: …`, per `knowledge/pitfalls.md`. A line that already cites its search, a query and an empty result (`searched: <query> -> 0`), is skipped; `searched: yes` is not a search. The wording of absence is read from `lib/absence.js`, which `plan check` uses too. Never blocks, never calls the claim false: a genuinely new name matches nothing too. All names in one `git grep`, with no cap on how many |
| `subagent-stop` | any agent other than `pd-implementer` finishing | allow, after counting it. Only the implementer's finish claims the active task; the implementer is known by the ID it is registered under (`pd:pd-implementer`, Claude Code's name for it, is read too), and a payload with no `agent_type` is treated as the implementer |
| `subagent-stop` | no `receipts/<TASK_ID>.md`, or it fails `validateReceipt` | exit 2 with the exact command to run |
| `subagent-stop` | a real receipt with `exitCode ≠ 0` | exit 2: the `Done when` command did not pass |
| `subagent-stop` | the same run has stopped `STALL_LIMIT` (3) times with no capture of the task between, e.g. `pdkit receipt write` cannot run because `Done when` is prose | the third refusal adds that the next stop is let go; the fourth stop is allowed with rule `stalled`. Nothing writes `task-receipt … accepted`, so the task stays unproven and the audit reports it. Without this, a failure that records no attempt would hold the agent forever |
| `subagent-stop` | this is the `exec.max_attempts`-th failure in a row | exit 2, with a **different** message: the task is blocked, and the question is not "fix it and capture again" but "what changed between the second attempt and the third". A refusal keeps the subagent running, so at its next stop, which the hook is told was held (`stop_hook_active`), it is let go with the same message rather than held for a fourth try |
| `session-start` | — | inject the summary: active issue, state, next step. This is re-anchoring. Runs on a session's first prompt, on a fork and after a compaction, and revokes the consent tokens on each; a session continued as it was gets neither (below) |
| `pre-compact` | — | flush the active state to the journal so compaction does not eat the task context. Open Code waits on this hook before it asks for the summary, so the entry is in the journal before `session-start` reads it after the compaction |
| `prompt-submit` | `/pd:<skill> <n>` whose argument-hint is an issue or a registered pull request, and the tree is another issue's while the issue's work is in a named worktree or branch | add the context: this tree, where the issue's work is, and that the number is not a typo. Never blocks — a block on this event would lose the prompt — and writes nothing. The hook does not see what the person typed: a `/pd:` command labels the prompt it sends with its name and arguments, and the bridge puts `/pd:<skill> <arguments>` back together from the label. A prompt with no label starts no process at all, because the hook runs on every message |

**Command recognition is not substring search.** `lib/hooks/command-parse.js`
strips leading assignments, splits on `&&`, `||`, `;`, `$()` and backticks, sees
into subshells and brace groups, resolves a program named by path, unquotes
argv[0], and strips **wrapper programs**. That last one is not about any
particular tool: the gate is global — the plugin is loaded from the global
config into every session on the machine — so a wrapper can appear in
this project without this project being told, and the question is never "did
somebody mean to wrap it" but "what is going to run".

It also moves **options written before the subcommand** — git's `-C`, `-c`,
`--git-dir`, `--work-tree`, gh's `-R` — out of the arguments and into a list of
their own. Every rule matches on an argument prefix, and until that was done
`git -C <dir> push` had `-C` where the prefix expects `push` and matched no rule
at all. The list is kept, not dropped, because it says where the command acts.

A **deny anywhere in the line refuses the line**, before any token is asked
about. A token for the push in `git push && gh issue comment …` is not consent
for the comment.

## The gate guards podman-desktop, and stands aside only where that is proven

The gate is global, so the token rules above used to apply in
every repository on the machine — this plugin's own checkout included, where
the only way to push was a `/pd:pr` flow built for somebody else's project.
`lib/hooks/scope.js` now lets a command any rule matched — a gated one (`push`
or `reply` kind) or a denied one — run **only when it is proven to act outside
podman-desktop**:

- the working tree has no remote whose slug is `repo.upstream` or `repo.fork`,
  or whose repository name is `podman-desktop` — the last one is what keeps a
  fork clone gated before `pdkit init` has filled `repo.fork`;
- the line names neither slug nor the name as a whole word (`podman-desktop.git`
  matches, `podman-desktop-kit` does not), so a URL or `gh -R` pointing there is
  gated;
- nothing in it moves where the command runs: no `cd`, `pushd` or `popd`, no
  `git -C`, `--git-dir` or `--work-tree`, no `GIT_DIR`, `GIT_WORK_TREE` or
  `GH_REPO` in the line or in the hook's environment;
- the configuration loaded and the working tree is a repository.

The burden of proof is on "outside" on purpose. A wrong "inside" is one refusal
in a repository that did not need guarding; a wrong "outside" is an ungated push
to upstream. So every failure — a config that does not load, a directory that
is not a repository, a `git` that cannot be run — is "inside", and the gate
decides as before. Deny rules follow the same scope. Force push, `--no-verify`,
`add -A`, `rebase -i` and tracker writes are podman-desktop's house rules — its
Husky hooks, its review habits, a tracker no state may write to — and held
everywhere they refused ordinary git work in a person's own projects. Inside
podman-desktop, or wherever outside is not proven, they are refused as before,
before any token is looked at. Each command
the gate stands aside for is written to the journal as `allowed-outside`, so
standing aside does not leave the same trace as never running.
`pdkit doctor --gate-selftest` probes both sides, in throwaway repositories, so
it does not depend on where it is run from. It runs each probe the way the
bridge runs the hook — through the same `invoke()` of `lib/hooks/runner.js`:
`node` from the PATH of the environment it was given (a session's shell hands
it the server's), `<plugin>/bin/pdkit hook pre-bash`, the deadline, and the
fail-closed policy — and counts a probe by what decided it. A forbidden command
passes only when the handler refused it: refused for want of an answer is the
policy standing in for a hook that did not run, and fails the check. An
ordinary command passes only when it was let through.

Two consequences of the rules living in code rather than in JSON: they are
versioned with the plugin, and they are unit-tested. For a circuit where a
mistake costs public noise in somebody else's repository, that is not a luxury.

## Two kinds of token

Until stage 4 every outward write was tied to a branch, and `gate.open` required
a branch name parsed as `DESKTOP-<n>/…`. A reply to a review thread and a
`resolve` are also writes into somebody else's repository, but they have no
branch at all, and at that moment the issue sits in `review-in-progress` rather
than `preflight-green`. No token of that shape could be issued.

Hence `--kind push` (per branch, only from `preflight-green`) and `--kind reply`
(per PR, from `pr-open` and `review-in-progress`). The eligible states live in
code (`state.GATE_ELIGIBLE`, a map by kind), not in the config: the only thing a
config key could do is widen the list, and a widened push list is a token issued
before preflight.

**This also closed a hole nobody had seen.** For commands with no branch of their
own, `dispatch.js` fell back to the current branch. So the token issued to push
slice #1 also authorized a review reply, a comment in somebody else's tracker,
and any `gh api` mutation: one confirmation, given for publishing code, working
for writes nobody was asked about. Token kinds remove that not by adding a check
but by making keys of different kinds unfindable for one another.

A hand-written `gh api graphql` mutation is a separate case: the PR number is
nowhere in it, so there is nothing to check a token against. Such a command is
refused with a hint to use `pdkit pr reply --pr <n>` rather than matched against
whatever token happens to be lying around.

## One consent, two writes

Publishing a branch takes two commands — `git push`, then `gh pr create` — and
the push spent the token the pull request then needed. `/pd:pr` has documented
that exact pair since it was written, so **the documented sequence could not
work**, and it was found by running it: on DESKTOP-18832 the refusal arrived
after the push, leaving the one state worse than either outcome — a public branch
with no pull request to explain it.

Issuing a second token was the other repair and it is the wrong one. What a human
reads at `gate open` is the body and the branch, together; asking again splits one
reading into two confirmations, which is the fatigue [section 4](04-contracts/README.md) says a gate cannot
afford — and the second confirmation would come after the irreversible half.

So a push token carries two **uses**, `push` and `pr`, spent separately. One
token, one push is untouched: a token that has pushed cannot push again, only do
the other thing it was granted for. The order is fixed and not symmetric —
opening the pull request spends the token whole, so a push may precede it and
never follow it. A token that had opened a pull request and kept its push would
put new commits on a branch already under review, with nobody confirming them in
the moment.

Reply tokens are unchanged: no uses, spent by the TTL rather than on first write,
because what they authorize is the batch of drafts somebody read in one go.

## Receipts, and why the ceiling holds

The two `subagent-stop` rows rest not on the strictness of the validator but on
**who produces the receipt**. `pdkit` does: `pdkit receipt write --issue <n>
--task T1` reads the command out of the task's `## Done when`, runs it through
`lib/evidence.js` (by spawning it directly, so nothing can sit between the
command and its output), and records what it printed. There is no parameter
through which an agent could hand over text — the "summarize the run
convincingly" path is closed by the absence of an input, not by a check. The
validator catches the remainder: a file edited by hand (the digest over the
`## Output` block stops matching) and a truncated capture (`complete: false`).

**The attempt ceiling holds by the same device.** What increments the count is a
capture with a non-zero exit — the same input that decides everything else about
completion. There is no input through which an agent could declare "this was the
first attempt". Two things reset it, and both mean somebody went through the
task: a green capture, and an explicit unblock with a reason. The config
(`exec.max_attempts`) can only weaken it — zero switches blocking off entirely —
and that is deliberate: somebody who decides a fourth attempt is sensible says so
once, rather than learning to scroll past a message.

The separation of duties is strict: `validateReceipt` answers only "is this a
real capture", not "did the run succeed". A red `pnpm test:main` produces a
**valid** receipt — it is the proof that matters most — and the hook decides "the
task is not done" by reading `exitCode`. A validator that rejected evidence for
proving a failure would return us to receipts it is profitable not to attach.

**How a stop is held in Open Code.** Claude Code had an event for a subagent
finishing, and a hook that exited 2 on it kept the subagent running with the
reason as its next instruction. Open Code 2.3.0 has no stable counterpart. What
it has is `experimental.idle`, a session hook it calls when a session has
finished its model work and has nothing waiting — for a subagent, before its
report reaches the caller — and a session that has a message waiting after the
hook goes on instead of stopping. So the bridge stands there: for a child
session (one with a parent; a session a person drives starts no process) it
builds the payload — `agent_id` the child's session ID, `agent_type` the agent
it runs, `session_id` the session at the top of its chain of parents, `cwd`
its directory — and runs `subagent-stop`. A refusal becomes a `synthetic`
message in the child, the reason as its text and the plugin as its source, and
the subagent carries on in the same run; the caller gets one report, after it
is let go. Anything else lets it go.

Two things Claude Code gave the handler, the bridge has to keep itself. Whether
it held this subagent's last stop (`stop_hook_active`) is the bridge's memory,
per loaded instance of the plugin: set after a hold, cleared when the subagent
is let go or its run fails or is interrupted. And the ceiling: Claude Code let a
subagent go after 8 refusals in a row whatever the hook said, and Open Code
leaves bounding the loop to the plugin, so the bridge lets the ninth stop in a
row go with a line in the log. Without it, `exec.max_attempts: 0` would hold an
implementer whose capture stays red for ever.

Both carry a cost the [deviations below](#where-open-code-differs-and-what-stands-in) name. The memory is lost when the plugin
reloads mid-round — an update, `opencode reload`, an edit of a loaded checkout —
and the next stop reads as the first: on the attempt ceiling that is one more
hold, saying the task is blocked, and the stop after it is let go. The error
is on the side of holding, which is the gate's default. And the hook is
experimental by name: a later Open Code that renames it would switch the gate
and the `agent-done` count off without a word from the host. What stands guard
is the minimum version the plugin loads on, the CI job `receipt-gate`, which —
where the repository has a provider key — runs a real implementer without a
receipt on a real model, on the minimum and the latest Open Code, and checks
that it was held; and `pdkit doctor`, which fails `hooks:agent-done` when
a subagent of the plugin stopped and wrote no entry
([section 2.3](02-plugin-structure.md#23-the-journal)).

## Where Open Code differs, and what stands in

The rules above are the same rules. What follows is every place where the hooks
behave otherwise than under Claude Code 0.15.0, because the host does — each
agreed before it was built, and each with what stands in.

- **No plugin in the session, no gate.** Open Code starts a session without a
  plugin that is switched off in a config, has not finished installing, or
  threw while loading; there is no "required plugin". Claude Code had the same
  boundary — hooks switched off, no `node`, a `lib/cli.js` that did not load —
  and here it is narrowed: the entry point registers the gate before it loads
  anything else, so a bridge that fails to load refuses every command rather
  than letting it through, and `pdkit doctor` checks that the plugin is
  loaded, which events it registered, and that the server finds `node`.
- **A command another plugin rewrites.** A plugin loaded after this one can
  change a command the gate let through. The gate guards against the model, not
  against code in the server, and nothing checks the command again.
- **More than the shell tool is read.** The gate reads every call whose input
  has a string `command`, so a command sent through an MCP tool or another
  plugin's is held to the same rules; Claude Code's matcher saw only its Bash.
- **No answer is a refusal.** On `pre-bash`, a hook that gave no decision — no
  `node`, an exit other than 0 or 2, a signal, a missing directory, no answer
  within ten seconds — refuses the command, with the reason. Under Claude Code
  any exit but 2 let it through.
- **A patch is checked whole.** `pre-write` on `patch` checks every file the
  patch touches, a deleted file and both ends of a move included; one outside
  `Owns` refuses the call. Claude Code's `Write` and `Edit` could not delete or
  move.
- **What a post hook says is part of the result.** The model gets it as the last
  text part of the tool's result, not as a block of its own, and a person may
  see it where Open Code shows a tool's output: after `write` in
  `opencode run`, or a `shell` result opened in the TUI. Under Claude Code it
  never showed.
- **A page of a file the bridge cannot count gets no reminder.** Above, under
  `post-read`.
- **`session-start` does not run on a continued session.** Open Code says
  nothing when a session is continued (`--continue`, `--session`, a session
  reopened in the TUI), so the summary is not recomputed and the consent tokens
  are not revoked there; a token lives to its TTL. The summary is an entry of
  the session's instructions, not a message: the model sees it on every
  request, it survives a compaction, and a new one arrives as an update that
  supersedes it; an empty one withdraws it. A cleared session is a new one.
- **The context of `prompt-submit` is an attachment.** The person sees a
  `pdkit-context` file under their message, not its text; the model reads it
  after their text, introduced as added by pdkit and not by the person.
  Claude Code showed the person nothing.
- **The receipt gate holds through an experimental hook, with the bridge's
  memory.** Above, under the receipts.
- **A schema file is recognized on Windows.** `post-write` reads a path with
  `\` as it reads one with `/`, so a file under `schemas/` gets its reminder on
  Windows too; 0.15.0 never matched there.

Grep's context lines are not on the list: Open Code's `grep` has none, so that
read cannot happen, and context read through the shell is `post-bash`'s.

---

**In brief** — [`architecture/`](../architecture/README.md): [6 · Hooks](../architecture/06-hooks.md)

**In practice** — [`workflows/`](../workflows/README.md):

- [The push gate](../workflows/reference/push-gate.md)
- [The ownership hook](../workflows/reference/ownership.md)
- [Receipts](../workflows/reference/receipts.md)
- [§15 — A task that has failed three times](../workflows/15-task-failed-three-times.md)

← [5 · Agents and model routing](05-agents.md) · [Contents](README.md) · [7 · Preflight](07-preflight.md) →
