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
| `PORT` | `8765` | Port the server listens on (loopback only). |
| `CLAUDE_SESSIONS_MCP_MAX_SPAWNED` | `3` | Ceiling on sessions this server may have spawned and left active per bridge. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where Claude Code keeps its config, including bridge pointer files. |
| `CLAUDE_CREDENTIALS_PATH` | `<CLAUDE_CONFIG_DIR>/.credentials.json` | Path to the claude.ai OAuth credentials file. |

### Requirements

Linux only — bridge discovery reads `/proc` to find running Remote Control
servers and their workers. The server must run as the same user as the
bridges it talks to: it reads their process table and the shared credentials
file, both of which are only visible to that user.
