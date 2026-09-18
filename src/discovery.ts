import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { linuxProcSource, parseBridgeArgv, type ProcSource } from "./proc.js";
import type { BridgeInstance } from "./types.js";

export interface BridgePointer {
  environmentId: string;
  pid: number;
}

export interface DiscoveryDeps {
  proc: ProcSource;
  readPointers(): Promise<BridgePointer[]>;
}

/**
 * The bridges running on this machine, each joined to the environment it
 * registered. A bridge without a live pointer is left out: without an
 * environment id there is nothing we could ask it to do.
 */
export async function discoverInstances(deps: DiscoveryDeps): Promise<BridgeInstance[]> {
  const [processes, pointers] = await Promise.all([deps.proc.list(), deps.readPointers()]);
  const byPid = new Map(pointers.map((p) => [p.pid, p.environmentId]));

  const workersByParent = new Map<number, number>();
  for (const p of processes) {
    if (p.argv.includes("--sdk-url")) {
      workersByParent.set(p.ppid, (workersByParent.get(p.ppid) ?? 0) + 1);
    }
  }

  const instances: BridgeInstance[] = [];
  for (const p of processes) {
    const argv = parseBridgeArgv(p.argv);
    const environmentId = byPid.get(p.pid);
    if (!argv || !environmentId || !p.cwd) continue;
    instances.push({
      name: argv.name ?? basename(p.cwd),
      cwd: p.cwd,
      pid: p.pid,
      environmentId,
      capacity: argv.capacity,
      workers: workersByParent.get(p.pid) ?? 0,
      spawnMode: argv.spawnMode,
    });
  }
  return instances;
}

/** Reads every `<projectsDir>/<slug>/bridge-pointer.json` Claude Code has written. */
export async function readPointersFrom(projectsDir: string): Promise<BridgePointer[]> {
  const slugs = await readdir(projectsDir).catch(() => [] as string[]);
  const pointers = await Promise.all(slugs.map(async (slug) => {
    const raw = await readFile(join(projectsDir, slug, "bridge-pointer.json"), "utf8").catch(() => null);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as { environmentId?: unknown; pid?: unknown };
      if (typeof parsed.environmentId !== "string" || typeof parsed.pid !== "number") return null;
      return { environmentId: parsed.environmentId, pid: parsed.pid };
    } catch {
      return null; // a half-written pointer is not an error worth failing discovery over
    }
  }));
  return pointers.filter((p): p is BridgePointer => p !== null);
}

export function defaultDiscoveryDeps(claudeConfigDir: string): DiscoveryDeps {
  return {
    proc: linuxProcSource,
    readPointers: () => readPointersFrom(join(claudeConfigDir, "projects")),
  };
}
