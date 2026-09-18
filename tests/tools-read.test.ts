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
