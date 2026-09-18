# claude-sessions-mcp

An MCP server for creating and driving Claude Code sessions inside a **running**
Remote Control server, over the REST API the bridge itself uses.

An agent can call in a colleague that is not running yet, hand it a prompt, and
have it start working — as a session that belongs to the project's server, with
its worker under that server, visible in claude.ai and reachable from the other
sessions on the machine. The same tools let you survey and steer every agent
running there from a session opened on a phone.

Runs as a single process per machine (streamable-HTTP on `127.0.0.1`), not as a
stdio subprocess per session.

See [the design](docs/superpowers/specs/2026-09-18-claude-sessions-mcp-design.md)
for the verified API surface, how bridge servers are discovered without any
host-specific configuration, the tools, and the safety rails around spawning
agents.

## Usage

### Build

```bash
npm install
npm run build
```

### Install as a systemd user service

Copy the unit into your systemd user directory and adjust the two paths to
where you checked out this repository:

```bash
cp deploy/claude-sessions-mcp.service ~/.config/systemd/user/
```

Edit `WorkingDirectory=` and `ExecStart=` in the copied unit if the repository
does not live directly under your home directory (the shipped unit assumes
`~/claude-sessions-mcp`). Then enable and start it:

```bash
systemctl --user enable --now claude-sessions-mcp
```

### Register it with Claude Code

```bash
claude mcp add --transport http --scope user sessions http://127.0.0.1:8765/mcp
```

### Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Interface to bind. Only `127.0.0.1`, `localhost` and `::1` are accepted — the server spawns agents, so it refuses to start on any other address. Requests carrying a foreign `Host` header are rejected as well. |
| `PORT` | `8765` | Port the server listens on (loopback only). |
| `CLAUDE_SESSIONS_MCP_MAX_SPAWNED` | `3` | Ceiling on sessions this server may have spawned and left active per bridge. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where Claude Code keeps its config, including bridge pointer files. |
| `CLAUDE_CREDENTIALS_PATH` | `<CLAUDE_CONFIG_DIR>/.credentials.json` | Path to the claude.ai OAuth credentials file. |

### Requirements

Node.js 22 or newer (the code is ESM and uses ES2023 library features).

Linux only — bridge discovery reads `/proc` to find running Remote Control
servers and their workers. The server must run as the same user as the
bridges it talks to: it reads their process table and the shared credentials
file, both of which are only visible to that user.

The server keeps no state between calls: no session registry, no database, no
files of its own. `wait_for_idle` holds an event stream open for the duration
of that one call, and alongside it polls the session's status, because
archiving a session cuts its turn short without emitting anything on the
stream. Both end with the call: nothing is subscribed or watched between
calls.

### Safety rails

- `permission_mode` accepts `auto`, `acceptEdits`, `plan`, `manual` or
  `dontAsk` only. `bypassPermissions` is refused outright, never downgraded.
- Sessions can be spawned only in bridges discovered on this machine, never in
  a raw environment id.
- `CLAUDE_SESSIONS_MCP_MAX_SPAWNED` bounds how many active sessions this server
  may have created per bridge; if that count cannot be established completely,
  the spawn is refused rather than allowed.
- Every created session is tagged `mcp:claude-sessions-mcp` and
  `spawned-by:<caller>`.

## Releasing

The version lives in one place, `package.json`; the server reports it in the
MCP handshake, and a test asserts the two agree.

```
npm run release -- patch | minor | major | X.Y.Z
```

The script refuses a dirty tree or a branch other than `master`, checks that
the target tag is free and that `origin` is not ahead, runs the build and the
tests, then bumps the version, commits and tags `vX.Y.Z`. Pushing is left to
you — it prints the command.

Pushing the tag opens a **draft** release with generated notes
(`.github/workflows/release-draft.yml`); edit it into something worth reading
and publish it by hand. Nothing else reacts to a tag: there is no build to
trigger and nothing to deploy.

## License

MIT — see [LICENSE](LICENSE).
