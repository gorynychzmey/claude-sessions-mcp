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
