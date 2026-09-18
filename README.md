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

Status: designed, not yet implemented. See
[the design](docs/superpowers/specs/2026-09-18-claude-sessions-mcp-design.md)
for the verified API surface, how bridge servers are discovered without any
host-specific configuration, the tools, and the safety rails around spawning
agents.
