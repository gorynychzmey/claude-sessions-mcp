# claude-sessions-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An MCP server that creates and drives Claude Code sessions inside a Remote Control server that is already running on the same machine.

**Architecture:** Four modules with one job each — `proc`/`discovery` find the running bridges from the process table and the pointer files Claude Code writes, `api` speaks REST and SSE to `/v1/code/sessions*`, `tools` holds validation and the safety rails, `server` serves streamable-HTTP on the loopback. No persisted state: the server's own sessions are identified by a tag it sets at creation.

**Tech Stack:** TypeScript (strict, ESM), Node ≥ 22, `@modelcontextprotocol/sdk`, `zod`, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-18-claude-sessions-mcp-design.md`

## Global Constraints

- Node ≥ 22. ESM only (`"type": "module"`), TypeScript `strict: true`.
- This repository is public: no host paths, machine names, environment ids (`env_…`), session ids (`cse_…`), or references to private projects in code, tests, fixtures, comments, or docs. Fixtures use invented values.
- Everything in the repository is in English — code, comments, docs, commit messages.
- No persisted state: no database, no spawn journal, no cache surviving the process.
- The HTTP transport binds `127.0.0.1` only.
- `permission_mode` is restricted to `auto | acceptEdits | plan | manual | dontAsk`; `bypassPermissions` is rejected, never downgraded.
- Every session created by this server is tagged `mcp:claude-sessions-mcp` and `spawned-by:<caller>`.
- API calls carry `Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20`, `anthropic-version: 2023-06-01`.
- Commit after every task.

---

### Task 1: Project scaffold and bridge argv parsing

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` (already present — extend if needed)
- Create: `src/types.ts`, `src/proc.ts`
- Test: `tests/proc.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ProcessInfo { pid: number; ppid: number; argv: string[]; cwd: string | null }`, `ProcSource { list(): Promise<ProcessInfo[]> }`, `linuxProcSource: ProcSource`, `parseBridgeArgv(argv: string[]): BridgeArgv | null` where `BridgeArgv { name: string | null; capacity: number; spawnMode: string | null }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/proc.test.ts
import { describe, expect, it } from "vitest";
import { parseBridgeArgv } from "../src/proc.js";

const bridge = (extra: string[] = []) => [
  "/usr/local/bin/claude", "remote-control", ...extra,
];

describe("parseBridgeArgv", () => {
  it("reads name, capacity and spawn mode", () => {
    expect(parseBridgeArgv(bridge(["--name", "demo", "--spawn", "worktree", "--capacity", "4"])))
      .toEqual({ name: "demo", capacity: 4, spawnMode: "worktree" });
  });

  it("defaults capacity to the CLI default when absent", () => {
    expect(parseBridgeArgv(bridge(["--name", "demo"])))
      .toEqual({ name: "demo", capacity: 32, spawnMode: null });
  });

  it("returns a null name when --name is absent, leaving the fallback to the caller", () => {
    expect(parseBridgeArgv(bridge())).toEqual({ name: null, capacity: 32, spawnMode: null });
  });

  it("ignores a capacity that is not a positive integer", () => {
    expect(parseBridgeArgv(bridge(["--capacity", "nonsense"]))?.capacity).toBe(32);
  });

  it("is not fooled by a process that merely mentions the words", () => {
    expect(parseBridgeArgv(["/bin/bash", "-c", "echo claude remote-control"])).toBeNull();
    expect(parseBridgeArgv(["/usr/local/bin/claude", "--help"])).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/proc.test.ts`
Expected: FAIL — cannot resolve `../src/proc.js`.

- [ ] **Step 3: Create the scaffold**

`package.json`:

```json
{
  "name": "claude-sessions-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.0.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
```

Then run `npm install`.

- [ ] **Step 4: Check the SDK surface before writing against it**

Run: `node -e "import('@modelcontextprotocol/sdk/server/mcp.js').then(m => console.log(Object.keys(m)))"`
Expected: the export list includes `McpServer`. Note the installed version (`npm ls @modelcontextprotocol/sdk`) — Task 10 registers tools against it, and if `registerTool` is absent in that version, use the `server.tool(name, schema, handler)` form the installed README documents.

- [ ] **Step 5: Write `src/types.ts`**

```ts
export interface BridgeInstance {
  name: string;
  cwd: string;
  pid: number;
  environmentId: string;
  capacity: number;
  workers: number;
  spawnMode: string | null;
}

export interface SessionSummary {
  id: string;
  title: string;
  status: string;
  statusBucket: string;
  workerStatus: string;
  connectionStatus: string;
  environmentId: string;
  lastEventAt: string;
  spawnedBy: string | null;
  createdByThisServer: boolean;
}

export interface TurnResult {
  text: string;
  isError: boolean;
  stopReason: string | null;
  numTurns: number | null;
  permissionDenials: unknown[];
  costUsd: number | null;
}
```

- [ ] **Step 6: Write `src/proc.ts`**

```ts
import { readFile, readdir, readlink } from "node:fs/promises";

export interface ProcessInfo {
  pid: number;
  ppid: number;
  argv: string[];
  cwd: string | null;
}

export interface ProcSource {
  list(): Promise<ProcessInfo[]>;
}

export interface BridgeArgv {
  name: string | null;
  capacity: number;
  spawnMode: string | null;
}

/** The CLI's own default when --capacity is not given. */
export const DEFAULT_CAPACITY = 32;

function flagValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/**
 * Recognises a Remote Control bridge by its argv and reads what it declares.
 * Returns null for anything else, including shells whose command line merely
 * contains the words.
 */
export function parseBridgeArgv(argv: string[]): BridgeArgv | null {
  const [exe, subcommand] = argv;
  if (!exe || !/(^|\/)claude$/.test(exe)) return null;
  if (subcommand !== "remote-control") return null;

  const rawCapacity = flagValue(argv, "--capacity");
  const capacity = Number(rawCapacity);
  return {
    name: flagValue(argv, "--name"),
    capacity: Number.isInteger(capacity) && capacity > 0 ? capacity : DEFAULT_CAPACITY,
    spawnMode: flagValue(argv, "--spawn"),
  };
}

/** Linux implementation. A macOS port replaces this object and nothing else. */
export const linuxProcSource: ProcSource = {
  async list(): Promise<ProcessInfo[]> {
    const entries = await readdir("/proc");
    const pids = entries.filter((e) => /^\d+$/.test(e)).map(Number);
    const infos = await Promise.all(pids.map((pid) => readProcess(pid)));
    return infos.filter((p): p is ProcessInfo => p !== null);
  },
};

async function readProcess(pid: number): Promise<ProcessInfo | null> {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
    const argv = raw.split("\0").filter((s) => s.length > 0);
    if (argv.length === 0) return null;
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => null);
    return { pid, ppid: Number.isFinite(ppid) ? ppid : 0, argv, cwd };
  } catch {
    return null; // the process exited while we were reading it
  }
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/proc.test.ts`
Expected: 5 passing.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src/types.ts src/proc.ts tests/proc.test.ts
git commit -m "feat: scaffold the project and recognise bridge processes"
```

---

### Task 2: Discovery of running bridges

**Files:**
- Create: `src/discovery.ts`
- Test: `tests/discovery.test.ts`

**Interfaces:**
- Consumes: `ProcSource`, `ProcessInfo`, `parseBridgeArgv`, `DEFAULT_CAPACITY` from `src/proc.js`; `BridgeInstance` from `src/types.js`.
- Produces: `BridgePointer { environmentId: string; pid: number }`, `DiscoveryDeps { proc: ProcSource; readPointers(): Promise<BridgePointer[]> }`, `discoverInstances(deps: DiscoveryDeps): Promise<BridgeInstance[]>`, `readPointersFrom(projectsDir: string): Promise<BridgePointer[]>`, `defaultDiscoveryDeps(claudeConfigDir: string): DiscoveryDeps`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/discovery.test.ts
import { describe, expect, it } from "vitest";
import { discoverInstances } from "../src/discovery.js";
import type { ProcessInfo } from "../src/proc.js";

const bridge = (pid: number, name: string | null, cwd: string, extra: string[] = []): ProcessInfo => ({
  pid, ppid: 1, cwd,
  argv: ["/usr/local/bin/claude", "remote-control", ...(name ? ["--name", name] : []), ...extra],
});

const worker = (pid: number, ppid: number): ProcessInfo => ({
  pid, ppid, cwd: "/srv/project",
  argv: ["/opt/claude", "--print", "--sdk-url", "https://api.example.test/v1/code/sessions/s-1"],
});

const deps = (processes: ProcessInfo[], pointers: { environmentId: string; pid: number }[]) => ({
  proc: { list: async () => processes },
  readPointers: async () => pointers,
});

describe("discoverInstances", () => {
  it("joins a bridge process to its pointer and counts its workers", async () => {
    const found = await discoverInstances(deps(
      [bridge(100, "alpha", "/srv/alpha", ["--capacity", "4", "--spawn", "same-dir"]), worker(101, 100), worker(102, 100)],
      [{ environmentId: "env-alpha", pid: 100 }],
    ));
    expect(found).toEqual([{
      name: "alpha", cwd: "/srv/alpha", pid: 100, environmentId: "env-alpha",
      capacity: 4, workers: 2, spawnMode: "same-dir",
    }]);
  });

  it("drops a pointer whose process is gone", async () => {
    const found = await discoverInstances(deps([], [{ environmentId: "env-dead", pid: 999 }]));
    expect(found).toEqual([]);
  });

  it("drops a bridge that has no pointer, since it cannot be addressed", async () => {
    const found = await discoverInstances(deps([bridge(100, "alpha", "/srv/alpha")], []));
    expect(found).toEqual([]);
  });

  it("falls back to the directory name when --name is absent", async () => {
    const [found] = await discoverInstances(deps(
      [bridge(100, null, "/srv/my-project")],
      [{ environmentId: "env-1", pid: 100 }],
    ));
    expect(found.name).toBe("my-project");
  });

  it("does not count another bridge's workers", async () => {
    const found = await discoverInstances(deps(
      [bridge(100, "alpha", "/srv/alpha"), bridge(200, "beta", "/srv/beta"), worker(101, 100)],
      [{ environmentId: "env-alpha", pid: 100 }, { environmentId: "env-beta", pid: 200 }],
    ));
    expect(found.map((i) => [i.name, i.workers])).toEqual([["alpha", 1], ["beta", 0]]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/discovery.test.ts`
Expected: FAIL — cannot resolve `../src/discovery.js`.

- [ ] **Step 3: Write `src/discovery.ts`**

```ts
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { linuxProcSource, parseBridgeArgv, type ProcSource } from "./proc.js";
import type { BridgeInstance } from "./types.js";

export interface BridgePointer {
  environmentId: string;
  pid: number;
}

export interface DiscoveryDeps {
  proc: ProcSource;
  readPointers(): Promise<BridgePointer[]>;
}

/**
 * The bridges running on this machine, each joined to the environment it
 * registered. A bridge without a live pointer is left out: without an
 * environment id there is nothing we could ask it to do.
 */
export async function discoverInstances(deps: DiscoveryDeps): Promise<BridgeInstance[]> {
  const [processes, pointers] = await Promise.all([deps.proc.list(), deps.readPointers()]);
  const byPid = new Map(pointers.map((p) => [p.pid, p.environmentId]));

  const workersByParent = new Map<number, number>();
  for (const p of processes) {
    if (p.argv.includes("--sdk-url")) {
      workersByParent.set(p.ppid, (workersByParent.get(p.ppid) ?? 0) + 1);
    }
  }

  const instances: BridgeInstance[] = [];
  for (const p of processes) {
    const argv = parseBridgeArgv(p.argv);
    const environmentId = byPid.get(p.pid);
    if (!argv || !environmentId || !p.cwd) continue;
    instances.push({
      name: argv.name ?? basename(p.cwd),
      cwd: p.cwd,
      pid: p.pid,
      environmentId,
      capacity: argv.capacity,
      workers: workersByParent.get(p.pid) ?? 0,
      spawnMode: argv.spawnMode,
    });
  }
  return instances;
}

/** Reads every `<projectsDir>/<slug>/bridge-pointer.json` Claude Code has written. */
export async function readPointersFrom(projectsDir: string): Promise<BridgePointer[]> {
  const slugs = await readdir(projectsDir).catch(() => [] as string[]);
  const pointers = await Promise.all(slugs.map(async (slug) => {
    const raw = await readFile(join(projectsDir, slug, "bridge-pointer.json"), "utf8").catch(() => null);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as { environmentId?: unknown; pid?: unknown };
      if (typeof parsed.environmentId !== "string" || typeof parsed.pid !== "number") return null;
      return { environmentId: parsed.environmentId, pid: parsed.pid };
    } catch {
      return null; // a half-written pointer is not an error worth failing discovery over
    }
  }));
  return pointers.filter((p): p is BridgePointer => p !== null);
}

export function defaultDiscoveryDeps(claudeConfigDir: string): DiscoveryDeps {
  return {
    proc: linuxProcSource,
    readPointers: () => readPointersFrom(join(claudeConfigDir, "projects")),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/discovery.test.ts`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/discovery.ts tests/discovery.test.ts
git commit -m "feat: discover running bridges from processes and pointer files"
```

---

### Task 3: Credentials

**Files:**
- Create: `src/credentials.ts`
- Test: `tests/credentials.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CredentialsError extends Error`, `TokenReader { read(): Promise<string>; invalidate(): void }`, `createTokenReader(path: string): TokenReader`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/credentials.test.ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CredentialsError, createTokenReader } from "../src/credentials.js";

async function credentialsFile(token: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "creds-"));
  const path = join(dir, "credentials.json");
  await writeFile(path, JSON.stringify({ claudeAiOauth: { accessToken: token } }));
  return path;
}

describe("createTokenReader", () => {
  it("reads the access token", async () => {
    const reader = createTokenReader(await credentialsFile("token-1"));
    expect(await reader.read()).toBe("token-1");
  });

  it("serves the cached token without re-reading an unchanged file", async () => {
    const path = await credentialsFile("token-1");
    const reader = createTokenReader(path);
    expect(await reader.read()).toBe("token-1");
    await writeFile(path, JSON.stringify({ claudeAiOauth: { accessToken: "token-2" } }));
    expect(await reader.read()).toBe("token-2"); // mtime changed, so the cache yields
  });

  it("re-reads after invalidate even when the file has not changed", async () => {
    const path = await credentialsFile("token-1");
    const reader = createTokenReader(path);
    await reader.read();
    await writeFile(path, JSON.stringify({ claudeAiOauth: { accessToken: "token-3" } }));
    reader.invalidate();
    expect(await reader.read()).toBe("token-3");
  });

  it("explains itself when the file is missing", async () => {
    const reader = createTokenReader("/nonexistent/credentials.json");
    await expect(reader.read()).rejects.toBeInstanceOf(CredentialsError);
  });

  it("explains itself when the file holds no OAuth token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "creds-"));
    const path = join(dir, "credentials.json");
    await writeFile(path, JSON.stringify({ mcpOAuth: {} }));
    await expect(createTokenReader(path).read()).rejects.toBeInstanceOf(CredentialsError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/credentials.test.ts`
Expected: FAIL — cannot resolve `../src/credentials.js`.

- [ ] **Step 3: Write `src/credentials.ts`**

```ts
import { readFile, stat } from "node:fs/promises";

export class CredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialsError";
  }
}

export interface TokenReader {
  read(): Promise<string>;
  /** Forget the cached token, so the next read goes back to disk. */
  invalidate(): void;
}

/**
 * Reads the claude.ai OAuth token Claude Code maintains. There is no refresh
 * flow here on purpose: Claude Code refreshes that file itself, so the cache is
 * keyed on the file's mtime and a 401 is answered by invalidating and retrying.
 */
export function createTokenReader(path: string): TokenReader {
  let cached: { token: string; mtimeMs: number } | null = null;

  return {
    invalidate() {
      cached = null;
    },
    async read(): Promise<string> {
      const info = await stat(path).catch(() => null);
      if (info === null) {
        throw new CredentialsError(
          `No Claude Code credentials at ${path}. Run \`claude /login\` on this machine.`,
        );
      }
      if (cached && cached.mtimeMs === info.mtimeMs) return cached.token;

      const raw = await readFile(path, "utf8");
      let token: unknown;
      try {
        token = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } })
          .claudeAiOauth?.accessToken;
      } catch {
        throw new CredentialsError(`Credentials file ${path} is not valid JSON.`);
      }
      if (typeof token !== "string" || token.length === 0) {
        throw new CredentialsError(
          `Credentials file ${path} holds no claude.ai OAuth token. Run \`claude /login\`.`,
        );
      }
      cached = { token, mtimeMs: info.mtimeMs };
      return token;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/credentials.test.ts`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/credentials.ts tests/credentials.test.ts
git commit -m "feat: read the claude.ai token with an mtime-keyed cache"
```

---

### Task 4: REST client

**Files:**
- Create: `src/api.ts`
- Test: `tests/api.test.ts`

**Interfaces:**
- Consumes: `TokenReader`, `CredentialsError` from `src/credentials.js`.
- Produces: `ApiError extends Error { status: number; requestId: string | null }`, `RawSession`, `RawEvent`, `SessionsApi` with `createSession`, `postUserMessage`, `listSessions`, `getSession`, `listEvents`, `archiveSession`, `unarchiveSession`, `deleteSession`; constructor `new SessionsApi({ token, baseUrl?, fetchImpl?, retryDelayMs? })`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/api.test.ts
import { describe, expect, it, vi } from "vitest";
import { ApiError, SessionsApi } from "../src/api.js";

const token = { read: async () => "tok", invalidate: vi.fn() };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const session = {
  id: "s-1", title: "demo", status: "active", status_bucket: "working",
  worker_status: "running", connection_status: "connected",
  environment_id: "env-1", last_event_at: "2026-01-01T00:00:00Z",
  tags: ["mcp:claude-sessions-mcp", "spawned-by:tester"],
};

describe("SessionsApi", () => {
  it("creates a session with tags and config, and unwraps {session}", async () => {
    const fetchImpl = vi.fn(async () => json({ session }));
    const api = new SessionsApi({ token, fetchImpl: fetchImpl as unknown as typeof fetch });

    const created = await api.createSession({
      environmentId: "env-1", title: "demo",
      tags: ["mcp:claude-sessions-mcp"], effort: "medium", permissionMode: "auto",
    });

    expect(created.id).toBe("s-1");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/code/sessions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(JSON.parse(init.body as string)).toEqual({
      environment_id: "env-1", title: "demo", tags: ["mcp:claude-sessions-mcp"],
      config: { effort_level: "medium", permission_mode: "auto", origin: "cli" },
    });
  });

  it("posts a user message in the event_type envelope the API requires", async () => {
    const fetchImpl = vi.fn(async () => json({ results: [] }));
    const api = new SessionsApi({ token, fetchImpl: fetchImpl as unknown as typeof fetch });

    await api.postUserMessage("s-1", "hello");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/code/sessions/s-1/events");
    expect(JSON.parse(init.body as string)).toEqual({
      events: [{ event_type: "user_message", payload: { type: "user", message: { role: "user", content: "hello" } } }],
    });
  });

  it("unwraps the response_shape envelope that only GET of one session uses", async () => {
    const fetchImpl = vi.fn(async () => json({ response_shape: session }));
    const api = new SessionsApi({ token, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await api.getSession("s-1")).status).toBe("active");
  });

  it("retries a 429 and then succeeds", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ error: { message: "slow down" } }, 429))
      .mockResolvedValueOnce(json({ data: [session], next_cursor: null }));
    const api = new SessionsApi({ token, fetchImpl: fetchImpl as unknown as typeof fetch, retryDelayMs: 0 });

    expect(await api.listSessions()).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("re-reads the token once on 401 and retries", async () => {
    const invalidate = vi.fn();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ error: { message: "expired" } }, 401))
      .mockResolvedValueOnce(json({ data: [], next_cursor: null }));
    const api = new SessionsApi({
      token: { read: async () => "tok", invalidate },
      fetchImpl: fetchImpl as unknown as typeof fetch, retryDelayMs: 0,
    });

    await api.listSessions();
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it("gives up on a second 401 with an actionable message", async () => {
    const fetchImpl = vi.fn(async () => json({ error: { message: "expired" } }, 401));
    const api = new SessionsApi({
      token, fetchImpl: fetchImpl as unknown as typeof fetch, retryDelayMs: 0,
    });
    await expect(api.listSessions()).rejects.toThrow(/claude \/login/);
  });

  it("does not retry a 400 and carries the request id", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ error: { message: "bad" } }, 400, { "request-id": "req_1" }));
    const api = new SessionsApi({
      token, fetchImpl: fetchImpl as unknown as typeof fetch, retryDelayMs: 0,
    });

    const failure = await api.listSessions().catch((e: unknown) => e as ApiError);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(400);
    expect((failure as ApiError).requestId).toBe("req_1");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("archives, unarchives and deletes by path", async () => {
    const fetchImpl = vi.fn(async () => json({ session }));
    const api = new SessionsApi({ token, fetchImpl: fetchImpl as unknown as typeof fetch });

    await api.archiveSession("s-1");
    await api.unarchiveSession("s-1");
    await api.deleteSession("s-1");

    expect(fetchImpl.mock.calls.map(([url, init]) => [
      (url as string).replace("https://api.anthropic.com/v1/code/sessions/", ""),
      (init as RequestInit).method,
    ])).toEqual([["s-1/archive", "POST"], ["s-1/unarchive", "POST"], ["s-1", "DELETE"]]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api.test.ts`
Expected: FAIL — cannot resolve `../src/api.js`.

- [ ] **Step 3: Write `src/api.ts`**

```ts
import type { TokenReader } from "./credentials.js";

export const DEFAULT_BASE_URL = "https://api.anthropic.com";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly requestId: string | null) {
    super(message);
    this.name = "ApiError";
  }
}

export interface RawSession {
  id: string;
  title?: string;
  status?: string;
  status_bucket?: string;
  worker_status?: string;
  connection_status?: string;
  environment_id?: string;
  last_event_at?: string;
  tags?: string[];
}

export interface RawEvent {
  event_id?: string;
  sequence_num?: string;
  event_type?: string;
  payload?: Record<string, unknown>;
  created_at?: string;
}

export interface CreateSessionInput {
  environmentId: string;
  title: string;
  tags: string[];
  effort: string;
  permissionMode: string;
}

export interface SessionsApiOptions {
  token: TokenReader;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
}

const RETRIABLE = (status: number) => status === 429 || status >= 500;

export class SessionsApi {
  private readonly token: TokenReader;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelayMs: number;

  constructor(options: SessionsApiOptions) {
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryDelayMs = options.retryDelayMs ?? 500;
  }

  async headers(): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await this.token.read()}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    };
  }

  url(path: string): string {
    return `${this.baseUrl}/v1/code/sessions${path}`;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      const response = await this.fetchImpl(this.url(path), {
        ...init,
        headers: await this.headers(),
        signal: AbortSignal.timeout(30_000),
      });

      if (response.ok) {
        const text = await response.text();
        return text.length > 0 ? JSON.parse(text) : {};
      }

      const requestId = response.headers.get("request-id");
      const body = await response.text();

      if (response.status === 401 && !refreshed) {
        this.token.invalidate();
        refreshed = true;
        continue;
      }
      if (response.status === 401) {
        throw new ApiError(
          "claude.ai rejected the stored token. Run `claude /login` on this machine.",
          401, requestId,
        );
      }
      if (RETRIABLE(response.status) && attempt < 3) {
        await new Promise((r) => setTimeout(r, this.retryDelayMs * attempt));
        continue;
      }
      throw new ApiError(
        `${init.method ?? "GET"} ${path} failed (${response.status}): ${body.slice(0, 300)}`,
        response.status, requestId,
      );
    }
  }

  async createSession(input: CreateSessionInput): Promise<RawSession> {
    const body = await this.request("", {
      method: "POST",
      body: JSON.stringify({
        environment_id: input.environmentId,
        title: input.title,
        tags: input.tags,
        config: {
          effort_level: input.effort,
          permission_mode: input.permissionMode,
          origin: "cli",
        },
      }),
    }) as { session: RawSession };
    return body.session;
  }

  async postUserMessage(sessionId: string, text: string): Promise<void> {
    await this.request(`/${sessionId}/events`, {
      method: "POST",
      body: JSON.stringify({
        events: [{
          event_type: "user_message",
          payload: { type: "user", message: { role: "user", content: text } },
        }],
      }),
    });
  }

  async listSessions(limit = 100): Promise<RawSession[]> {
    // The API ignores query filters such as environment_id, so callers filter
    // client-side on what comes back.
    const body = await this.request(`?limit=${limit}`) as { data?: RawSession[] };
    return body.data ?? [];
  }

  async getSession(sessionId: string): Promise<RawSession> {
    // Only this endpoint wraps the session in response_shape.
    const body = await this.request(`/${sessionId}`) as
      { response_shape?: RawSession; session?: RawSession };
    const session = body.response_shape ?? body.session;
    if (!session) throw new ApiError(`Session ${sessionId} came back empty`, 200, null);
    return session;
  }

  async listEvents(
    sessionId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<{ events: RawEvent[]; resumeCursor: string | null }> {
    const query = new URLSearchParams({ limit: String(options.limit ?? 40) });
    if (options.cursor) query.set("cursor", options.cursor);
    const body = await this.request(`/${sessionId}/events?${query}`) as
      { data?: RawEvent[]; resume_cursor?: string };
    return { events: body.data ?? [], resumeCursor: body.resume_cursor ?? null };
  }

  async archiveSession(sessionId: string): Promise<RawSession> {
    return (await this.request(`/${sessionId}/archive`, { method: "POST" }) as
      { session: RawSession }).session;
  }

  async unarchiveSession(sessionId: string): Promise<RawSession> {
    return (await this.request(`/${sessionId}/unarchive`, { method: "POST" }) as
      { session: RawSession }).session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request(`/${sessionId}`, { method: "DELETE" });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/api.test.ts`
Expected: 8 passing.

- [ ] **Step 5: Commit**

```bash
git add src/api.ts tests/api.test.ts
git commit -m "feat: add the sessions REST client with retries and 401 recovery"
```

---

### Task 5: Event stream

**Files:**
- Create: `src/stream.ts`
- Modify: `src/api.ts` (add `streamEvents`)
- Test: `tests/stream.test.ts`

**Interfaces:**
- Consumes: `SessionsApi` internals (`headers()`, `url()`) from Task 4.
- Produces: `SseMessage { event: string | null; id: string | null; data: string }`, `parseSse(chunks: AsyncIterable<string>): AsyncGenerator<SseMessage>`, and `SessionsApi.streamEvents(sessionId, { lastEventId?, signal }): AsyncGenerator<{ id: string | null; event: string | null; payload: unknown }>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/stream.test.ts
import { describe, expect, it } from "vitest";
import { parseSse } from "../src/stream.js";

async function* chunks(...parts: string[]) {
  for (const part of parts) yield part;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

describe("parseSse", () => {
  it("reads named events with their ids", async () => {
    const messages = await collect(parseSse(chunks(
      "event: session_update\ndata: {\"connection_status\":\"connected\"}\n\n",
      "event: client_event\nid: 7\ndata: {\"event_type\":\"assistant\"}\n\n",
    )));
    expect(messages).toEqual([
      { event: "session_update", id: null, data: "{\"connection_status\":\"connected\"}" },
      { event: "client_event", id: "7", data: "{\"event_type\":\"assistant\"}" },
    ]);
  });

  it("reassembles a message split across chunk boundaries", async () => {
    const messages = await collect(parseSse(chunks("event: client_event\nid: 1\nda", "ta: {\"a\":1}\n\nevent: x\ndata: {}\n\n")));
    expect(messages.map((m) => m.data)).toEqual(["{\"a\":1}", "{}"]);
  });

  it("skips keepalive comments", async () => {
    const messages = await collect(parseSse(chunks(":keepalive\n\nevent: client_event\ndata: {}\n\n")));
    expect(messages).toHaveLength(1);
  });

  it("joins multi-line data fields with newlines, as the SSE spec requires", async () => {
    const messages = await collect(parseSse(chunks("data: line one\ndata: line two\n\n")));
    expect(messages[0].data).toBe("line one\nline two");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/stream.test.ts`
Expected: FAIL — cannot resolve `../src/stream.js`.

- [ ] **Step 3: Write `src/stream.ts`**

```ts
export interface SseMessage {
  event: string | null;
  id: string | null;
  data: string;
}

/** Parses a server-sent event stream out of arbitrary text chunks. */
export async function* parseSse(chunks: AsyncIterable<string>): AsyncGenerator<SseMessage> {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk;
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const message = parseBlock(block);
      if (message) yield message;
      boundary = buffer.indexOf("\n\n");
    }
  }
}

function parseBlock(block: string): SseMessage | null {
  let event: string | null = null;
  let id: string | null = null;
  const data: string[] = [];

  for (const line of block.split("\n")) {
    if (line.startsWith(":") || line.length === 0) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "id") id = value;
    else if (field === "data") data.push(value);
  }

  return data.length > 0 ? { event, id, data: data.join("\n") } : null;
}
```

- [ ] **Step 4: Add `streamEvents` to `src/api.ts`**

Append to the `SessionsApi` class:

```ts
  /**
   * Live events for one session. Resumes from `lastEventId` when given, which
   * is what makes a dropped connection cost a reconnect rather than a missed
   * result.
   */
  async *streamEvents(
    sessionId: string,
    options: { lastEventId?: string; signal: AbortSignal },
  ): AsyncGenerator<{ id: string | null; event: string | null; payload: unknown }> {
    const headers: Record<string, string> = {
      ...(await this.headers()),
      accept: "text/event-stream",
    };
    if (options.lastEventId) headers["last-event-id"] = options.lastEventId;

    const response = await this.fetchImpl(this.url(`/${sessionId}/events/stream`), {
      headers,
      signal: options.signal,
    });
    if (!response.ok || !response.body) {
      throw new ApiError(
        `stream ${sessionId} failed (${response.status})`,
        response.status,
        response.headers.get("request-id"),
      );
    }

    const decoder = new TextDecoder();
    const body = response.body;
    async function* text(): AsyncGenerator<string> {
      for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
        yield decoder.decode(bytes, { stream: true });
      }
    }

    for await (const message of parseSse(text())) {
      let payload: unknown = null;
      try {
        payload = JSON.parse(message.data);
      } catch {
        continue; // a frame we cannot read is not a reason to end the wait
      }
      yield { id: message.id, event: message.event, payload };
    }
  }
```

Add the import at the top of `src/api.ts`:

```ts
import { parseSse } from "./stream.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run`
Expected: all suites pass (proc, discovery, credentials, api, stream).

- [ ] **Step 6: Commit**

```bash
git add src/stream.ts src/api.ts tests/stream.test.ts
git commit -m "feat: read the session event stream with resumable ids"
```

---

### Task 6: Session shaping and read-only tools

**Files:**
- Create: `src/sessions.ts`, `src/tools.ts`
- Test: `tests/sessions.test.ts`, `tests/tools-read.test.ts`

**Interfaces:**
- Consumes: `RawSession`, `RawEvent`, `SessionsApi` (Task 4); `discoverInstances`, `DiscoveryDeps` (Task 2); `SessionSummary` (Task 1).
- Produces: `SERVER_TAG = "mcp:claude-sessions-mcp"`, `toSummary(raw: RawSession): SessionSummary`, `condenseEvents(events: RawEvent[], verbose: boolean): CondensedEvent[]` where `CondensedEvent { at: string | null; kind: string; text: string | null }`; and in `src/tools.ts`: `ToolDeps { api: SessionsApi; discovery: DiscoveryDeps; maxSpawned: number }`, `listInstances(deps)`, `listSessions(deps, args)`, `readSession(deps, args)` — plain async functions the MCP layer wraps in Task 10.

- [ ] **Step 1: Write the failing test for shaping**

```ts
// tests/sessions.test.ts
import { describe, expect, it } from "vitest";
import { SERVER_TAG, condenseEvents, toSummary } from "../src/sessions.js";

describe("toSummary", () => {
  it("names the creator and flags sessions this server made", () => {
    const summary = toSummary({
      id: "s-1", title: "demo", status: "active", status_bucket: "working",
      worker_status: "running", connection_status: "connected",
      environment_id: "env-1", last_event_at: "2026-01-01T00:00:00Z",
      tags: [SERVER_TAG, "spawned-by:alpha"],
    });
    expect(summary.spawnedBy).toBe("alpha");
    expect(summary.createdByThisServer).toBe(true);
  });

  it("tolerates a session with no tags and no title", () => {
    const summary = toSummary({ id: "s-2" });
    expect(summary).toMatchObject({ id: "s-2", title: "", spawnedBy: null, createdByThisServer: false });
  });
});

describe("condenseEvents", () => {
  const events = [
    { event_type: "user", created_at: "t1", payload: { message: { content: "do the thing" } } },
    { event_type: "assistant", created_at: "t2", payload: { message: { content: [{ type: "text", text: "done" }] } } },
    { event_type: "control_request", created_at: "t3", payload: {} },
    { event_type: "env_manager_log", created_at: "t4", payload: {} },
    { event_type: "result", created_at: "t5", payload: { subtype: "success", result: "done" } },
  ];

  it("keeps the conversation and drops the machinery", () => {
    expect(condenseEvents(events, false)).toEqual([
      { at: "t1", kind: "user", text: "do the thing" },
      { at: "t2", kind: "assistant", text: "done" },
      { at: "t5", kind: "result", text: "done" },
    ]);
  });

  it("keeps the machinery when asked", () => {
    expect(condenseEvents(events, true).map((e) => e.kind)).toEqual([
      "user", "assistant", "control_request", "env_manager_log", "result",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sessions.test.ts`
Expected: FAIL — cannot resolve `../src/sessions.js`.

- [ ] **Step 3: Write `src/sessions.ts`**

```ts
import type { RawEvent, RawSession } from "./api.js";
import type { SessionSummary, TurnResult } from "./types.js";

export const SERVER_TAG = "mcp:claude-sessions-mcp";
const SPAWNED_BY = "spawned-by:";

/** Event kinds that describe the machinery rather than the conversation. */
const NOISE = new Set(["control_request", "env_manager_log", "system", "rate_limit_event"]);

export function toSummary(raw: RawSession): SessionSummary {
  const tags = raw.tags ?? [];
  const spawnedBy = tags.find((t) => t.startsWith(SPAWNED_BY))?.slice(SPAWNED_BY.length) ?? null;
  return {
    id: raw.id,
    title: raw.title ?? "",
    status: raw.status ?? "",
    statusBucket: raw.status_bucket ?? "",
    workerStatus: raw.worker_status ?? "",
    connectionStatus: raw.connection_status ?? "",
    environmentId: raw.environment_id ?? "",
    lastEventAt: raw.last_event_at ?? "",
    spawnedBy,
    createdByThisServer: tags.includes(SERVER_TAG),
  };
}

export interface CondensedEvent {
  at: string | null;
  kind: string;
  text: string | null;
}

export function condenseEvents(events: RawEvent[], verbose: boolean): CondensedEvent[] {
  const kept = verbose ? events : events.filter((e) => !NOISE.has(e.event_type ?? ""));
  return kept.map((event) => ({
    at: event.created_at ?? null,
    kind: event.event_type ?? "unknown",
    text: textOf(event),
  }));
}

function textOf(event: RawEvent): string | null {
  const payload = (event.payload ?? {}) as {
    message?: { content?: unknown };
    result?: unknown;
  };
  if (event.event_type === "result") {
    return typeof payload.result === "string" ? payload.result : null;
  }
  const content = payload.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((c): c is { type: string; text: string } =>
        typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text")
      .map((c) => c.text);
    return parts.length > 0 ? parts.join("\n") : null;
  }
  return null;
}

/** Reads the outcome of a turn out of a `result` event's payload. */
export function toTurnResult(payload: Record<string, unknown>): TurnResult {
  return {
    text: typeof payload.result === "string" ? payload.result : "",
    isError: payload.is_error === true,
    stopReason: typeof payload.stop_reason === "string" ? payload.stop_reason : null,
    numTurns: typeof payload.num_turns === "number" ? payload.num_turns : null,
    permissionDenials: Array.isArray(payload.permission_denials) ? payload.permission_denials : [],
    costUsd: typeof payload.total_cost_usd === "number" ? payload.total_cost_usd : null,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sessions.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Write the failing test for the read-only tools**

```ts
// tests/tools-read.test.ts
import { describe, expect, it, vi } from "vitest";
import { listInstances, listSessions, readSession } from "../src/tools.js";
import type { ToolDeps } from "../src/tools.js";

const instance = {
  name: "alpha", cwd: "/srv/alpha", pid: 100, environmentId: "env-1",
  capacity: 8, workers: 2, spawnMode: "same-dir",
};

const raw = (id: string, environmentId: string, tags: string[] = []) => ({
  id, title: id, status: "active", status_bucket: "working", worker_status: "idle",
  connection_status: "connected", environment_id: environmentId,
  last_event_at: "2026-01-01T00:00:00Z", tags,
});

function deps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    api: {
      listSessions: async () => [raw("s-1", "env-1"), raw("s-2", "env-other")],
      listEvents: async () => ({
        events: [{ event_type: "assistant", created_at: "t1", payload: { message: { content: [{ type: "text", text: "hi" }] } } }],
        resumeCursor: "cursor-1",
      }),
    } as unknown as ToolDeps["api"],
    discovery: { proc: { list: async () => [] }, readPointers: async () => [] },
    maxSpawned: 3,
    discover: async () => [instance],
    ...overrides,
  } as ToolDeps;
}

describe("read-only tools", () => {
  it("lists the bridges on this machine", async () => {
    expect(await listInstances(deps())).toEqual({ instances: [instance] });
  });

  it("filters sessions to the named instance, since the API ignores that filter", async () => {
    const result = await listSessions(deps(), { instance: "alpha" });
    expect(result.sessions.map((s) => s.id)).toEqual(["s-1"]);
  });

  it("refuses an unknown instance by name", async () => {
    await expect(listSessions(deps(), { instance: "ghost" })).rejects.toThrow(/ghost/);
  });

  it("returns every environment's sessions when no instance is named", async () => {
    const result = await listSessions(deps(), {});
    expect(result.sessions).toHaveLength(2);
  });

  it("condenses events and passes the cursor back", async () => {
    const result = await readSession(deps(), { session_id: "s-1" });
    expect(result.events).toEqual([{ at: "t1", kind: "assistant", text: "hi" }]);
    expect(result.cursor).toBe("cursor-1");
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run tests/tools-read.test.ts`
Expected: FAIL — cannot resolve `../src/tools.js`.

- [ ] **Step 7: Write `src/tools.ts` (read-only half)**

```ts
import type { SessionsApi } from "./api.js";
import { discoverInstances, type DiscoveryDeps } from "./discovery.js";
import { condenseEvents, toSummary } from "./sessions.js";
import type { BridgeInstance } from "./types.js";

export interface ToolDeps {
  api: SessionsApi;
  discovery: DiscoveryDeps;
  maxSpawned: number;
  /** Seam for tests; production passes discoverInstances over `discovery`. */
  discover?: (deps: DiscoveryDeps) => Promise<BridgeInstance[]>;
}

async function instances(deps: ToolDeps): Promise<BridgeInstance[]> {
  return (deps.discover ?? discoverInstances)(deps.discovery);
}

export async function requireInstance(deps: ToolDeps, name: string): Promise<BridgeInstance> {
  const found = await instances(deps);
  const match = found.find((i) => i.name === name);
  if (!match) {
    const known = found.map((i) => i.name).join(", ") || "none";
    throw new Error(`No running bridge named "${name}" on this machine. Running: ${known}.`);
  }
  return match;
}

export async function listInstances(deps: ToolDeps): Promise<{ instances: BridgeInstance[] }> {
  return { instances: await instances(deps) };
}

export async function listSessions(
  deps: ToolDeps,
  args: { instance?: string },
): Promise<{ sessions: ReturnType<typeof toSummary>[] }> {
  const sessions = await deps.api.listSessions();
  if (!args.instance) return { sessions: sessions.map(toSummary) };

  const bridge = await requireInstance(deps, args.instance);
  return {
    sessions: sessions
      .filter((s) => s.environment_id === bridge.environmentId)
      .map(toSummary),
  };
}

export async function readSession(
  deps: ToolDeps,
  args: { session_id: string; limit?: number; cursor?: string; verbose?: boolean },
): Promise<{ events: ReturnType<typeof condenseEvents>; cursor: string | null }> {
  const { events, resumeCursor } = await deps.api.listEvents(args.session_id, {
    limit: args.limit,
    cursor: args.cursor,
  });
  return { events: condenseEvents(events, args.verbose === true), cursor: resumeCursor };
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run`
Expected: all suites pass.

- [ ] **Step 9: Commit**

```bash
git add src/sessions.ts src/tools.ts tests/sessions.test.ts tests/tools-read.test.ts
git commit -m "feat: shape sessions and events, add the read-only tools"
```

---

### Task 7: Spawning, with the safety rails

**Files:**
- Modify: `src/tools.ts`
- Test: `tests/tools-spawn.test.ts`

**Interfaces:**
- Consumes: `ToolDeps`, `requireInstance` (Task 6); `SessionsApi.createSession`, `postUserMessage` (Task 4); `SERVER_TAG` (Task 6).
- Produces: `ALLOWED_PERMISSION_MODES: readonly string[]`, `spawnSession(deps, args): Promise<{ session_id: string; instance: string; title: string }>`, `sendMessage(deps, args): Promise<{ delivered: true }>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/tools-spawn.test.ts
import { describe, expect, it, vi } from "vitest";
import { sendMessage, spawnSession } from "../src/tools.js";
import type { ToolDeps } from "../src/tools.js";
import { SERVER_TAG } from "../src/sessions.js";

const instance = {
  name: "alpha", cwd: "/srv/alpha", pid: 100, environmentId: "env-1",
  capacity: 8, workers: 2, spawnMode: "same-dir",
};

function deps(overrides: {
  existing?: { environment_id: string; status: string; tags: string[] }[];
  instance?: typeof instance;
  maxSpawned?: number;
} = {}) {
  const createSession = vi.fn(async () => ({ id: "s-new" }));
  const postUserMessage = vi.fn(async () => undefined);
  const toolDeps = {
    api: {
      createSession,
      postUserMessage,
      listSessions: async () => overrides.existing ?? [],
    },
    discovery: { proc: { list: async () => [] }, readPointers: async () => [] },
    maxSpawned: overrides.maxSpawned ?? 3,
    discover: async () => [overrides.instance ?? instance],
  } as unknown as ToolDeps;
  return { toolDeps, createSession, postUserMessage };
}

const spawned = (n: number) =>
  Array.from({ length: n }, () => ({ environment_id: "env-1", status: "active", tags: [SERVER_TAG] }));

describe("spawn_session", () => {
  it("creates a tagged session and posts the prompt", async () => {
    const { toolDeps, createSession, postUserMessage } = deps();

    const result = await spawnSession(toolDeps, {
      instance: "alpha", prompt: "review the diff", caller: "alpha-prime",
    });

    expect(result.session_id).toBe("s-new");
    expect(createSession).toHaveBeenCalledWith({
      environmentId: "env-1",
      title: "review the diff",
      tags: [SERVER_TAG, "spawned-by:alpha-prime"],
      effort: "medium",
      permissionMode: "auto",
    });
    expect(postUserMessage).toHaveBeenCalledWith("s-new", "review the diff");
  });

  it("rejects bypassPermissions instead of downgrading it", async () => {
    const { toolDeps, createSession } = deps();
    await expect(spawnSession(toolDeps, {
      instance: "alpha", prompt: "p", permission_mode: "bypassPermissions",
    })).rejects.toThrow(/bypassPermissions/);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("refuses an environment that is not a live local bridge", async () => {
    const { toolDeps } = deps();
    await expect(spawnSession(toolDeps, { instance: "elsewhere", prompt: "p" }))
      .rejects.toThrow(/elsewhere/);
  });

  it("refuses when the bridge is full, which would otherwise look like a hang", async () => {
    const { toolDeps, createSession } = deps({ instance: { ...instance, workers: 8, capacity: 8 } });
    await expect(spawnSession(toolDeps, { instance: "alpha", prompt: "p" }))
      .rejects.toThrow(/capacity/i);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("refuses once its own ceiling is reached", async () => {
    const { toolDeps, createSession } = deps({ existing: spawned(3), maxSpawned: 3 });
    await expect(spawnSession(toolDeps, { instance: "alpha", prompt: "p" }))
      .rejects.toThrow(/ceiling/i);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("counts only its own live sessions towards the ceiling", async () => {
    const { toolDeps, createSession } = deps({
      existing: [
        ...spawned(2),
        { environment_id: "env-1", status: "archived", tags: [SERVER_TAG] },
        { environment_id: "env-1", status: "active", tags: [] },
        { environment_id: "env-other", status: "active", tags: [SERVER_TAG] },
      ],
      maxSpawned: 3,
    });
    await spawnSession(toolDeps, { instance: "alpha", prompt: "p" });
    expect(createSession).toHaveBeenCalledOnce();
  });

  it("truncates a long prompt when deriving the title", async () => {
    const { toolDeps, createSession } = deps();
    await spawnSession(toolDeps, { instance: "alpha", prompt: "x".repeat(200) });
    expect(createSession.mock.calls[0][0].title).toHaveLength(60);
  });
});

describe("send_message", () => {
  it("delivers text to a session", async () => {
    const { toolDeps, postUserMessage } = deps();
    expect(await sendMessage(toolDeps, { session_id: "s-1", text: "ping" })).toEqual({ delivered: true });
    expect(postUserMessage).toHaveBeenCalledWith("s-1", "ping");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools-spawn.test.ts`
Expected: FAIL — `spawnSession` is not exported.

- [ ] **Step 3: Extend `src/tools.ts`**

Add to the imports: `import { SERVER_TAG, toSummary } from "./sessions.js";` (replacing the existing `sessions.js` import line), then append:

```ts
export const ALLOWED_PERMISSION_MODES = [
  "auto", "acceptEdits", "plan", "manual", "dontAsk",
] as const;

const DEFAULT_EFFORT = "medium";
const TITLE_LIMIT = 60;

export async function spawnSession(
  deps: ToolDeps,
  args: {
    instance: string;
    prompt: string;
    title?: string;
    effort?: string;
    permission_mode?: string;
    caller?: string;
  },
): Promise<{ session_id: string; instance: string; title: string }> {
  const mode = args.permission_mode ?? "auto";
  if (!ALLOWED_PERMISSION_MODES.includes(mode as (typeof ALLOWED_PERMISSION_MODES)[number])) {
    throw new Error(
      `permission_mode "${mode}" is not allowed here. ` +
      `Use one of: ${ALLOWED_PERMISSION_MODES.join(", ")}. ` +
      "bypassPermissions is refused so that a spawned session cannot exceed the permissions of the one that asked for it.",
    );
  }

  const bridge = await requireInstance(deps, args.instance);
  if (bridge.workers >= bridge.capacity) {
    throw new Error(
      `Bridge "${bridge.name}" is at capacity (${bridge.workers}/${bridge.capacity}). ` +
      "A session created now would be accepted and never run.",
    );
  }

  const existing = await deps.api.listSessions();
  const mine = existing.filter((s) =>
    s.environment_id === bridge.environmentId &&
    s.status === "active" &&
    (s.tags ?? []).includes(SERVER_TAG));
  if (mine.length >= deps.maxSpawned) {
    throw new Error(
      `Spawn ceiling reached: ${mine.length} of ${deps.maxSpawned} sessions in "${bridge.name}" ` +
      "were created by this server. Delete or archive one first.",
    );
  }

  const title = (args.title ?? args.prompt).slice(0, TITLE_LIMIT);
  const caller = args.caller ?? "unknown";
  const created = await deps.api.createSession({
    environmentId: bridge.environmentId,
    title,
    tags: [SERVER_TAG, `spawned-by:${caller}`],
    effort: args.effort ?? DEFAULT_EFFORT,
    permissionMode: mode,
  });

  await deps.api.postUserMessage(created.id, args.prompt);
  return { session_id: created.id, instance: bridge.name, title };
}

export async function sendMessage(
  deps: ToolDeps,
  args: { session_id: string; text: string },
): Promise<{ delivered: true }> {
  await deps.api.postUserMessage(args.session_id, args.text);
  return { delivered: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: all suites pass, 8 new cases among them.

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts tests/tools-spawn.test.ts
git commit -m "feat: spawn sessions behind the permission, capacity and ceiling rails"
```

---

### Task 8: Waiting for a turn to finish

**Files:**
- Modify: `src/tools.ts`
- Test: `tests/tools-wait.test.ts`

**Interfaces:**
- Consumes: `SessionsApi.streamEvents` (Task 5), `toTurnResult` (Task 6).
- Produces: `waitForIdle(deps, args): Promise<{ finished: boolean; result?: TurnResult; note?: string }>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/tools-wait.test.ts
import { describe, expect, it, vi } from "vitest";
import { waitForIdle } from "../src/tools.js";
import type { ToolDeps } from "../src/tools.js";

const resultEvent = {
  id: "12", event: "client_event",
  payload: {
    event_type: "result",
    payload: {
      subtype: "success", is_error: false, result: "done", num_turns: 1,
      stop_reason: "end_turn", permission_denials: [], total_cost_usd: 0.25,
    },
  },
};

function depsWithStream(
  frames: unknown[][],
): { toolDeps: ToolDeps; streamEvents: ReturnType<typeof vi.fn> } {
  let call = 0;
  const streamEvents = vi.fn(async function* (_id: string, _opts: { lastEventId?: string }) {
    for (const frame of frames[call] ?? []) yield frame;
    call++;
  });
  return {
    toolDeps: { api: { streamEvents }, discovery: {}, maxSpawned: 3 } as unknown as ToolDeps,
    streamEvents,
  };
}

describe("wait_for_idle", () => {
  it("returns the turn's result", async () => {
    const { toolDeps } = depsWithStream([[
      { id: "11", event: "client_event", payload: { event_type: "assistant", payload: {} } },
      resultEvent,
    ]]);

    const outcome = await waitForIdle(toolDeps, { session_id: "s-1", timeout_s: 5 });

    expect(outcome.finished).toBe(true);
    expect(outcome.result).toEqual({
      text: "done", isError: false, stopReason: "end_turn",
      numTurns: 1, permissionDenials: [], costUsd: 0.25,
    });
  });

  it("reconnects from the last seen id when the stream ends early", async () => {
    const { toolDeps, streamEvents } = depsWithStream([
      [{ id: "5", event: "client_event", payload: { event_type: "assistant", payload: {} } }],
      [resultEvent],
    ]);

    const outcome = await waitForIdle(toolDeps, { session_id: "s-1", timeout_s: 5 });

    expect(outcome.finished).toBe(true);
    expect(streamEvents.mock.calls[1][1]).toMatchObject({ lastEventId: "5" });
  });

  it("says the session is still working when the timeout expires", async () => {
    const { toolDeps } = depsWithStream([[], [], []]);
    const outcome = await waitForIdle(toolDeps, { session_id: "s-1", timeout_s: 0 });
    expect(outcome).toMatchObject({ finished: false });
    expect(outcome.note).toMatch(/still working/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools-wait.test.ts`
Expected: FAIL — `waitForIdle` is not exported.

- [ ] **Step 3: Extend `src/tools.ts`**

Add `toTurnResult` to the `sessions.js` import, then append:

```ts
import type { TurnResult } from "./types.js";

/**
 * Waits for the session's current turn to finish, on the event stream rather
 * than by polling. A stream that ends before the result arrives is reopened
 * from the last event id, so a dropped connection costs a reconnect rather
 * than the answer.
 */
export async function waitForIdle(
  deps: ToolDeps,
  args: { session_id: string; timeout_s?: number },
): Promise<{ finished: boolean; result?: TurnResult; note?: string }> {
  const timeoutMs = (args.timeout_s ?? 300) * 1000;
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let lastEventId: string | undefined;

  try {
    while (Date.now() < deadline) {
      try {
        for await (const frame of deps.api.streamEvents(args.session_id, {
          lastEventId,
          signal: controller.signal,
        })) {
          if (frame.id) lastEventId = frame.id;
          const payload = frame.payload as { event_type?: string; payload?: Record<string, unknown> };
          if (payload?.event_type === "result" && payload.payload) {
            return { finished: true, result: toTurnResult(payload.payload) };
          }
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        throw error;
      }
    }
    return {
      finished: false,
      note: `No result within ${args.timeout_s ?? 300}s — the session is still working. ` +
        "Call again to keep waiting, or read_session to see where it is.",
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: all suites pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts tests/tools-wait.test.ts
git commit -m "feat: wait for a turn's result on the event stream"
```

---

### Task 9: Lifecycle tools

**Files:**
- Modify: `src/tools.ts`
- Test: `tests/tools-lifecycle.test.ts`

**Interfaces:**
- Consumes: `SessionsApi.archiveSession`, `unarchiveSession`, `deleteSession` (Task 4).
- Produces: `archiveSession(deps, args)`, `unarchiveSession(deps, args)`, `deleteSession(deps, args)` — each returning the shaped session plus, for unarchive, an explicit note.

- [ ] **Step 1: Write the failing test**

```ts
// tests/tools-lifecycle.test.ts
import { describe, expect, it, vi } from "vitest";
import { archiveSession, deleteSession, unarchiveSession } from "../src/tools.js";
import type { ToolDeps } from "../src/tools.js";

const raw = (status: string) => ({
  id: "s-1", title: "demo", status, status_bucket: status === "archived" ? "completed" : "working",
  worker_status: "idle", connection_status: "disconnected", environment_id: "env-1",
  last_event_at: "2026-01-01T00:00:00Z", tags: [],
});

function deps() {
  const api = {
    archiveSession: vi.fn(async () => raw("archived")),
    unarchiveSession: vi.fn(async () => raw("active")),
    deleteSession: vi.fn(async () => undefined),
  };
  return { toolDeps: { api, discovery: {}, maxSpawned: 3 } as unknown as ToolDeps, api };
}

describe("lifecycle tools", () => {
  it("archives and reports the new status", async () => {
    const { toolDeps, api } = deps();
    const result = await archiveSession(toolDeps, { session_id: "s-1" });
    expect(api.archiveSession).toHaveBeenCalledWith("s-1");
    expect(result.session.status).toBe("archived");
  });

  it("unarchives and says plainly that no worker was started", async () => {
    const { toolDeps } = deps();
    const result = await unarchiveSession(toolDeps, { session_id: "s-1" });
    expect(result.session.status).toBe("active");
    expect(result.note).toMatch(/does not restart the worker/i);
  });

  it("deletes", async () => {
    const { toolDeps, api } = deps();
    expect(await deleteSession(toolDeps, { session_id: "s-1" })).toEqual({ deleted: true });
    expect(api.deleteSession).toHaveBeenCalledWith("s-1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools-lifecycle.test.ts`
Expected: FAIL — those functions are not exported.

- [ ] **Step 3: Extend `src/tools.ts`**

```ts
export async function archiveSession(
  deps: ToolDeps,
  args: { session_id: string },
): Promise<{ session: ReturnType<typeof toSummary> }> {
  return { session: toSummary(await deps.api.archiveSession(args.session_id)) };
}

export async function unarchiveSession(
  deps: ToolDeps,
  args: { session_id: string },
): Promise<{ session: ReturnType<typeof toSummary>; note: string }> {
  return {
    session: toSummary(await deps.api.unarchiveSession(args.session_id)),
    note: "The session is active again, but this does not restart the worker: " +
      "messages sent now are stored and not executed until a client opens the session.",
  };
}

export async function deleteSession(
  deps: ToolDeps,
  args: { session_id: string },
): Promise<{ deleted: true }> {
  await deps.api.deleteSession(args.session_id);
  return { deleted: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: all suites pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts tests/tools-lifecycle.test.ts
git commit -m "feat: archive, unarchive and delete sessions"
```

---

### Task 10: MCP server, deployment and the end-to-end check

**Files:**
- Create: `src/server.ts`, `deploy/claude-sessions-mcp.service`, `scripts/e2e.mjs`
- Modify: `README.md`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: every tool function from Tasks 6–9; `SessionsApi` (Task 4); `createTokenReader` (Task 3); `defaultDiscoveryDeps` (Task 2).
- Produces: `buildServer(deps: ToolDeps): McpServer`, `loadConfig(env: NodeJS.ProcessEnv): ServerConfig` where `ServerConfig { port: number; host: string; credentialsPath: string; claudeConfigDir: string; maxSpawned: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/server.test.ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server.js";

describe("loadConfig", () => {
  it("defaults to the loopback interface and a spawn ceiling of three", () => {
    const config = loadConfig({ HOME: "/home/example" } as NodeJS.ProcessEnv);
    expect(config).toMatchObject({ host: "127.0.0.1", port: 8765, maxSpawned: 3 });
    expect(config.credentialsPath).toBe("/home/example/.claude/.credentials.json");
    expect(config.claudeConfigDir).toBe("/home/example/.claude");
  });

  it("takes overrides from the environment", () => {
    const config = loadConfig({
      HOME: "/home/example", PORT: "9000",
      CLAUDE_SESSIONS_MCP_MAX_SPAWNED: "5",
      CLAUDE_CONFIG_DIR: "/etc/claude",
    } as NodeJS.ProcessEnv);
    expect(config).toMatchObject({ port: 9000, maxSpawned: 5, claudeConfigDir: "/etc/claude" });
  });

  it("refuses to bind anything but the loopback", () => {
    expect(() => loadConfig({ HOME: "/home/example", HOST: "0.0.0.0" } as NodeJS.ProcessEnv))
      .toThrow(/loopback/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — cannot resolve `../src/server.js`.

- [ ] **Step 3: Write `src/server.ts`**

```ts
import { createServer } from "node:http";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { SessionsApi } from "./api.js";
import { createTokenReader } from "./credentials.js";
import { defaultDiscoveryDeps } from "./discovery.js";
import {
  ALLOWED_PERMISSION_MODES, archiveSession, deleteSession, listInstances, listSessions,
  readSession, sendMessage, spawnSession, unarchiveSession, waitForIdle, type ToolDeps,
} from "./tools.js";

export interface ServerConfig {
  port: number;
  host: string;
  credentialsPath: string;
  claudeConfigDir: string;
  maxSpawned: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const home = env.HOME ?? "";
  const host = env.HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(
      `Refusing to bind ${host}: this server spawns agents and is meant for the loopback interface only.`,
    );
  }
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  return {
    host,
    port: Number(env.PORT ?? 8765),
    credentialsPath: env.CLAUDE_CREDENTIALS_PATH ?? join(claudeConfigDir, ".credentials.json"),
    claudeConfigDir,
    maxSpawned: Number(env.CLAUDE_SESSIONS_MCP_MAX_SPAWNED ?? 3),
  };
}

const asJson = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

export function buildServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: "claude-sessions-mcp", version: "0.1.0" });

  server.registerTool("list_instances", {
    description: "Remote Control bridges running on this machine, with their environment ids and how many workers each has in use.",
    inputSchema: {},
  }, async () => asJson(await listInstances(deps)));

  server.registerTool("list_sessions", {
    description: "Sessions of one bridge, or of every bridge when no instance is named.",
    inputSchema: { instance: z.string().optional() },
  }, async (args) => asJson(await listSessions(deps, args)));

  server.registerTool("spawn_session", {
    description:
      "Start a new Claude Code session inside a running bridge and give it a first prompt. " +
      "The session belongs to that bridge: its worker runs under the bridge process and it " +
      "appears in the session list like any other. Effort defaults to medium; " +
      `permission_mode is one of ${ALLOWED_PERMISSION_MODES.join(", ")} (bypassPermissions is refused).`,
    inputSchema: {
      instance: z.string(),
      prompt: z.string(),
      title: z.string().optional(),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      permission_mode: z.string().optional(),
      caller: z.string().optional().describe("Who is asking, recorded on the session as spawned-by"),
    },
  }, async (args) => asJson(await spawnSession(deps, args)));

  server.registerTool("send_message", {
    description: "Send a message to a live session, as if typed by its user.",
    inputSchema: { session_id: z.string(), text: z.string() },
  }, async (args) => asJson(await sendMessage(deps, args)));

  server.registerTool("read_session", {
    description: "Recent events of a session, condensed to the conversation. Pass verbose for the machinery, cursor to continue.",
    inputSchema: {
      session_id: z.string(),
      limit: z.number().int().positive().max(200).optional(),
      cursor: z.string().optional(),
      verbose: z.boolean().optional(),
    },
  }, async (args) => asJson(await readSession(deps, args)));

  server.registerTool("wait_for_idle", {
    description: "Wait on the session's event stream until its current turn finishes, then return the answer, stop reason, permission denials and cost.",
    inputSchema: { session_id: z.string(), timeout_s: z.number().int().positive().max(3600).optional() },
  }, async (args) => asJson(await waitForIdle(deps, args)));

  server.registerTool("archive_session", {
    description: "Stop a session and free its slot on the bridge, keeping its history.",
    inputSchema: { session_id: z.string() },
  }, async (args) => asJson(await archiveSession(deps, args)));

  server.registerTool("unarchive_session", {
    description: "Return an archived session to active. This does NOT restart its worker — a client has to open the session for it to run again.",
    inputSchema: { session_id: z.string() },
  }, async (args) => asJson(await unarchiveSession(deps, args)));

  server.registerTool("delete_session", {
    description: "Delete a session and stop its worker.",
    inputSchema: { session_id: z.string() },
  }, async (args) => asJson(await deleteSession(deps, args)));

  return server;
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const token = createTokenReader(config.credentialsPath);
  const deps: ToolDeps = {
    api: new SessionsApi({ token }),
    discovery: defaultDiscoveryDeps(config.claudeConfigDir),
    maxSpawned: config.maxSpawned,
  };

  const server = buildServer(deps);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  createServer((req, res) => {
    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404).end();
      return;
    }
    void transport.handleRequest(req, res);
  }).listen(config.port, config.host, () => {
    console.log(`claude-sessions-mcp listening on http://${config.host}:${config.port}/mcp`);
  });
}

if (process.argv[1]?.endsWith("server.js")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/server.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Build and start it by hand**

Run: `npm run build && node dist/server.js`
Expected: `claude-sessions-mcp listening on http://127.0.0.1:8765/mcp`. Leave it running for the next step.

- [ ] **Step 6: Write the end-to-end script**

`scripts/e2e.mjs` — run by hand against a real bridge, never in CI:

```js
// Usage: node scripts/e2e.mjs <instance-name>
// Spawns a session in a running bridge, waits for its answer, deletes it.
import { SessionsApi } from "../dist/api.js";
import { createTokenReader } from "../dist/credentials.js";
import { defaultDiscoveryDeps } from "../dist/discovery.js";
import { deleteSession, spawnSession, waitForIdle } from "../dist/tools.js";
import { join } from "node:path";

const instance = process.argv[2];
if (!instance) {
  console.error("usage: node scripts/e2e.mjs <instance-name>");
  process.exit(2);
}

const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME, ".claude");
const deps = {
  api: new SessionsApi({ token: createTokenReader(join(claudeConfigDir, ".credentials.json")) }),
  discovery: defaultDiscoveryDeps(claudeConfigDir),
  maxSpawned: 3,
};

const spawned = await spawnSession(deps, {
  instance,
  prompt: "Reply with the single word E2E_OK and stop. Do not use tools.",
  title: "claude-sessions-mcp e2e",
  effort: "low",
  caller: "e2e",
});
console.log("spawned", spawned.session_id);

const outcome = await waitForIdle(deps, { session_id: spawned.session_id, timeout_s: 180 });
console.log("outcome", JSON.stringify(outcome, null, 2));

await deleteSession(deps, { session_id: spawned.session_id });
console.log("deleted");

if (!outcome.finished || !outcome.result?.text.includes("E2E_OK")) process.exit(1);
```

- [ ] **Step 7: Run the end-to-end check against a real bridge**

Run: `node scripts/e2e.mjs <name of a bridge from list_instances>`
Expected: prints a session id, an outcome whose `result.text` contains `E2E_OK`, then `deleted`. Confirm the session is gone from the session list and the bridge's worker count is back where it started.

- [ ] **Step 8: Write the systemd unit**

`deploy/claude-sessions-mcp.service`:

```ini
[Unit]
Description=claude-sessions-mcp
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/claude-sessions-mcp
ExecStart=/usr/bin/node %h/claude-sessions-mcp/dist/server.js
Environment=PORT=8765
# Raise if one caller legitimately needs more helpers at once.
Environment=CLAUDE_SESSIONS_MCP_MAX_SPAWNED=3
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=default.target
```

- [ ] **Step 9: Document installation in `README.md`**

Replace the "Status" line with a Usage section covering: `npm install && npm run build`; copying the unit to `~/.config/systemd/user/`, adjusting `WorkingDirectory` and `ExecStart` to where the repository lives, then `systemctl --user enable --now claude-sessions-mcp`; registering it with `claude mcp add --transport http --scope user sessions http://127.0.0.1:8765/mcp`; and the environment variables `PORT`, `CLAUDE_SESSIONS_MCP_MAX_SPAWNED`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CREDENTIALS_PATH`. State the Linux requirement (`/proc`) and that the server must run as the same user as the bridges, since it reads their process table and the credentials file.

- [ ] **Step 10: Commit**

```bash
git add src/server.ts tests/server.test.ts deploy/claude-sessions-mcp.service scripts/e2e.mjs README.md
git commit -m "feat: serve the tools over streamable-HTTP on the loopback"
```

---

## Self-Review

**Spec coverage:** discovery (Tasks 1–2), credentials (Task 3), REST surface (Task 4), stream (Task 5), all nine tools (Tasks 6–9 for the logic, Task 10 for registration and descriptions), four safety rails (Task 7 for permission mode, capacity and ceiling; `caller` attribution in the same task), deployment and testing (Task 10). The `unarchive` caveat appears in both the tool's return value (Task 9) and its description (Task 10).

**Type consistency:** `ToolDeps` is introduced in Task 6 and extended nowhere; `toSummary` / `condenseEvents` / `toTurnResult` keep the names they are given in Task 6; `SessionsApi` method names are fixed in Task 4 and used unchanged in Tasks 6–9; `SERVER_TAG` is defined once in `sessions.ts` and imported by `tools.ts` and the spawn tests.

**Known seam:** `ToolDeps.discover` exists so tests can supply instances without a fake `/proc`; production leaves it undefined and `discoverInstances` is used.
