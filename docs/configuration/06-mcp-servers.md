# MCP servers

[Configuration](README.md) › 6 of 8

The plugin declares **no** MCP server, and that is the point: a server a plugin
declares loads for everyone who installs it, which would make optional servers
mandatory. Configure them yourself.

| Server | Used by | Absent |
|---|---|---|
| Playwright | `/pd:validate` | a human checklist instead of evidence, and no PASS is recorded |
| context7 | questions about someone else's library, in planning and in review | the answer comes from the model's own knowledge of that library's versions, which goes out of date without saying so |

A server belongs to the session, not to an agent. Which of the plugin's agents
see its tools is decided by `tools:` in `agents/*.md`: the plugin turns each
list into the agent's permissions, and an agent sees no tool it was not given.
Open Code names a server's tools `<server>_<tool>` —
`playwright_browser_navigate` — and of the plugin's agents only `pd-validator`
is given Playwright's, the six it drives the application with. Your own session
sees every server you connect, as any session in Open Code does.

## Playwright: the one command to run by hand

The plugin cannot do this for you — it declares no server, deliberately,
because a server a plugin declares loads for everyone. Run it once per machine:

```bash
opencode mcp add playwright --global -- \
  npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:9222
```

It needs no Open Code running: it edits your global config,
`~/.config/opencode/opencode.json`, and a running server picks the change up on
its own. What it writes, should you rather write it yourself:

```json
{
  "mcp": {
    "servers": {
      "playwright": {
        "type": "local",
        "command": ["npx", "@playwright/mcp@latest", "--cdp-endpoint", "http://127.0.0.1:9222"]
      }
    }
  }
}
```

**`--global` is the part worth getting right.** Without it `opencode mcp add`
writes the `opencode.json` of the directory you ran it in. Every issue worktree
is a directory of its own, beside the fork rather than inside it, so a server
added in the fork is invisible from the session that needs it, while the fork
itself sees it perfectly — and the file it wrote sits in the fork, where git
does not ignore it.

**The port is a constant on purpose.** It matches `validation.app.debug_port`,
and `pdkit validate launch` refuses to start when something else already answers
there rather than quietly picking another port — which is what allows the
endpoint to be written down once.

**Pointing it at nothing is safe.** The server connects lazily: it starts,
registers its tools and waits — Open Code reports it connected with no browser
behind it — so it survives every session in which you never launch the
application. It fails only when a tool is called with nothing running.

`/pd:doctor` checks the wiring, not just the name. It asks the Open Code
service running in the background about the directory it runs in, and does not
start the service:

- a server without `--cdp-endpoint`, or one aimed at a different port, is a
  warning with the command to fix it;
- a server Open Code reports as failed, or waiting to be authorized, is a
  warning with the server's own error, not a pass;
- with the wiring right, it checks that `pd-validator` is offered all six of its
  tools. A `permissions` rule in a config — `playwright_* deny` at its top
  level, say — takes them from every agent, the plugin's included; the
  `permissions` line names the rule and the config it is in, and suggests
  giving the agent its own rules under `agents.pd-validator.permissions`.
  That key, like any `permissions`, is Open Code 2's: Open Code 1 refuses the
  whole file that holds one ([5 · Model selection](05-models.md#the-map)).

**Playwright attaches to an application pdkit started.** `pdkit validate launch`
spawns the build with `--remote-debugging-port`, waits for `/json/version` and
prints the endpoint. That is the shape upstream's own runner uses
(`tests/playwright/src/runner/chrome-dev-tools-protocol-runner.ts`), which is
also the answer to whether an Electron podman-desktop can be driven at all: it
has been, in their CI, all along. Verified end to end on 2026-08-02 against the
development build, with the Claude Code version — `browser_snapshot` came back
with the real accessibility tree. In Open Code, `pd-validator` has not driven
the application yet; what has been checked is the wiring: the server's tools by
Open Code's names, offered to `pd-validator` and to no other agent of the
plugin.

"No Playwright" and "nothing to point Playwright at" are different problems.
`doctor` reports the second separately, as `validate:app` — a perfectly
configured server still has nothing to drive if the tree was never built.

---

**The design** — [8 · MCP servers](../specification/08-mcp-servers.md), [workflows · 4 · Validating against the running application](../workflows/04-validating.md)

← [Model selection](05-models.md) · [Contents](README.md) · [Hooks other plugins install](07-hooks-from-other-tools.md) →
