import { describe, expect, it } from "vitest";
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
