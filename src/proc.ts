import { readFile, readdir, readlink } from "node:fs/promises";

export interface ProcessInfo {
  pid: number;
  ppid: number;
  argv: string[];
  cwd: string | null;
}

export interface ProcSource {
  list(): Promise<ProcessInfo[]>;
}

export interface BridgeArgv {
  name: string | null;
  capacity: number;
  spawnMode: string | null;
}

/** The CLI's own default when --capacity is not given. */
export const DEFAULT_CAPACITY = 32;

function flagValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

/**
 * Recognises a Remote Control bridge by its argv and reads what it declares.
 * Returns null for anything else, including shells whose command line merely
 * contains the words.
 */
export function parseBridgeArgv(argv: string[]): BridgeArgv | null {
  const [exe, subcommand] = argv;
  if (!exe || !/(^|\/)claude$/.test(exe)) return null;
  if (subcommand !== "remote-control") return null;

  const rawCapacity = flagValue(argv, "--capacity");
  const capacity = Number(rawCapacity);
  return {
    name: flagValue(argv, "--name"),
    capacity: Number.isInteger(capacity) && capacity > 0 ? capacity : DEFAULT_CAPACITY,
    spawnMode: flagValue(argv, "--spawn"),
  };
}

/** Linux implementation. A macOS port replaces this object and nothing else. */
export const linuxProcSource: ProcSource = {
  async list(): Promise<ProcessInfo[]> {
    const entries = await readdir("/proc");
    const pids = entries.filter((e) => /^\d+$/.test(e)).map(Number);
    const infos = await Promise.all(pids.map((pid) => readProcess(pid)));
    return infos.filter((p): p is ProcessInfo => p !== null);
  },
};

async function readProcess(pid: number): Promise<ProcessInfo | null> {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
    const argv = raw.split("\0").filter((s) => s.length > 0);
    if (argv.length === 0) return null;
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => null);
    return { pid, ppid: Number.isFinite(ppid) ? ppid : 0, argv, cwd };
  } catch {
    return null; // the process exited while we were reading it
  }
}
