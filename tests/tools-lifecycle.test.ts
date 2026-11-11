import { describe, expect, it, vi } from "vitest";
import { archiveSession, deleteSession, unarchiveSession } from "../src/tools.js";
import type { ToolDeps } from "../src/tools.js";
import { SERVER_TAG } from "../src/sessions.js";
import { memoryRegistry } from "../src/registry.js";

const raw = (status: string, tags: string[] = []) => ({
  id: "s-1", title: "demo", status, status_bucket: status === "archived" ? "completed" : "working",
  worker_status: "idle", connection_status: "disconnected", environment_id: "env-1",
  last_event_at: "2026-01-01T00:00:00Z", tags,
});

function deps(tags: string[] = []) {
  const api = {
    archiveSession: vi.fn(async () => raw("archived", tags)),
    unarchiveSession: vi.fn(async () => raw("active", tags)),
    deleteSession: vi.fn(async () => undefined),
  };
  const registry = memoryRegistry();
  return { toolDeps: { api, discovery: {}, maxSpawned: 3, registry } as unknown as ToolDeps, api, registry };
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

  it("puts an unarchived session of its own back into the spawn registry", async () => {
    const { toolDeps, registry } = deps([SERVER_TAG]);
    await unarchiveSession(toolDeps, { session_id: "s-1" });
    expect(await registry.list()).toEqual(["s-1"]);
  });

  it("leaves the registry alone when someone else's session is unarchived", async () => {
    const { toolDeps, registry } = deps(["other"]);
    await unarchiveSession(toolDeps, { session_id: "s-1" });
    expect(await registry.list()).toEqual([]);
  });

  it("deletes", async () => {
    const { toolDeps, api } = deps();
    expect(await deleteSession(toolDeps, { session_id: "s-1" })).toEqual({ deleted: true });
    expect(api.deleteSession).toHaveBeenCalledWith("s-1");
  });
});
