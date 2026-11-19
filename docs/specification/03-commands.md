# 3. Commands

[Specification](README.md) › Section 3

Every orchestrating skill is `disable-model-invocation: true`. Nothing starts on
its own.

Open Code reads no skills from a plugin's directory, so the plugin registers
them itself (`opencode/commands.js`): every `skills/<name>/SKILL.md` becomes the
command `/pd:<name>`, and only a skill without `disable-model-invocation`
becomes a skill too — one the model can load by its description. The key keeps
its meaning by deciding what is registered: an orchestrating skill exists only
as a command a person types, and the model is never offered it.

| Command | In | Out | State | Model | Gate |
|---|---|---|---|---|---|
| `/pd:doctor` | — | environment report | — | sonnet#medium | — |
| `/pd:sync` | — | fork and worktree status | — | sonnet#medium | — |
| `/pd:editor [<issue>]` | issue, or the current branch's | the issue's worktree opened in `editor.path` | — | haiku#low | — |
| `/pd:open home\|issue\|tree [<issue>]` | target, issue | `$PDKIT_HOME`, `issues/<n>` or the worktree opened in the file manager | — | haiku#low | — |
| `/pd:triage [<issue>]` | number/URL on the first line, any further lines as prior context; or nothing | with a number: `issue.md` including what came with the command, draft R-set, route. Without: a backlog shortlist, and nothing is written | `triaged` / — | opus#high | — |
| `/pd:plan <issue>` | issue | `research.md`, `plan.md`, open questions | `planned` | opus#high + sonnet scouts | human: approval |
| `/pd:plan-review <issue>` | issue | `plan-review.md` | — | opus#high, fresh | — |
| `/pd:exec <issue> [T*]` | issue/task | code, commits, `receipts/*` | `implemented` | sonnet#medium + sonnet workers | — |
| `/pd:validate <issue>` | issue | `validation.md` + artefacts | `validated` | sonnet#medium | — |
| `/pd:audit <issue>` | issue | `audit.md` | `audited` | sonnet#high + opus auditor, fresh | — |
| `/pd:slice <issue>` | issue | `slices.md` — the PR graph | `sliced` | sonnet#medium + sonnet slicer, fresh | human: approval |
| `/pd:preflight <issue\|slice>` | issue/slice | pass/fail + output | `preflight-green` | sonnet#medium | — |
| `/pd:pr <issue> [slice]` | issue | branches, PR bodies, open PRs | `pr-open` | sonnet#medium | **push gate** |
| `/pd:pr-status` | — | dashboard across open PRs | — | sonnet#medium | — |
| `/pd:pr-sync <pr#>` | PR | decision table → plan amendment → fixes → `pr diff` → replies | — | opus#high + sonnet resolvers | human: the decisions, the amendment; **push gate** after the diff; replies |
| `/pd:resume <issue>` | issue | drift analysis, rebase, amendment | — | sonnet#medium + opus conflict analyst | — |
| `/pd:review-pr <pr#>` | PR | `reviews/<pr>.md` | — | opus#medium + 4 sonnet axes | — |
| `/pd:quickfix <issue>` | issue | fix + PR | `pr-open` | sonnet#medium | **push gate** |
| `/pd:close <issue>` | issue | knowledge harvest, worktree cleanup | `merged` | sonnet#medium | — |
| `/pd:reset <issue>` | issue | what would go and what would stay; with `--confirm`, one issue forgotten | record removed, so `new` | sonnet#medium | human: `--confirm` |
| `/pd:knowledge` | — | revision of `knowledge/` | — | opus#medium | — |

The Model column is the command's default — `model:` in its `SKILL.md`, every one
`claude-agent/…`, with the effort as the variant after `#` — and the class of the
agents it calls, whose own defaults are in [section 5](05-agents.md). A command
checks its model against the ones Open Code can use and switches the session to
it for the phase; `options.models` in the plugin's entry overrides it.

## Phrase-triggered skills

Three skills carry no slash discipline and fire by meaning:

- `package-map` — "which package owns X", "which layer is responsible for Y"
- `upstream-rules` — fires when a commit or a new file enters the context;
  reminds about SPDX, scope, and squashing with `git reset --soft`
- `worktree-kit` — create / list / switch / clean up, copying `.env`, sharing the
  pnpm store

They live in the same directories as the orchestrating skills, so they are
registered as commands too and can be invoked explicitly (`/pd:package-map`),
with the same body and arguments; they name no model, so the command runs on the
session's. The only difference is frontmatter: they carry no
`disable-model-invocation`, so the plugin registers them as skills as well,
under the IDs `pd:package-map`, `pd:upstream-rules` and `pd:worktree-kit`, with
the description and the `when_to_use` lines joined into the one line the model
picks a skill by. A skill of the same ID in a person's or a project's skills
directory would replace the plugin's without a word, and `pdkit doctor` looks
for that.

---

← [2 · Plugin structure](02-plugin-structure.md) · [Contents](README.md) · [4 · Contracts of the key commands](04-contracts/README.md) →
