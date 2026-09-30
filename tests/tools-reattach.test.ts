import { describe, expect, it, vi } from "vitest";
import { reattachSessions, sendMessage } from "../src/tools.js";
import type { ToolDeps } from "../src/tools.js";

const bridge = {
  name: "alpha", cwd: "/srv/alpha", pid: 1, environmentId: "env-1",
  capacity: 8, workers: 0, spawnMode: "same-dir",
};

const session = (id: string, over: Record<string, string> = {}) => ({
  id, title: id, status: "active", status_bucket: "idle", worker_status: "idle",
  connection_status: "disconnected", environment_id: "env-1", tags: [], ...over,
});

function deps(sessions: ReturnType<typeof session>[], opts: { reconnectFails?: string[] } = {}) {
  const reconnectSession = vi.fn(async (_env: string, id: string) => {
    if (opts.reconnectFails?.includes(id)) throw new Error(`reconnect ${id} failed (400)`);
  });
  const postUserMessage = vi.fn(async () => {});
  const getSession = vi.fn(async (id: string) => sessions.find((s) => s.id === id) ?? session(id));
  const listSessions = vi.fn(async () => sessions);
  const toolDeps = {
    api: { reconnectSession, postUserMessage, getSession, listSessions },
    discovery: {}, maxSpawned: 6,
    discover: async () => [bridge],
  } as unknown as ToolDeps;
  return { toolDeps, reconnectSession, postUserMessage };
}

describe("reattach", () => {
  it("reconnects only this bridge's active sessions that have no worker attached", async () => {
    const { toolDeps, reconnectSession } = deps([
      session("cse_idle"),
      session("cse_live", { connection_status: "connected" }),
      session("cse_old", { status: "archived" }),
      session("cse_other", { environment_id: "env-2" }),
    ]);

    const result = await reattachSessions(toolDeps, { instance: "alpha" });

    expect(reconnectSession).toHaveBeenCalledTimes(1);
    expect(reconnectSession).toHaveBeenCalledWith("env-1", "cse_idle");
    expect(result).toEqual({ instance: "alpha", environmentId: "env-1", reattached: ["cse_idle"], failed: [] });
  });

  it("keeps going past a session that fails and reports it", async () => {
    const { toolDeps } = deps([session("cse_a"), session("cse_b")], { reconnectFails: ["cse_a"] });

    const result = await reattachSessions(toolDeps, { instance: "alpha" });

    expect(result.reattached).toEqual(["cse_b"]);
    expect(result.failed).toEqual([{ session_id: "cse_a", error: "reconnect cse_a failed (400)" }]);
  });
});

describe("send_message", () => {
  it("delivers text and leaves a session with a worker alone", async () => {
    const { toolDeps, postUserMessage, reconnectSession } = deps([
      session("s-1", { connection_status: "connected" }),
    ]);
    expect(await sendMessage(toolDeps, { session_id: "s-1", text: "ping" }))
      .toEqual({ delivered: true, reattached: false });
    expect(postUserMessage).toHaveBeenCalledWith("s-1", "ping");
    expect(reconnectSession).not.toHaveBeenCalled();
  });

  it("wakes a detached session, since a message alone never gets it a worker", async () => {
    const { toolDeps, reconnectSession } = deps([session("s-1")]);
    expect(await sendMessage(toolDeps, { session_id: "s-1", text: "ping" }))
      .toEqual({ delivered: true, reattached: true });
    expect(reconnectSession).toHaveBeenCalledWith("env-1", "s-1");
  });

  it("does not try to wake an archived session", async () => {
    const { toolDeps, reconnectSession } = deps([session("s-1", { status: "archived" })]);
    expect(await sendMessage(toolDeps, { session_id: "s-1", text: "ping" }))
      .toEqual({ delivered: true, reattached: false });
    expect(reconnectSession).not.toHaveBeenCalled();
  });
});
