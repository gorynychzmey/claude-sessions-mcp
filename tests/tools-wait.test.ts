import { describe, expect, it, vi } from "vitest";
import { waitForIdle } from "../src/tools.js";
import type { ToolDeps } from "../src/tools.js";

const resultEvent = {
  id: "12", event: "client_event",
  payload: {
    event_type: "result",
    payload: {
      subtype: "success", is_error: false, result: "done", num_turns: 1,
      stop_reason: "end_turn", permission_denials: [], total_cost_usd: 0.25,
    },
  },
};

function depsWithStream(
  frames: unknown[][],
): { toolDeps: ToolDeps; streamEvents: ReturnType<typeof vi.fn> } {
  let call = 0;
  const streamEvents = vi.fn(async function* (_id: string, _opts: { lastEventId?: string }) {
    for (const frame of frames[call] ?? []) yield frame;
    call++;
  });
  return {
    toolDeps: { api: { streamEvents }, discovery: {}, maxSpawned: 3 } as unknown as ToolDeps,
    streamEvents,
  };
}

describe("wait_for_idle", () => {
  it("returns the turn's result", async () => {
    const { toolDeps } = depsWithStream([[
      { id: "11", event: "client_event", payload: { event_type: "assistant", payload: {} } },
      resultEvent,
    ]]);

    const outcome = await waitForIdle(toolDeps, { session_id: "s-1", timeout_s: 5 });

    expect(outcome.finished).toBe(true);
    expect(outcome.result).toEqual({
      text: "done", isError: false, stopReason: "end_turn",
      numTurns: 1, permissionDenials: [], costUsd: 0.25,
    });
  });

  it("reconnects from the last seen id when the stream ends early", async () => {
    const { toolDeps, streamEvents } = depsWithStream([
      [{ id: "5", event: "client_event", payload: { event_type: "assistant", payload: {} } }],
      [resultEvent],
    ]);

    const outcome = await waitForIdle(toolDeps, { session_id: "s-1", timeout_s: 5 });

    expect(outcome.finished).toBe(true);
    expect(streamEvents.mock.calls[1][1]).toMatchObject({ lastEventId: "5" });
  });

  it("says the session is still working when the timeout expires", async () => {
    const { toolDeps } = depsWithStream([[], [], []]);
    const outcome = await waitForIdle(toolDeps, { session_id: "s-1", timeout_s: 0 });
    expect(outcome).toMatchObject({ finished: false });
    expect(outcome.note).toMatch(/still working/i);
  });
});
