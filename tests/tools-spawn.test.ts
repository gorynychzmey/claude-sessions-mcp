import { describe, expect, it, vi } from "vitest";
import { sendMessage, spawnSession } from "../src/tools.js";
import type { ToolDeps } from "../src/tools.js";
import { SERVER_TAG } from "../src/sessions.js";

const instance = {
  name: "alpha", cwd: "/srv/alpha", pid: 100, environmentId: "env-1",
  capacity: 8, workers: 2, spawnMode: "same-dir",
};

type FakeSession = { environment_id: string; status: string; tags: string[] };

function deps(overrides: {
  existing?: FakeSession[];
  /** Pages the session list hands back, in order; each page but the last carries a cursor. */
  pages?: FakeSession[][];
  endless?: boolean;
  instances?: typeof instance[];
  instance?: typeof instance;
  maxSpawned?: number;
  postFails?: Error;
  deleteFails?: Error;
} = {}) {
  const createSession = vi.fn(async () => ({ id: "s-new" }));
  const postUserMessage = vi.fn(async () => {
    if (overrides.postFails) throw overrides.postFails;
  });
  const deleteSession = vi.fn(async () => {
    if (overrides.deleteFails) throw overrides.deleteFails;
  });
  const pages = overrides.pages ?? [overrides.existing ?? []];
  const listSessionsPage = vi.fn(async ({ cursor }: { cursor?: string } = {}) => {
    const index = cursor ? Number(cursor) : 0;
    const last = index >= pages.length - 1;
    return {
      sessions: pages[index] ?? [],
      nextCursor: overrides.endless || !last ? String(index + 1) : null,
    };
  });
  const toolDeps = {
    api: { createSession, postUserMessage, deleteSession, listSessionsPage },
    discovery: { proc: { list: async () => [] }, readPointers: async () => [] },
    maxSpawned: overrides.maxSpawned ?? 3,
    discover: async () => overrides.instances ?? [overrides.instance ?? instance],
  } as unknown as ToolDeps;
  return { toolDeps, createSession, postUserMessage, deleteSession, listSessionsPage };
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
    const { toolDeps, createSession } = deps();
    await expect(spawnSession(toolDeps, { instance: "elsewhere", prompt: "p" }))
      .rejects.toThrow(/elsewhere/);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("refuses an ambiguous instance name instead of picking the first match", async () => {
    const { toolDeps, createSession } = deps({
      instances: [
        instance,
        { ...instance, pid: 200, cwd: "/srv/alpha-worktree", environmentId: "env-2" },
      ],
    });

    await expect(spawnSession(toolDeps, { instance: "alpha", prompt: "p" }))
      .rejects.toThrow(/matches 2 running bridges.*\/srv\/alpha.*\/srv\/alpha-worktree/s);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("counts its own sessions across every page of the session list", async () => {
    const { toolDeps, createSession, listSessionsPage } = deps({
      pages: [
        Array.from({ length: 100 }, () => ({ environment_id: "env-other", status: "active", tags: [] })),
        spawned(3),
      ],
      maxSpawned: 3,
    });

    await expect(spawnSession(toolDeps, { instance: "alpha", prompt: "p" }))
      .rejects.toThrow(/ceiling/i);
    expect(listSessionsPage).toHaveBeenCalledTimes(2);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("fails closed when the session list never ends, rather than spawning on a partial count", async () => {
    const { toolDeps, createSession } = deps({ endless: true });

    await expect(spawnSession(toolDeps, { instance: "alpha", prompt: "p" }))
      .rejects.toThrow(/cannot be counted completely/i);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("deletes the session when its first prompt cannot be posted", async () => {
    const { toolDeps, deleteSession } = deps({ postFails: new Error("503 from the API") });

    await expect(spawnSession(toolDeps, { instance: "alpha", prompt: "p" }))
      .rejects.toThrow(/s-new.*503 from the API.*has been deleted/s);
    expect(deleteSession).toHaveBeenCalledWith("s-new");
  });

  it("says so when the post failed and the cleanup failed too", async () => {
    const { toolDeps, deleteSession } = deps({
      postFails: new Error("503 from the API"),
      deleteFails: new Error("delete refused"),
    });

    await expect(spawnSession(toolDeps, { instance: "alpha", prompt: "p" }))
      .rejects.toThrow(/s-new.*Deleting it also failed \(delete refused\).*by hand/s);
    expect(deleteSession).toHaveBeenCalledWith("s-new");
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
