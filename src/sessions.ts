import type { RawEvent, RawSession } from "./api.js";
import type { SessionSummary, TurnResult } from "./types.js";

export const SERVER_TAG = "mcp:claude-sessions-mcp";
const SPAWNED_BY = "spawned-by:";

/** Event kinds that describe the machinery rather than the conversation. */
const NOISE = new Set(["control_request", "env_manager_log", "system", "rate_limit_event"]);

export function toSummary(raw: RawSession): SessionSummary {
  const tags = raw.tags ?? [];
  const spawnedBy = tags.find((t) => t.startsWith(SPAWNED_BY))?.slice(SPAWNED_BY.length) ?? null;
  return {
    id: raw.id,
    title: raw.title ?? "",
    status: raw.status ?? "",
    statusBucket: raw.status_bucket ?? "",
    workerStatus: raw.worker_status ?? "",
    connectionStatus: raw.connection_status ?? "",
    environmentId: raw.environment_id ?? "",
    lastEventAt: raw.last_event_at ?? "",
    spawnedBy,
    createdByThisServer: tags.includes(SERVER_TAG),
  };
}

export interface CondensedEvent {
  at: string | null;
  kind: string;
  text: string | null;
}

export function condenseEvents(events: RawEvent[], verbose: boolean): CondensedEvent[] {
  const kept = verbose ? events : events.filter((e) => !NOISE.has(e.event_type ?? ""));
  return kept.map((event) => ({
    at: event.created_at ?? null,
    kind: event.event_type ?? "unknown",
    text: textOf(event),
  }));
}

function textOf(event: RawEvent): string | null {
  const payload = (event.payload ?? {}) as {
    message?: { content?: unknown };
    result?: unknown;
  };
  if (event.event_type === "result") {
    return typeof payload.result === "string" ? payload.result : null;
  }
  const content = payload.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((c): c is { type: string; text: string } =>
        typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text")
      .map((c) => c.text);
    return parts.length > 0 ? parts.join("\n") : null;
  }
  return null;
}

/** Reads the outcome of a turn out of a `result` event's payload. */
export function toTurnResult(payload: Record<string, unknown>): TurnResult {
  return {
    text: typeof payload.result === "string" ? payload.result : "",
    isError: payload.is_error === true,
    stopReason: typeof payload.stop_reason === "string" ? payload.stop_reason : null,
    numTurns: typeof payload.num_turns === "number" ? payload.num_turns : null,
    permissionDenials: Array.isArray(payload.permission_denials) ? payload.permission_denials : [],
    costUsd: typeof payload.total_cost_usd === "number" ? payload.total_cost_usd : null,
  };
}
