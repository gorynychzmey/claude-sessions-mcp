import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileRegistry, memoryRegistry } from "../src/registry.js";

describe("fileRegistry", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "spawn-registry-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("starts unseeded and empty when the directory does not exist yet", async () => {
    const registry = fileRegistry(join(dir, "missing"));
    expect(await registry.isSeeded()).toBe(false);
    expect(await registry.list()).toEqual([]);
  });

  it("remembers added sessions across instances, one file per session", async () => {
    await fileRegistry(dir).add("cse_a");
    await fileRegistry(dir).add("cse_b");

    expect((await fileRegistry(dir).list()).sort()).toEqual(["cse_a", "cse_b"]);
    expect((await readdir(join(dir, "sessions"))).sort()).toEqual(["cse_a", "cse_b"]);
  });

  it("forgets a removed session and tolerates removing one it never had", async () => {
    const registry = fileRegistry(dir);
    await registry.add("cse_a");
    await registry.remove("cse_a");
    await registry.remove("cse_never");

    expect(await registry.list()).toEqual([]);
  });

  it("keeps the seeded mark", async () => {
    await fileRegistry(dir).markSeeded();
    expect(await fileRegistry(dir).isSeeded()).toBe(true);
  });

  it("refuses an id that could leave the registry directory", async () => {
    const registry = fileRegistry(dir);
    await expect(registry.add("../escape")).rejects.toThrow(/session id/i);
    await expect(registry.remove("a/b")).rejects.toThrow(/session id/i);
  });
});

describe("memoryRegistry", () => {
  it("is seeded by default and holds what it was given", async () => {
    const registry = memoryRegistry(["s-1"]);
    expect(await registry.isSeeded()).toBe(true);
    await registry.add("s-2");
    await registry.remove("s-1");
    expect(await registry.list()).toEqual(["s-2"]);
  });

  it("can start unseeded", async () => {
    const registry = memoryRegistry([], false);
    expect(await registry.isSeeded()).toBe(false);
    await registry.markSeeded();
    expect(await registry.isSeeded()).toBe(true);
  });
});
