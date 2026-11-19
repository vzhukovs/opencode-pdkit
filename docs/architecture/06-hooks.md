# Why hooks rather than instructions

[Architecture](README.md) › 6 of 7

Three things are enforced rather than requested, and each closes a failure that
was actually observed:

- **The push gate.** `git push` and `gh pr create` are denied without a
  short-lived token for that exact branch. A token knows what it is consent for: a
  `push` token is keyed by branch and issued only from `preflight-green`; a
  `reply` token is keyed by pull request, for writes that belong to no branch.
  Keys of different kinds cannot be found for one another, so consent to publish
  code is not consent to speak in a review — which it silently was before the
  kinds existed. Writes to the issue tracker are denied outright, from every
  state: no gate can be opened for them, because the routes that produce issue
  text all say a human posts it.
- **File ownership.** A worker writing outside its task's `Owns` set fails. This
  turns the ownership map from a request into an invariant and removes a class of
  merge conflicts rather than resolving them.
- **Receipts.** A task cannot be marked complete without captured command output,
  and after three failed captures it is blocked until somebody says in writing
  what changed.

One hook enforces nothing and is still not a convenience. **`session-start`**
gives a session a dozen lines on its first prompt, on a fork and after a
compaction: the issue, its state and route, the task running and the files it
owns, failed captures, the one command to run next, the phase's turn budget,
and recent journal entries. They are an entry of the session's instructions
rather than a message, so the model reads them on every request and a
compaction does not take them away. In a tree with no task running it reads
the issue off the `DESKTOP-<n>/…` branch, which is where every phase but exec
starts. That summary is what makes a session per phase cheap. Context is re-read
whole on every call, so a session costs roughly the square of its length — the
dearest one measured ran 676 calls to 878 k tokens of context, and linear growth
alone accounts for 90 % of its input. Splitting such a session into k sessions
divides its cost by about k, for the same work and the same prompts. A
restart is affordable only if it costs a summary rather than a re-explanation.
That is the same reason [the state lives on disk](01-constraint.md) in the first
place, and why `pdkit next <n>` exists for a session that opens anywhere else.

The gate reads the command rather than matching a substring on it. A hook stands
at a point of the host — before a tool runs — and is called for every call
there, whatever the command; under Claude Code its `matcher` saw the tool name
and nothing more. Either way the parsing happens in code: leading assignments,
`&&`, `||`, `;`, substitutions, subshells, a program named by path, a quoted
`argv[0]`, and wrapper programs. That last one is not about any particular
tool — the plugin is loaded from the global config into every session on the
machine, so a wrapper can appear in this project without this project being
told.

**How the hooks reach Open Code.** The rules know nothing of Open Code. They
live in `lib/hooks/` and run as they did under Claude Code: an event that
concerns a call starts `node <plugin>/bin/pdkit hook <event>` in a process of
its own, with the payload Claude Code would have sent on stdin and a deadline
of ten seconds. The events are one table, `lib/hooks/events.js` — the only list
of them, with the module each one runs; under Claude Code `hooks/hooks.json`
was a second list, and two lists is how a hook comes to be registered nowhere
and say nothing. Where each event stands in Open Code is the hook bridge's
table, `WIRING` in `opencode/bridge/hooks.js`, which names the points and keeps
no map of its own from an event to a module; a test holds the two tables to the
same events. The bridge registers one callback on each point, and it runs every
event that stands there:

| Point in Open Code | Events |
|---|---|
| before a tool runs | `pre-bash`, registered first, by the entry point; `pre-write` after it |
| after a tool ran | `post-write`, `post-bash`, `post-read`, `post-claim`: one addition to the result |
| a subagent about to go idle | `subagent-stop` |
| a prompt | `session-start` on a session's first; `prompt-submit` on one a `/pd:` command labeled |
| a fork; a compaction that ended | `session-start` |
| a compaction, before its summary is asked for | `pre-compact` |

The gate is the entry point's own because a hook that fails closed has to stand
where nothing can fail before it: the entry point registers it before it loads
anything else, so a bridge that fails to load refuses every command rather than
letting it through. The handlers did not change; what the bridge makes of their
answers is Open Code's way of saying the same thing. A refusal before a tool
refuses the call. Text after a tool becomes the last text part of its result,
the one thing of a call the model is handed. A refused subagent stop goes into
the subagent's session as a message, and it carries on. The summary becomes the
instruction entry above, and the context of `prompt-submit` an attached file,
`pdkit-context`.

**Where Open Code differs.** The rules are the same; where the hooks behave
otherwise than under Claude Code 0.15.0, it is because the host does, and each
difference was agreed before it was built:

- **No plugin in the session, no gate** — as under Claude Code with its hooks
  switched off, but narrowed: a bridge that fails to load refuses every
  command, and `pdkit doctor` checks that the plugin is loaded.
- **A command another plugin rewrites** after the gate let it through is not
  checked again.
- **More than the shell tool is read**: every call whose input has a string
  `command`.
- **No answer is a refusal** on `pre-bash`: no `node`, an exit other than 0 or
  2, a signal, a missing directory, nothing within ten seconds.
- **A patch is checked whole**, a deleted file and both ends of a move included.
- **What a post hook says is part of the result**, so a person may see it where
  Open Code shows a tool's output.
- **A page of a file the bridge cannot count gets no reminder** from
  `post-read`.
- **`session-start` does not run on a continued session**: Open Code says
  nothing when a session is continued, so the summary is not recomputed and
  the consent tokens are not revoked there — a token lives to its TTL. A
  cleared session is a new one.
- **The context of `prompt-submit` is an attachment**: the person sees a
  `pdkit-context` file under their message, not its text.
- **The receipt gate holds through an experimental hook, with the bridge's
  memory**: whether it held a subagent's last stop, and the ceiling of eight
  refusals in a row, are kept by the bridge, and a plugin reloaded mid-round
  forgets the first.
- **A schema file is recognized on Windows**, where 0.15.0 never matched one.

---

**In depth** — [`specification/`](../specification/README.md):

- [§6 — Hooks](../specification/06-hooks.md)
- [§6 — Two kinds of token](../specification/06-hooks.md#two-kinds-of-token)
- [§6 — Receipts, and why the ceiling holds](../specification/06-hooks.md#receipts-and-why-the-ceiling-holds)
- [§6 — Where Open Code differs, and what stands in](../specification/06-hooks.md#where-open-code-differs-and-what-stands-in)
- [§2 — Plugin structure](../specification/02-plugin-structure.md)

**In practice** — [`workflows/`](../workflows/README.md):

- [The push gate](../workflows/reference/push-gate.md)
- [The ownership hook](../workflows/reference/ownership.md)
- [Receipts](../workflows/reference/receipts.md)
- [One session per phase](../workflows/reference/sessions.md)

← [Validation](05-validation.md) · [Contents](README.md) · [Known weaknesses](07-known-weaknesses.md) →
