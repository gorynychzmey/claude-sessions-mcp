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
