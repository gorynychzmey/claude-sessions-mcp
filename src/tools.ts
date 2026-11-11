import { ApiError, type SessionsApi } from "./api.js";
import { discoverInstances, type DiscoveryDeps } from "./discovery.js";
import { SERVER_TAG, condenseEvents, toSummary, toTurnResult } from "./sessions.js";
import type { BridgeInstance, TurnResult } from "./types.js";
import type { SpawnRegistry } from "./registry.js";

export interface ToolDeps {
  api: SessionsApi;
  discovery: DiscoveryDeps;
  maxSpawned: number;
  /** The sessions this server spawned; the spawn ceiling is counted from it. */
  registry: SpawnRegistry;
  /** Seam for tests; production passes discoverInstances over `discovery`. */
  discover?: (deps: DiscoveryDeps) => Promise<BridgeInstance[]>;
}

async function instances(deps: ToolDeps): Promise<BridgeInstance[]> {
  return (deps.discover ?? discoverInstances)(deps.discovery);
}

export async function requireInstance(deps: ToolDeps, name: string): Promise<BridgeInstance> {
  const found = await instances(deps);
  const matches = found.filter((i) => i.name === name);
  if (matches.length === 0) {
    const known = found.map((i) => i.name).join(", ") || "none";
    throw new Error(`No running bridge named "${name}" on this machine. Running: ${known}.`);
  }
  if (matches.length > 1) {
    // Names fall back to basename(cwd), so two worktrees of one repository
    // produce the same name. Picking the first match would start an agent in
    // the wrong project's directory.
    const candidates = matches.map((i) => `pid ${i.pid} in ${i.cwd}`).join("; ");
    throw new Error(
      `"${name}" matches ${matches.length} running bridges: ${candidates}. ` +
      "Restart them with distinct --name values so the one you mean can be addressed.",
    );
  }
  return matches[0]!;
}

export async function listInstances(deps: ToolDeps): Promise<{ instances: BridgeInstance[] }> {
  return { instances: await instances(deps) };
}

export async function listSessions(
  deps: ToolDeps,
  args: { instance?: string },
): Promise<{ sessions: ReturnType<typeof toSummary>[] }> {
  const sessions = await deps.api.listSessions();
  if (!args.instance) return { sessions: sessions.map(toSummary) };

  const bridge = await requireInstance(deps, args.instance);
  return {
    sessions: sessions
      .filter((s) => s.environment_id === bridge.environmentId)
      .map(toSummary),
  };
}

export async function readSession(
  deps: ToolDeps,
  args: { session_id: string; limit?: number; cursor?: string; verbose?: boolean },
): Promise<{ events: ReturnType<typeof condenseEvents>; cursor: string | null }> {
  const { events, resumeCursor } = await deps.api.listEvents(args.session_id, {
    limit: args.limit,
    cursor: args.cursor,
  });
  return { events: condenseEvents(events, args.verbose === true), cursor: resumeCursor };
}

export const ALLOWED_PERMISSION_MODES = [
  "auto", "acceptEdits", "plan", "manual", "dontAsk",
] as const;

const DEFAULT_EFFORT = "medium";
const TITLE_LIMIT = 60;

/**
 * Page size and page cap for the one-time scan that seeds the registry. The cap
 * only stops a list that never ends; it is far above any real history.
 */
const SEED_PAGE_SIZE = 100;
const SEED_MAX_PAGES = 1000;

/**
 * Fills an unseeded registry with this server's live sessions from the full
 * session list. Runs once, on the first spawn after the registry appears; a
 * list that does not end within the cap leaves it unseeded and fails closed.
 */
async function seedRegistry(deps: ToolDeps): Promise<void> {
  let cursor: string | undefined;
  for (let page = 0; page < SEED_MAX_PAGES; page++) {
    const { sessions, nextCursor } = await deps.api.listSessionsPage({ limit: SEED_PAGE_SIZE, cursor });
    for (const s of sessions) {
      if (s.status === "active" && (s.tags ?? []).includes(SERVER_TAG)) await deps.registry.add(s.id);
    }
    if (!nextCursor) {
      await deps.registry.markSeeded();
      return;
    }
    cursor = nextCursor;
  }
  throw new Error(
    `Refusing to spawn: the session list did not end within ${SEED_MAX_PAGES} pages of ` +
    `${SEED_PAGE_SIZE}, so the registry of this server's sessions cannot be seeded and the ` +
    "spawn ceiling cannot be counted.",
  );
}

/**
 * Counts this server's own live sessions in one environment by asking about
 * each session in its registry, not by paging the session list: that list
 * holds every archived session too and outgrows any page cap (it passed 2000
 * entries in November 2026 and the old 20-page count started refusing every
 * spawn). Archived and deleted sessions are dropped from the registry as they
 * are found. Any other lookup error propagates, so a count that cannot be
 * completed fails closed rather than spawning.
 */
async function countOwnActiveSessions(deps: ToolDeps, environmentId: string): Promise<number> {
  if (!(await deps.registry.isSeeded())) await seedRegistry(deps);

  let count = 0;
  for (const id of await deps.registry.list()) {
    let session;
    try {
      session = await deps.api.getSession(id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        await deps.registry.remove(id);
        continue;
      }
      throw error;
    }
    if (session.status !== "active") {
      await deps.registry.remove(id);
      continue;
    }
    if (session.environment_id === environmentId) count++;
  }
  return count;
}

/** Deletes a session that was created but cannot be handed back; says how that went. */
async function discardCreated(deps: ToolDeps, sessionId: string): Promise<string> {
  try {
    await deps.api.deleteSession(sessionId);
  } catch (deleteError) {
    const deleteReason = deleteError instanceof Error ? deleteError.message : String(deleteError);
    return `Deleting it also failed (${deleteReason}) — it is still running and must be removed by hand.`;
  }
  await deps.registry.remove(sessionId).catch(() => {});
  return "The session has been deleted.";
}

export async function spawnSession(
  deps: ToolDeps,
  args: {
    instance: string;
    prompt: string;
    title?: string;
    effort?: string;
    permission_mode?: string;
    caller?: string;
    tags?: string[];
    model?: string;
  },
): Promise<{ session_id: string; instance: string; title: string }> {
  const mode = args.permission_mode ?? "auto";
  if (!ALLOWED_PERMISSION_MODES.includes(mode as (typeof ALLOWED_PERMISSION_MODES)[number])) {
    throw new Error(
      `permission_mode "${mode}" is not allowed here. ` +
      `Use one of: ${ALLOWED_PERMISSION_MODES.join(", ")}. ` +
      "bypassPermissions is refused so that a spawned session cannot exceed the permissions of the one that asked for it.",
    );
  }

  const bridge = await requireInstance(deps, args.instance);
  if (bridge.workers >= bridge.capacity) {
    throw new Error(
      `Bridge "${bridge.name}" is at capacity (${bridge.workers}/${bridge.capacity}). ` +
      "A session created now would be accepted and never run.",
    );
  }

  const mine = await countOwnActiveSessions(deps, bridge.environmentId);
  if (mine >= deps.maxSpawned) {
    throw new Error(
      `Spawn ceiling reached: ${mine} of ${deps.maxSpawned} sessions in "${bridge.name}" ` +
      "were created by this server. Delete or archive one first.",
    );
  }

  const title = (args.title ?? args.prompt).slice(0, TITLE_LIMIT);
  const caller = args.caller ?? "unknown";
  const created = await deps.api.createSession({
    environmentId: bridge.environmentId,
    title,
    tags: [SERVER_TAG, `spawned-by:${caller}`, ...(args.tags ?? [])],
    effort: args.effort ?? DEFAULT_EFFORT,
    permissionMode: mode,
    ...(args.model ? { model: args.model } : {}),
  });

  // createSession has already started the worker and taken both a bridge slot
  // and a ceiling slot. A session missing from the registry would never count
  // towards the ceiling, and one whose prompt cannot be posted is never handed
  // back to the caller; either way nothing else could clean it up.
  try {
    await deps.registry.add(created.id);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const cleanup = await discardCreated(deps, created.id);
    throw new Error(
      `Session ${created.id} was created in "${bridge.name}" but could not be recorded in the ` +
      `spawn registry (${reason}). ${cleanup}`,
      { cause: error },
    );
  }

  try {
    await deps.api.postUserMessage(created.id, args.prompt);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const cleanup = await discardCreated(deps, created.id);
    throw new Error(
      `Session ${created.id} was created in "${bridge.name}" but its first prompt could not be ` +
      `posted (${reason}). ${cleanup}`,
      { cause: error },
    );
  }

  return { session_id: created.id, instance: bridge.name, title };
}

/** A session that is live but has no worker on any bridge right now. */
function detached(s: { status?: string; connection_status?: string }): boolean {
  return s.status !== "archived" && s.connection_status !== "connected";
}

export async function sendMessage(
  deps: ToolDeps,
  args: { session_id: string; text: string },
): Promise<{ delivered: true; reattached: boolean }> {
  await deps.api.postUserMessage(args.session_id, args.text);
  // A message alone never gets a detached session a worker (measured: 11 min
  // of nothing), so wake it the way the bridge wakes its own anchor.
  const session = await deps.api.getSession(args.session_id);
  if (!detached(session) || !session.environment_id) return { delivered: true, reattached: false };
  await deps.api.reconnectSession(session.environment_id, args.session_id);
  return { delivered: true, reattached: true };
}

/**
 * After a bridge restart, hand it back every live session of its environment
 * that has no worker. Without this they stay unreachable for ~6 minutes (the
 * old bridge's work leases) and then until a client re-opens them.
 */
export async function reattachSessions(
  deps: ToolDeps,
  args: { instance: string },
): Promise<{
  instance: string;
  environmentId: string;
  reattached: string[];
  failed: { session_id: string; error: string }[];
}> {
  const bridge = await requireInstance(deps, args.instance);
  const sessions = (await deps.api.listSessions())
    .filter((s) => s.environment_id === bridge.environmentId && detached(s));
  const reattached: string[] = [];
  const failed: { session_id: string; error: string }[] = [];
  for (const s of sessions) {
    try {
      await deps.api.reconnectSession(bridge.environmentId, s.id);
      reattached.push(s.id);
    } catch (error) {
      failed.push({ session_id: s.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { instance: args.instance, environmentId: bridge.environmentId, reattached, failed };
}

/**
 * Waits for the session's current turn to finish, on the event stream rather
 * than by polling. A stream that ends before the result arrives is reopened
 * from the last event id, so a dropped connection costs a reconnect rather
 * than the answer.
 */
/** Pause before reconnecting after a dropped stream, so a connection that fails
 * instantly cannot spin the reconnect loop. */
const RECONNECT_DELAY_MS = 1000;
/** How often a wait re-checks that the session is still running. */
const STATUS_POLL_MS = 5000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Why a wait ended. */
export type WaitOutcome = "result" | "archived" | "deleted" | "timeout";

/**
 * Whether the session has stopped in a way that means no result is coming.
 *
 * Archiving kills the running turn without emitting anything on the event
 * stream — verified against the live API: a stream held open across an
 * archive carries no result, no status frame, and does not close. So the
 * only way to notice is to ask.
 *
 * A status check that fails for any other reason returns null: losing one
 * poll must not end a wait that the stream may still finish.
 */
async function sessionStopReason(
  deps: ToolDeps,
  sessionId: string,
): Promise<"archived" | "deleted" | null> {
  try {
    const session = await deps.api.getSession(sessionId);
    return session.status === "archived" ? "archived" : null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return "deleted";
    return null;
  }
}

function stoppedAnswer(reason: "archived" | "deleted"): {
  finished: false;
  outcome: "archived" | "deleted";
  note: string;
} {
  return {
    finished: false,
    outcome: reason,
    note: reason === "archived"
      ? "The session was archived, so its turn was cut short and no result will arrive. " +
        "Use read_session to see how far it got."
      : "The session no longer exists, so nothing can arrive for it.",
  };
}

/** How many of the newest events a wait reads to find where the latest turn stands. */
const TURN_SCAN_LIMIT = 50;

/**
 * Where the session's latest turn stands, read newest-first from the event
 * list. The newest event alone does not tell: a finished session can carry
 * control and system events after its result (seen live: eight of them, from
 * a bridge reattach). So the scan goes back to the first `result` or `user`
 * event. A result means the turn is over; a user event (the prompt, or a tool
 * result inside the turn) means it is still running. Neither within the scan
 * is read as running, which at worst waits rather than returning a stale answer.
 *
 * `newest` is the sequence number of the newest event, the line a stream
 * result must be past to belong to the turn being waited on: the stream
 * replays the full history when opened without Last-Event-ID, results of
 * long-finished turns included.
 */
async function latestTurn(
  deps: ToolDeps,
  sessionId: string,
): Promise<{ result: Record<string, unknown> | null; newest: string | null }> {
  const { events } = await deps.api.listEvents(sessionId, { limit: TURN_SCAN_LIMIT });
  const newest = events[0]?.sequence_num ?? null;
  const boundary = events.find((e) => e.event_type === "result" || e.event_type === "user");
  const result = boundary?.event_type === "result" ? boundary.payload ?? null : null;
  return { result, newest };
}

export async function waitForIdle(
  deps: ToolDeps,
  args: { session_id: string; timeout_s?: number },
): Promise<{ finished: boolean; outcome: WaitOutcome; result?: TurnResult; note?: string }> {
  const timeoutMs = (args.timeout_s ?? 300) * 1000;
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let lastEventId: string | undefined;
  let stopped: "archived" | "deleted" | null = null;

  try {
    // Asked before opening the stream: a session that is already archived or
    // gone would otherwise be waited on for the full timeout.
    stopped = await sessionStopReason(deps, args.session_id);
    if (stopped) return stoppedAnswer(stopped);

    const latest = await latestTurn(deps, args.session_id);
    if (latest.result) return { finished: true, outcome: "result", result: toTurnResult(latest.result) };
    // The stream's frame ids are the events' sequence numbers, so resuming
    // from the newest one skips the history replay; the sequence check below
    // still guards against a server that replays anyway.
    const after = latest.newest === null ? null : Number(latest.newest);
    lastEventId = latest.newest ?? undefined;

    // The stream cannot report an archive, so a poll runs alongside it and
    // aborts the wait when the session stops.
    const watcher = (async (): Promise<void> => {
      while (!controller.signal.aborted && Date.now() < deadline) {
        await sleep(STATUS_POLL_MS, controller.signal);
        if (controller.signal.aborted) return;
        const reason = await sessionStopReason(deps, args.session_id);
        if (reason) {
          stopped = reason;
          controller.abort();
          return;
        }
      }
    })();
    void watcher;

    while (Date.now() < deadline) {
      try {
        for await (const frame of deps.api.streamEvents(args.session_id, {
          lastEventId,
          signal: controller.signal,
        })) {
          if (frame.id) lastEventId = frame.id;
          const payload = frame.payload as {
            event_type?: string; sequence_num?: string; payload?: Record<string, unknown>;
          };
          // A result that is not past the newest event seen before the wait
          // belongs to an earlier turn.
          const sequence = Number(payload?.sequence_num ?? frame.id);
          if (after !== null && !(sequence > after)) continue;
          if (payload?.event_type === "result" && payload.payload) {
            return { finished: true, outcome: "result", result: toTurnResult(payload.payload) };
          }
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        // A 4xx (other than 429, which is a rate limit and heals on retry)
        // is a broken request, not a broken connection: reconnecting would
        // just repeat it silently until the timeout. Anything else — a
        // thrown network error, a 5xx, a 429 — is treated as a dropped
        // stream and reconnects from lastEventId after a short pause.
        if (error instanceof ApiError && error.status !== 429 && error.status >= 400 && error.status < 500) {
          throw error;
        }
      }
      if (stopped) return stoppedAnswer(stopped);
      if (controller.signal.aborted) break;
      // Every reconnect waits, not only the ones that follow an error: a
      // stream that ends cleanly and immediately (an idle connection the
      // server closed, a bridge restart, an empty stream) would otherwise
      // be reopened thousands of times inside one timeout.
      await sleep(RECONNECT_DELAY_MS);
    }
    if (stopped) return stoppedAnswer(stopped);
    return {
      finished: false,
      outcome: "timeout",
      note: `No result within ${args.timeout_s ?? 300}s — the session is still working. ` +
        "Call again to keep waiting, or read_session to see where it is.",
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function archiveSession(
  deps: ToolDeps,
  args: { session_id: string },
): Promise<{ session: ReturnType<typeof toSummary> }> {
  return { session: toSummary(await deps.api.archiveSession(args.session_id)) };
}

export async function unarchiveSession(
  deps: ToolDeps,
  args: { session_id: string },
): Promise<{ session: ReturnType<typeof toSummary>; note: string }> {
  const session = await deps.api.unarchiveSession(args.session_id);
  // A session of this server that comes back counts towards the ceiling again,
  // and the registry dropped it when it was found archived.
  if ((session.tags ?? []).includes(SERVER_TAG)) await deps.registry.add(session.id);
  return {
    session: toSummary(session),
    note: "The session is active again, but this does not restart the worker: " +
      "messages sent now are stored and not executed until a client opens the session.",
  };
}

export async function deleteSession(
  deps: ToolDeps,
  args: { session_id: string },
): Promise<{ deleted: true }> {
  await deps.api.deleteSession(args.session_id);
  return { deleted: true };
}
