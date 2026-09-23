import { describe, expect, it, vi } from "vitest";
import { parseTarget, runTask, VECTOR_TAG } from "../src/run.js";
import type { RunDeps } from "../src/run.js";

const bridge = {
  name: "alpha", cwd: "/srv/alpha", pid: 1, environmentId: "env-1",
  capacity: 8, workers: 0, spawnMode: "same-dir",
};
const tasksJson = JSON.stringify({ tasks: {
  "ci-monitor": { cron: "17 */3 * * *", prompt_file: "ci-monitor.md" },
  "nightly": { cron: "0 3 * * *", prompt_file: "nightly.md", timeout_min: 5, model: "claude-opus-5" },
} });

function resultFrame(isError: boolean) {
  return { id: "9", payload: { event_type: "result", payload: {
    subtype: isError ? "error_during_execution" : "success", is_error: isError,
    result: isError ? "boom" : "done", num_turns: 3, stop_reason: "end_turn",
    permission_denials: [], total_cost_usd: 0.1,
  } } };
}

function makeDeps(opts: { frames?: unknown[]; bridges?: typeof bridge[]; archiveFails?: boolean } = {}) {
  const createSession = vi.fn(async () => ({ id: "s-1" }));
  const postUserMessage = vi.fn(async () => {});
  const archiveSession = vi.fn(async (id: string) => {
    if (opts.archiveFails) throw new Error("archive down");
    return { id, status: "archived", tags: [] };
  });
  const streamEvents = vi.fn(async function* () { for (const f of opts.frames ?? []) yield f; });
  const getSession = vi.fn(async (id: string) => ({ id, status: "active" }));
  const listSessionsPage = vi.fn(async () => ({ sessions: [], nextCursor: null }));
  const readFile = vi.fn(async (p: string) => {
    if (p === "/srv/alpha/.claude/background/tasks.json") return tasksJson;
    throw new Error(`ENOENT ${p}`);
  });
  const deps = {
    api: { createSession, postUserMessage, archiveSession, streamEvents, getSession, listSessionsPage },
    discovery: {}, maxSpawned: 6,
    discover: async () => opts.bridges ?? [bridge],
    readFile,
  } as unknown as RunDeps;
  return { deps, createSession, postUserMessage, archiveSession };
}

describe("parseTarget", () => {
  it("accepts the systemd instance form and the two-argument form", () => {
    expect(parseTarget(["vts--ci-monitor"])).toEqual({ instance: "vts", task: "ci-monitor" });
    expect(parseTarget(["personal-doctor--code-review"]))
      .toEqual({ instance: "personal-doctor", task: "code-review" });
    expect(parseTarget(["vts", "ci-monitor"])).toEqual({ instance: "vts", task: "ci-monitor" });
  });
  it("rejects anything else", () => {
    expect(() => parseTarget(["vts"])).toThrow(/instance--task/);
    expect(() => parseTarget([])).toThrow(/instance--task/);
  });
});

describe("runTask", () => {
  it("spawns a tagged Vector session, waits for its result, archives it and reports success", async () => {
    const { deps, createSession, postUserMessage, archiveSession } = makeDeps({ frames: [resultFrame(false)] });

    const report = await runTask(deps, "alpha", "ci-monitor");

    expect(report).toMatchObject({ ok: true, sessionId: "s-1", outcome: "result" });
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      title: "Вектор Прайм · ci-monitor",
      tags: ["mcp:claude-sessions-mcp", "spawned-by:vector-task", VECTOR_TAG],
      permissionMode: "auto",
    }));
    expect(postUserMessage.mock.calls[0][1]).toContain("/srv/alpha/.claude/background/ci-monitor.md");
    expect(archiveSession).toHaveBeenCalledWith("s-1");
  });

  it("passes the task's model through", async () => {
    const { deps, createSession } = makeDeps({ frames: [resultFrame(false)] });
    await runTask(deps, "alpha", "nightly");
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-opus-5" }));
  });

  it("reports failure on an error result and still archives", async () => {
    const { deps, archiveSession } = makeDeps({ frames: [resultFrame(true)] });
    const report = await runTask(deps, "alpha", "ci-monitor");
    expect(report.ok).toBe(false);
    expect(report.detail).toContain("boom");
    expect(archiveSession).toHaveBeenCalledWith("s-1");
  });

  it("fails before spawning when the task is not in tasks.json", async () => {
    const { deps, createSession } = makeDeps();
    await expect(runTask(deps, "alpha", "nope")).rejects.toThrow(/nope.*tasks\.json/);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("fails before spawning when the bridge is not running", async () => {
    const { deps, createSession } = makeDeps({ bridges: [] });
    await expect(runTask(deps, "alpha", "ci-monitor")).rejects.toThrow(/No running bridge named "alpha"/);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("reports an archive failure without hiding the task's own verdict", async () => {
    const { deps } = makeDeps({ frames: [resultFrame(false)], archiveFails: true });
    const report = await runTask(deps, "alpha", "ci-monitor");
    expect(report.ok).toBe(false);
    expect(report.detail).toMatch(/archive down/);
  });
});
