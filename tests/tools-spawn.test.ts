import { describe, expect, it, vi } from "vitest";
import { spawnSession } from "../src/tools.js";
import type { ToolDeps } from "../src/tools.js";
import { SERVER_TAG } from "../src/sessions.js";
import { ApiError } from "../src/api.js";
import { memoryRegistry, type SpawnRegistry } from "../src/registry.js";

const instance = {
  name: "alpha", cwd: "/srv/alpha", pid: 100, environmentId: "env-1",
  capacity: 8, workers: 2, spawnMode: "same-dir",
};

type FakeSession = { id?: string; environment_id: string; status: string; tags: string[] };

function deps(overrides: {
  /** Sessions getSession knows, by id; an id missing here answers 404. */
  known?: Record<string, FakeSession>;
  /** What the spawn registry holds before the call. */
  registered?: string[];
  registry?: SpawnRegistry;
  /** Pages the full session list hands back when the registry is seeded. */
  pages?: FakeSession[][];
  endless?: boolean;
  getSessionFails?: Error;
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
  const known = overrides.known ?? {};
  const getSession = vi.fn(async (id: string) => {
    if (overrides.getSessionFails) throw overrides.getSessionFails;
    const session = known[id];
    if (!session) throw new ApiError(`404 ${id}`, 404, null);
    return { id, ...session };
  });
  const pages = overrides.pages ?? [[]];
  const listSessionsPage = vi.fn(async ({ cursor }: { cursor?: string } = {}) => {
    const index = cursor ? Number(cursor) : 0;
    const last = index >= pages.length - 1;
    return {
      sessions: pages[index] ?? [],
      nextCursor: overrides.endless || !last ? String(index + 1) : null,
    };
  });
  const registry = overrides.registry ?? memoryRegistry(overrides.registered ?? []);
  const toolDeps = {
    api: { createSession, postUserMessage, deleteSession, getSession, listSessionsPage },
    discovery: { proc: { list: async () => [] }, readPointers: async () => [] },
    maxSpawned: overrides.maxSpawned ?? 3,
    registry,
    discover: async () => overrides.instances ?? [overrides.instance ?? instance],
  } as unknown as ToolDeps;
  return { toolDeps, createSession, postUserMessage, deleteSession, getSession, listSessionsPage, registry };
}

/** n live sessions of this server in env-1, as both the registry and getSession see them. */
function spawned(n: number): { known: Record<string, FakeSession>; registered: string[] } {
  const known: Record<string, FakeSession> = {};
  for (let i = 0; i < n; i++) known[`s-${i}`] = { environment_id: "env-1", status: "active", tags: [SERVER_TAG] };
  return { known, registered: Object.keys(known) };
}

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

  it("counts the ceiling from its registry, without paging the session list", async () => {
    const { toolDeps, createSession, getSession, listSessionsPage } = deps({ ...spawned(3), maxSpawned: 3 });

    await expect(spawnSession(toolDeps, { instance: "alpha", prompt: "p" }))
      .rejects.toThrow(/ceiling/i);
    expect(getSession).toHaveBeenCalledTimes(3);
    expect(listSessionsPage).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("forgets registered sessions that were archived or deleted, and they stop counting", async () => {
    const { toolDeps, createSession, registry } = deps({
      known: {
        live: { environment_id: "env-1", status: "active", tags: [SERVER_TAG] },
        done: { environment_id: "env-1", status: "archived", tags: [SERVER_TAG] },
      },
      registered: ["live", "done", "gone"],
      maxSpawned: 2,
    });

    await spawnSession(toolDeps, { instance: "alpha", prompt: "p" });

    expect(createSession).toHaveBeenCalledOnce();
    expect((await registry.list()).sort()).toEqual(["live", "s-new"]);
  });

  it("does not count its live sessions in another environment", async () => {
    const { toolDeps, createSession } = deps({
      known: { other: { environment_id: "env-other", status: "active", tags: [SERVER_TAG] } },
      registered: ["other"],
      maxSpawned: 1,
    });
    await spawnSession(toolDeps, { instance: "alpha", prompt: "p" });
    expect(createSession).toHaveBeenCalledOnce();
  });

  it("fails closed when a registered session cannot be looked up", async () => {
    const { toolDeps, createSession } = deps({
      ...spawned(1),
      getSessionFails: new ApiError("500 from the API", 500, null),
    });
    await expect(spawnSession(toolDeps, { instance: "alpha", prompt: "p" }))
      .rejects.toThrow(/500 from the API/);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("seeds an empty registry once from the full session list, past the old 20-page cap", async () => {
    const mine = { id: "s-old", environment_id: "env-1", status: "active", tags: [SERVER_TAG] };
    const filler = Array.from({ length: 100 }, (_, i) =>
      ({ id: `x-${i}`, environment_id: "env-1", status: "archived", tags: [SERVER_TAG] }));
    const pages = Array.from({ length: 25 }, (_, i) => (i === 24 ? [...filler, mine] : filler));
    const registry = memoryRegistry([], false);
    const { toolDeps, createSession } = deps({
      pages, registry, known: { "s-old": mine }, maxSpawned: 1,
    });

    await expect(spawnSession(toolDeps, { instance: "alpha", prompt: "p" }))
      .rejects.toThrow(/ceiling/i);
    expect(await registry.isSeeded()).toBe(true);
    expect(await registry.list()).toEqual(["s-old"]);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("fails closed when the list it seeds from never ends, and stays unseeded", async () => {
    const registry = memoryRegistry([], false);
    const { toolDeps, createSession } = deps({ endless: true, registry });

    await expect(spawnSession(toolDeps, { instance: "alpha", prompt: "p" }))
      .rejects.toThrow(/cannot be seeded/i);
    expect(await registry.isSeeded()).toBe(false);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("records the session it spawns in the registry", async () => {
    const { toolDeps, registry } = deps();
    await spawnSession(toolDeps, { instance: "alpha", prompt: "p" });
    expect(await registry.list()).toEqual(["s-new"]);
  });

  it("deletes the session when it cannot be recorded, since the ceiling would never see it", async () => {
    const registry = memoryRegistry();
    registry.add = vi.fn(async () => { throw new Error("disk full"); });
    const { toolDeps, deleteSession, postUserMessage } = deps({ registry });

    await expect(spawnSession(toolDeps, { instance: "alpha", prompt: "p" }))
      .rejects.toThrow(/s-new.*spawn registry \(disk full\).*has been deleted/s);
    expect(deleteSession).toHaveBeenCalledWith("s-new");
    expect(postUserMessage).not.toHaveBeenCalled();
  });

  it("deletes the session when its first prompt cannot be posted", async () => {
    const { toolDeps, deleteSession, registry } = deps({ postFails: new Error("503 from the API") });

    await expect(spawnSession(toolDeps, { instance: "alpha", prompt: "p" }))
      .rejects.toThrow(/s-new.*503 from the API.*has been deleted/s);
    expect(deleteSession).toHaveBeenCalledWith("s-new");
    expect(await registry.list()).toEqual([]);
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
    const { toolDeps, createSession } = deps({ ...spawned(3), maxSpawned: 3 });
    await expect(spawnSession(toolDeps, { instance: "alpha", prompt: "p" }))
      .rejects.toThrow(/ceiling/i);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("truncates a long prompt when deriving the title", async () => {
    const { toolDeps, createSession } = deps();
    await spawnSession(toolDeps, { instance: "alpha", prompt: "x".repeat(200) });
    expect(createSession.mock.calls[0][0].title).toHaveLength(60);
  });

  it("adds caller-supplied tags after its own and passes the model through", async () => {
    const { toolDeps, createSession } = deps();

    await spawnSession(toolDeps, {
      instance: "alpha", prompt: "p", caller: "vector-task",
      tags: ["role:vector-prime"], model: "claude-opus-5",
    });

    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      tags: [SERVER_TAG, "spawned-by:vector-task", "role:vector-prime"],
      model: "claude-opus-5",
    }));
  });
});
