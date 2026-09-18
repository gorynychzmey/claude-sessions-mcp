import { ApiError, type SessionsApi } from "./api.js";
import { discoverInstances, type DiscoveryDeps } from "./discovery.js";
import { SERVER_TAG, condenseEvents, toSummary, toTurnResult } from "./sessions.js";
import type { BridgeInstance, TurnResult } from "./types.js";

export interface ToolDeps {
  api: SessionsApi;
  discovery: DiscoveryDeps;
  maxSpawned: number;
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

/** Page size and page cap for the ceiling count. */
const CEILING_PAGE_SIZE = 100;
const CEILING_MAX_PAGES = 20;

/**
 * Counts this server's own live sessions in one environment, across every page
 * of the session list. A single page would be an under-count: the list holds
 * archived sessions too and ignores query filters, so with a long history this
 * server's own sessions fall off the first page and the ceiling stops binding.
 * If the list does not end within the page cap the count is incomplete, and an
 * incomplete count fails closed rather than spawning.
 */
async function countOwnActiveSessions(deps: ToolDeps, environmentId: string): Promise<number> {
  let cursor: string | undefined;
  let count = 0;

  for (let page = 0; page < CEILING_MAX_PAGES; page++) {
    const { sessions, nextCursor } = await deps.api.listSessionsPage({
      limit: CEILING_PAGE_SIZE,
      cursor,
    });
    count += sessions.filter((s) =>
      s.environment_id === environmentId &&
      s.status === "active" &&
      (s.tags ?? []).includes(SERVER_TAG)).length;
    if (!nextCursor) return count;
    cursor = nextCursor;
  }

  throw new Error(
    `Refusing to spawn: the session list did not end within ${CEILING_MAX_PAGES} pages of ` +
    `${CEILING_PAGE_SIZE}, so the spawn ceiling cannot be counted completely and a new session ` +
    "could exceed it unnoticed. Delete or archive old sessions, then try again.",
  );
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
    tags: [SERVER_TAG, `spawned-by:${caller}`],
    effort: args.effort ?? DEFAULT_EFFORT,
    permissionMode: mode,
  });

  // createSession has already started the worker and taken both a bridge slot
  // and a ceiling slot. If the prompt cannot be posted the caller never learns
  // the id, so nothing else could ever clean the session up.
  try {
    await deps.api.postUserMessage(created.id, args.prompt);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    let cleanup: string;
    try {
      await deps.api.deleteSession(created.id);
      cleanup = "The session has been deleted.";
    } catch (deleteError) {
      const deleteReason = deleteError instanceof Error ? deleteError.message : String(deleteError);
      cleanup = `Deleting it also failed (${deleteReason}) — it is still running and must be removed by hand.`;
    }
    throw new Error(
      `Session ${created.id} was created in "${bridge.name}" but its first prompt could not be ` +
      `posted (${reason}). ${cleanup}`,
      { cause: error },
    );
  }

  return { session_id: created.id, instance: bridge.name, title };
}

export async function sendMessage(
  deps: ToolDeps,
  args: { session_id: string; text: string },
): Promise<{ delivered: true }> {
  await deps.api.postUserMessage(args.session_id, args.text);
  return { delivered: true };
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
          const payload = frame.payload as { event_type?: string; payload?: Record<string, unknown> };
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
  return {
    session: toSummary(await deps.api.unarchiveSession(args.session_id)),
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
