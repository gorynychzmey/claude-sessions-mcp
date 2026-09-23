import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, write: (s: string) => out.push(s), warn: (s: string) => err.push(s) };
}

describe("claude-sessions CLI", () => {
  it("show prints id, status and tags", async () => {
    const o = io();
    const getSession = vi.fn(async () => ({ id: "cse_1", title: "t", status: "active", tags: ["role:vector-prime"] }));
    const code = await main(["show", "cse_1"], { api: { getSession } as never, runTask: vi.fn(), ...o } as never);
    expect(code).toBe(0);
    expect(JSON.parse(o.out.join(""))).toEqual({ id: "cse_1", title: "t", status: "active", tags: ["role:vector-prime"] });
  });

  it("run maps the report to the exit code", async () => {
    const o = io();
    const runTask = vi.fn(async () => ({ ok: false, sessionId: "s", outcome: "timeout", detail: "slow" }));
    const code = await main(["run", "vts--ci-monitor"], { runTask, ...o } as never);
    expect(runTask).toHaveBeenCalledWith("vts", "ci-monitor");
    expect(code).toBe(1);
    expect(JSON.parse(o.out.join("")).outcome).toBe("timeout");
  });

  it("run turns a thrown setup error into exit 2 with the message on stderr", async () => {
    const o = io();
    const runTask = vi.fn(async () => { throw new Error('No running bridge named "vts"'); });
    const code = await main(["run", "vts--ci-monitor"], { runTask, ...o } as never);
    expect(code).toBe(2);
    expect(o.err.join("")).toContain("No running bridge");
  });

  it("rejects an unknown command", async () => {
    const o = io();
    expect(await main(["frobnicate"], { ...o } as never)).toBe(2);
  });
});
