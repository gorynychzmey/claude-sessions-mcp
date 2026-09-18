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
