import { describe, expect, it } from "vitest";
import { parseBridgeArgv } from "../src/proc.js";

const bridge = (extra: string[] = []) => [
  "/usr/local/bin/claude", "remote-control", ...extra,
];

describe("parseBridgeArgv", () => {
  it("reads name, capacity and spawn mode", () => {
    expect(parseBridgeArgv(bridge(["--name", "demo", "--spawn", "worktree", "--capacity", "4"])))
      .toEqual({ name: "demo", capacity: 4, spawnMode: "worktree" });
  });

  it("defaults capacity to the CLI default when absent", () => {
    expect(parseBridgeArgv(bridge(["--name", "demo"])))
      .toEqual({ name: "demo", capacity: 32, spawnMode: null });
  });

  it("returns a null name when --name is absent, leaving the fallback to the caller", () => {
    expect(parseBridgeArgv(bridge())).toEqual({ name: null, capacity: 32, spawnMode: null });
  });

  it("ignores a capacity that is not a positive integer", () => {
    expect(parseBridgeArgv(bridge(["--capacity", "nonsense"]))?.capacity).toBe(32);
  });

  it("is not fooled by a process that merely mentions the words", () => {
    expect(parseBridgeArgv(["/bin/bash", "-c", "echo claude remote-control"])).toBeNull();
    expect(parseBridgeArgv(["/usr/local/bin/claude", "--help"])).toBeNull();
  });
});
