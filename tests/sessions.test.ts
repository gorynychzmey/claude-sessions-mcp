import { describe, expect, it } from "vitest";
import { SERVER_TAG, condenseEvents, toSummary } from "../src/sessions.js";

describe("toSummary", () => {
  it("names the creator and flags sessions this server made", () => {
    const summary = toSummary({
      id: "s-1", title: "demo", status: "active", status_bucket: "working",
      worker_status: "running", connection_status: "connected",
      environment_id: "env-1", last_event_at: "2026-01-01T00:00:00Z",
      tags: [SERVER_TAG, "spawned-by:alpha"],
    });
    expect(summary.spawnedBy).toBe("alpha");
    expect(summary.createdByThisServer).toBe(true);
  });

  it("tolerates a session with no tags and no title", () => {
    const summary = toSummary({ id: "s-2" });
    expect(summary).toMatchObject({ id: "s-2", title: "", spawnedBy: null, createdByThisServer: false });
  });
});

describe("condenseEvents", () => {
  const events = [
    { event_type: "user", created_at: "t1", payload: { message: { content: "do the thing" } } },
    { event_type: "assistant", created_at: "t2", payload: { message: { content: [{ type: "text", text: "done" }] } } },
    { event_type: "control_request", created_at: "t3", payload: {} },
    { event_type: "env_manager_log", created_at: "t4", payload: {} },
    { event_type: "result", created_at: "t5", payload: { subtype: "success", result: "done" } },
  ];

  it("keeps the conversation and drops the machinery", () => {
    expect(condenseEvents(events, false)).toEqual([
      { at: "t1", kind: "user", text: "do the thing" },
      { at: "t2", kind: "assistant", text: "done" },
      { at: "t5", kind: "result", text: "done" },
    ]);
  });

  it("keeps the machinery when asked", () => {
    expect(condenseEvents(events, true).map((e) => e.kind)).toEqual([
      "user", "assistant", "control_request", "env_manager_log", "result",
    ]);
  });
});
