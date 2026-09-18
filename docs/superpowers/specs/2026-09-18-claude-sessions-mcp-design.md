# claude-sessions-mcp — design

Date: 2026-09-18
Status: approved, not yet implemented

## Purpose

An MCP server that lets a Claude Code session create and drive **other** Claude
Code sessions inside a running Remote Control server, over the REST API the
bridge itself uses.

The motivating case: an agent needs help and wants to call in a colleague that
is not running yet, hand it a prompt, and have it start working — as a session
that belongs to the project's server, not as a process standing beside it.

A second case falls out of the same tools: from a session opened on a phone,
survey and steer every agent running on the machine.

## Why this exists

The CLI has no flag for it, and the MCP servers that exist solve a different
problem.

- `claude --environment` accepts only a self-hosted runner pool (`ccpool_...`),
  not a bridge environment (`env_...`).
- `claude --remote-control` enables Remote Control on the session you start
  yourself; started with `--bg`, that process is owned by the Claude daemon —
  outside the service's cgroup and outside the server's set of sessions.
  (Measured 2026-09-17 on CLI 2.1.274: `--bg --remote-control` also fails to
  connect the bridge at all, reporting `Claude.ai login was rejected` under a
  valid OAuth token. Cause unknown.)
- The existing third-party servers spawn their own detached `claude
  remote-control` processes — that is, new servers — or drive terminal windows
  on Windows. Neither uses a server that is already running, and two servers
  started in one directory archive each other's sessions.

The key observation is that the server does not create a session — it executes
one. Its worker runs as `claude --print --sdk-url .../v1/code/sessions/cse_…`.
The session is an API object, so creating it through the API is exactly what
puts it under the server.

## Verified API facts

Confirmed live against a Remote Control server on 2026-09-17, CLI 2.1.274.

Headers on every call:

```
Authorization: Bearer <claudeAiOauth.accessToken from the Claude Code credentials file>
anthropic-beta: oauth-2025-04-20
anthropic-version: 2023-06-01
```

| Call | Notes |
|---|---|
| `POST /v1/code/sessions` | Body: `environment_id`, `title`, `tags[]`, `config{effort_level, permission_mode, origin}`. Returns `{session: {...}}`. **This call alone starts the worker** as a child of the bridge process, before any prompt is sent. |
| `POST /v1/code/sessions/{id}/events` | Body: `{events:[{event_type:"user_message", payload:{type:"user", message:{role:"user", content:"..."}}}]}`. The field is `event_type`, not `type` — `type` returns 400. |
| `GET /v1/code/sessions/{id}/events?limit=N` | Returns `{data:[...], resume_cursor}`. Event types observed: `user`, `assistant`, `system`, `control_request`, `env_manager_log`, `rate_limit_event`, `result`. |
| `GET /v1/code/sessions/{id}/events/stream` | Server-sent events, same Bearer token. Two named events: `session_update` (bridge connectivity, e.g. `{"connection_status":"connected"}`) and `client_event` (a session event in the same shape the list endpoint returns), plus `:keepalive` comments. Each `client_event` carries an SSE `id:`, and `Last-Event-ID` resumes from it — verified: reconnecting at id 8 replayed 9 through 12. |
| `result` event | Ends a turn and carries its outcome: `subtype` (`success`), `is_error`, `result` (the final assistant text), `num_turns`, `stop_reason`, `permission_denials`, `usage`, `duration_ms`, `total_cost_usd`. This is the signal that the session has finished what it was asked to do. |
| `GET /v1/code/sessions?limit=N` | Returns `{data:[...], next_cursor, resume_token}`. **Query filters are ignored** — a request naming a non-existent `environment_id` still returns a full page. Filter client-side. Archived sessions are included. |
| `GET /v1/code/sessions/{id}` | Returns the session wrapped as `{response_shape: {...}}`, unlike the other calls' `{session: ...}`. |
| `POST /v1/code/sessions/{id}/archive` | `status: active → archived`, `status_bucket → completed`, the worker stops and the bridge slot is freed. History is kept. |
| `POST /v1/code/sessions/{id}/unarchive` | Returns `status: active`, but **the worker is not restarted**: `connection_status: disconnected`. A message posted afterwards is accepted by the API and never executed. Waking a session appears to require a client attaching over the bridge. |
| `DELETE /v1/code/sessions/{id}` | Removes the session; its worker exits. |
| `POST /v1/code/sessions/{id}/bridge` | Issues worker credentials (a worker JWT, the API base URL, a worker epoch). Not a "please run this session" call — it starts nothing. Unused by this server. |

Session fields used: `id`, `title`, `status`, `status_bucket`, `worker_status`,
`connection_status`, `environment_id`, `environment_kind` (`"bridge"` for a
Remote Control server), `tags`, `created_at`, `last_event_at`.

Custom `tags` passed at creation are stored and returned alongside the server's
own. Tags are how this server marks the sessions it created, which is why it
needs no state of its own.

## Non-goals

- Cloud sessions and routines (`/v1/code/triggers`). They run on Anthropic's
  infrastructure rather than on the machine; different problem, different
  server.
- Its own OAuth flow, refresh, or credential storage.
- Persisted state of any kind — no database, no spawn journal.
- Exposure beyond the loopback interface.

## Architecture

TypeScript on Node, `@modelcontextprotocol/sdk`, streamable-HTTP transport bound
to `127.0.0.1`, started by a systemd user unit.

One process per machine rather than one per session. A stdio MCP server is
started once per client session, and the cost is easy to underestimate: measured
on a host running 20 concurrent Claude Code sessions, one stdio server had grown
to roughly 90 processes and 4.8 GB of resident memory, because each session's
copy brought a process tree rather than a single process.

Four modules, each with one job:

- **`discovery.ts`** — which bridge servers are running on this machine. The
  only module that knows about the host.
- **`api.ts`** — a thin client for `/v1/code/sessions*`. The only module that
  speaks HTTP.
- **`tools.ts`** — the MCP tools: input validation, safety rails, response
  shaping. Knows only `discovery` and `api`.
- **`server.ts`** — transport and startup.

The boundary matters in one specific way: `tools.ts` is the only caller of
`api.createSession`, so the safety rails cannot be reached around.

### Discovery is host-agnostic

No local convention is read — no configuration files of the operator's own, no
systemd, no journal. Everything comes from the harness itself:

- **The bridge process** (`claude remote-control` in the process table) gives
  the instance name (`--name`, falling back to `basename(cwd)`), the capacity
  (`--capacity`, default 32 as in the CLI), the spawn mode (`--spawn`), the
  working directory (`/proc/<pid>/cwd`), and the live load — the number of child
  processes carrying `--sdk-url`. That count is more accurate than the server's
  own `Capacity: N/M` banner, which lags by about a minute.
- **The bridge pointer file** Claude Code writes per project
  (`<claude-config>/projects/<slug>/bridge-pointer.json`) gives `environmentId`
  and the `pid` that owns it. Joining on the pid maps environment to instance
  and drops pointers left behind by servers that have died.

This works for a server started by hand in a terminal just as well as for one
run by a service manager.

`/proc` makes the first implementation Linux-only. The platform-specific part is
one function in `discovery.ts` (argv and cwd for a pid); a macOS version would
use `ps` and `lsof`.

## Tools

Responses are compact JSON: the consumer is a model, and fields are cheaper for
it to read than rendered tables.

| Tool | Arguments | Returns |
|---|---|---|
| `list_instances` | — | Per bridge on this machine: name, working directory, environment id, workers in use, capacity, spawn mode |
| `list_sessions` | `instance?` | Sessions of that environment (all environments if omitted): id, title, `status`, `worker_status`, `connection_status`, `last_event_at`, and who created it (from tags) |
| `spawn_session` | `instance`, `prompt`, `title?`, `effort?`, `permission_mode?`, `caller?` | Creates the session, tags it `mcp:claude-sessions-mcp` and `spawned-by:<caller>`, posts the prompt, returns the session id |
| `send_message` | `session_id`, `text` | Posts a `user_message` to a live session |
| `read_session` | `session_id`, `limit?`, `cursor?`, `verbose?` | Condensed events: user and assistant turns plus status changes. `control_request` and `env_manager_log` only under `verbose`. Returns the API's `resume_cursor` for continuation |
| `wait_for_idle` | `session_id`, `timeout_s` | Opens the event stream and waits for the turn's `result`, then returns its text along with `stop_reason`, `permission_denials` and cost. See below |
| `archive_session` | `session_id` | Stops the session, keeping its history |
| `unarchive_session` | `session_id` | Returns it to active. **The tool description states plainly that this does not restart the worker**, so a calling agent does not conclude it has woken a colleague |
| `delete_session` | `session_id` | Deletes the session and its worker |

### Waiting is streamed, subscribing is not

`wait_for_idle` opens `GET /events/stream` for the duration of the call, waits
for the `result` event, and closes. If the connection drops it reconnects with
`Last-Event-ID` and continues where it left off, so a dropped stream costs a
reconnect rather than a missed answer. `timeout_s` bounds the wait; on timeout
the tool says the session is still working rather than pretending otherwise.

The distinction worth keeping: a stream scoped to one call needs no registry, no
background reconnect loop and no state between calls. A *subscription* — holding
streams open across every live session to push notifications — would need all
three, and is out of scope. Waiting inside a call is the cheap half of
streaming; keeping watch is the expensive half.

Nothing else streams. `read_session` reads history through the list endpoint,
where a cursor is the right tool.

## Safety rails

The server spawns agents on the user's machine, so the limits are part of the
design rather than a later hardening pass.

1. **No `bypassPermissions`.** `permission_mode` is restricted to
   `auto | acceptEdits | plan | manual | dontAsk`. A request for
   `bypassPermissions` is rejected with an explicit message, never silently
   downgraded. Otherwise an agent that was denied something in its own session
   could spawn an unrestricted neighbour and have it do the same work.
2. **Locally discovered environments only.** `spawn_session` accepts an instance
   from `discovery`, never a raw `env_...`. Environments on another machine or
   in the cloud stay out of reach even though the REST API would accept them.
3. **A spawn ceiling of its own.** `CLAUDE_SESSIONS_MCP_MAX_SPAWNED` (default 3)
   counts active sessions in the environment tagged `mcp:claude-sessions-mcp`.
   Independent of, and in addition to, the bridge's own capacity check (workers
   in use must be below `--capacity`) — a full bridge accepts a session and
   never runs it, which looks like a hang.
4. **Attribution.** Every created session carries `spawned-by:<caller>`, so it
   is visible afterwards which agent produced it.

A recursion depth limit was considered and deliberately left out: a spawned
session may spawn further, and the ceiling in (3) bounds the total regardless.

## Authentication and errors

The token is read from the Claude Code credentials file
(`claudeAiOauth.accessToken`) and cached against that file's mtime. There is no
refresh flow here — Claude Code refreshes the file itself. On a 401 the file is
re-read once and the request retried; a second 401 returns an error telling the
user to log in again.

HTTP: 30 s timeout, up to 3 attempts with exponential backoff on 429 and 5xx, no
retries on other 4xx. API errors reach the agent with the status code and
`request_id` intact.

## Deployment

A systemd user unit running `node dist/server.js`, listening on
`127.0.0.1:8765` (`PORT` overrides). Connected with:

```
claude mcp add --transport http --scope user sessions http://127.0.0.1:8765/mcp
```

Running it in a container is possible but pointless: the server needs the host's
pid namespace, `/proc` for its processes, and the credentials file. Passing all
three through leaves the container isolating nothing. The unit file and setup
instructions live in the repository; installation is manual.

## Testing

Vitest.

- **`discovery`** against fixtures rather than a live `/proc`: argv parsing
  (missing `--name`, missing `--capacity`), joining a bridge pointer to a pid,
  discarding a pointer whose process is gone.
- **Safety rails**, one test each, including the `bypassPermissions` rejection
  and the ceiling at its boundary.
- **`api`** as contract tests against recorded responses; the response shapes
  above are the fixtures.
- **One end-to-end script**, run by hand and not in CI, that spawns a session in
  a real instance, reads its reply, and deletes it.

## Open questions

- Waking an archived session without a client attaching — unsolved. If a REST
  path for it turns up, `unarchive_session` gets honest behaviour and its caveat
  disappears.
- macOS support in `discovery`.
- Whether a background subscription ever earns its keep — pushing "your
  colleague finished" without anyone waiting on the call. It needs a registry
  and reconnect logic that the current design does without.
