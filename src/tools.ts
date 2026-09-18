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
  const match = found.find((i) => i.name === name);
  if (!match) {
    const known = found.map((i) => i.name).join(", ") || "none";
    throw new Error(`No running bridge named "${name}" on this machine. Running: ${known}.`);
  }
  return match;
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

  const existing = await deps.api.listSessions();
  const mine = existing.filter((s) =>
    s.environment_id === bridge.environmentId &&
    s.status === "active" &&
    (s.tags ?? []).includes(SERVER_TAG));
  if (mine.length >= deps.maxSpawned) {
    throw new Error(
      `Spawn ceiling reached: ${mine.length} of ${deps.maxSpawned} sessions in "${bridge.name}" ` +
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

  await deps.api.postUserMessage(created.id, args.prompt);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForIdle(
  deps: ToolDeps,
  args: { session_id: string; timeout_s?: number },
): Promise<{ finished: boolean; result?: TurnResult; note?: string }> {
  const timeoutMs = (args.timeout_s ?? 300) * 1000;
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let lastEventId: string | undefined;

  try {
    while (Date.now() < deadline) {
      try {
        for await (const frame of deps.api.streamEvents(args.session_id, {
          lastEventId,
          signal: controller.signal,
        })) {
          if (frame.id) lastEventId = frame.id;
          const payload = frame.payload as { event_type?: string; payload?: Record<string, unknown> };
          if (payload?.event_type === "result" && payload.payload) {
            return { finished: true, result: toTurnResult(payload.payload) };
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
      if (controller.signal.aborted) break;
      // Every reconnect waits, not only the ones that follow an error: a
      // stream that ends cleanly and immediately (an idle connection the
      // server closed, a bridge restart, an empty stream) would otherwise
      // be reopened thousands of times inside one timeout.
      await sleep(RECONNECT_DELAY_MS);
    }
    return {
      finished: false,
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
