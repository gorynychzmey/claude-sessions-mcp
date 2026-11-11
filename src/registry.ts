import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The sessions this server has spawned and not yet seen archived or deleted.
 * The spawn ceiling is counted from this list, one getSession per entry,
 * instead of paging through the whole session list: that list holds every
 * archived session too, and with a long history it outgrows any page cap.
 */
export interface SpawnRegistry {
  /** False until the registry has been filled once from the full session list. */
  isSeeded(): Promise<boolean>;
  markSeeded(): Promise<void>;
  list(): Promise<string[]>;
  add(sessionId: string): Promise<void>;
  remove(sessionId: string): Promise<void>;
}

const SESSION_ID = /^[A-Za-z0-9_-]+$/;

function checkId(sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) {
    throw new Error(`Refusing session id "${sessionId}" for the spawn registry: unexpected characters.`);
  }
  return sessionId;
}

/**
 * One empty file per session under `<dir>/sessions`, plus a `<dir>/seeded`
 * mark. A file per entry rather than one JSON document, because the CLI's
 * task runs and the MCP server write here concurrently: creating or unlinking
 * a file cannot lose another writer's entry the way a read-modify-write can.
 */
export function fileRegistry(dir: string): SpawnRegistry {
  const sessions = join(dir, "sessions");
  const seeded = join(dir, "seeded");
  return {
    async isSeeded() {
      try {
        await stat(seeded);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    async markSeeded() {
      await mkdir(dir, { recursive: true });
      await writeFile(seeded, "");
    },
    async list() {
      try {
        return (await readdir(sessions)).filter((name) => SESSION_ID.test(name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
    async add(sessionId) {
      checkId(sessionId);
      await mkdir(sessions, { recursive: true });
      await writeFile(join(sessions, sessionId), "");
    },
    async remove(sessionId) {
      checkId(sessionId);
      try {
        await unlink(join(sessions, sessionId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}

/** In-memory registry for tests; seeded unless told otherwise. */
export function memoryRegistry(initial: string[] = [], seeded = true): SpawnRegistry {
  const ids = new Set(initial);
  let isSeeded = seeded;
  return {
    async isSeeded() { return isSeeded; },
    async markSeeded() { isSeeded = true; },
    async list() { return [...ids]; },
    async add(sessionId) { ids.add(checkId(sessionId)); },
    async remove(sessionId) { ids.delete(checkId(sessionId)); },
  };
}
