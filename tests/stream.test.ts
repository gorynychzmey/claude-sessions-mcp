import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionsApi } from "../src/api.js";
import { parseSse } from "../src/stream.js";

async function* chunks(...parts: string[]) {
  for (const part of parts) yield part;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

describe("parseSse", () => {
  it("reads named events with their ids", async () => {
    const messages = await collect(parseSse(chunks(
      "event: session_update\ndata: {\"connection_status\":\"connected\"}\n\n",
      "event: client_event\nid: 7\ndata: {\"event_type\":\"assistant\"}\n\n",
    )));
    expect(messages).toEqual([
      { event: "session_update", id: null, data: "{\"connection_status\":\"connected\"}" },
      { event: "client_event", id: "7", data: "{\"event_type\":\"assistant\"}" },
    ]);
  });

  it("reassembles a message split across chunk boundaries", async () => {
    const messages = await collect(parseSse(chunks("event: client_event\nid: 1\nda", "ta: {\"a\":1}\n\nevent: x\ndata: {}\n\n")));
    expect(messages.map((m) => m.data)).toEqual(["{\"a\":1}", "{}"]);
  });

  it("skips keepalive comments", async () => {
    const messages = await collect(parseSse(chunks(":keepalive\n\nevent: client_event\ndata: {}\n\n")));
    expect(messages).toHaveLength(1);
  });

  it("joins multi-line data fields with newlines, as the SSE spec requires", async () => {
    const messages = await collect(parseSse(chunks("data: line one\ndata: line two\n\n")));
    expect(messages[0].data).toBe("line one\nline two");
  });
});

describe("SessionsApi.streamEvents", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips an unparseable frame with a console.warn, and still yields the frame after it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode("event: client_event\nid: 1\ndata: not json\n\n"));
        controller.enqueue(encoder.encode("event: client_event\nid: 2\ndata: {\"event_type\":\"assistant\"}\n\n"));
        controller.close();
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));

    const token = { read: async () => "tok", invalidate: vi.fn() };
    const api = new SessionsApi({ token, fetchImpl: fetchImpl as unknown as typeof fetch });

    const received: unknown[] = [];
    for await (const frame of api.streamEvents("s-1", { signal: new AbortController().signal })) {
      received.push(frame);
    }

    expect(received).toEqual([
      { id: "2", event: "client_event", payload: { event_type: "assistant" } },
    ]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("id=1");
    expect(warn.mock.calls[0][0]).toContain("not json");
  });
});
