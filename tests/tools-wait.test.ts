import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api.js";
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconnects after a dropped connection rather than failing the wait", async () => {
    let call = 0;
    const streamEvents = vi.fn(async function* (_id: string, _opts: { lastEventId?: string }) {
      if (call === 0) {
        call++;
        yield { id: "7", event: "client_event", payload: { event_type: "assistant", payload: {} } };
        throw new Error("ECONNRESET");
      }
      call++;
      yield resultEvent;
    });
    const toolDeps = {
      api: { streamEvents }, discovery: {}, maxSpawned: 3,
    } as unknown as ToolDeps;

    vi.useFakeTimers();
    const outcome = waitForIdle(toolDeps, { session_id: "s-1", timeout_s: 5 });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await outcome;

    expect(result.finished).toBe(true);
    expect(result.result).toEqual({
      text: "done", isError: false, stopReason: "end_turn",
      numTurns: 1, permissionDenials: [], costUsd: 0.25,
    });
    expect(streamEvents.mock.calls[1][1]).toMatchObject({ lastEventId: "7" });
  });

  it("rejects immediately on a non-retriable 4xx instead of waiting out the timeout", async () => {
    const streamEvents = vi.fn(async function* (_id: string, _opts: { lastEventId?: string }) {
      throw new ApiError("no such session", 404, null);
    });
    const toolDeps = {
      api: { streamEvents }, discovery: {}, maxSpawned: 3,
    } as unknown as ToolDeps;

    await expect(waitForIdle(toolDeps, { session_id: "s-1", timeout_s: 5 }))
      .rejects.toThrow(ApiError);
    expect(streamEvents).toHaveBeenCalledTimes(1);
  });
});
