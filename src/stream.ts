export interface SseMessage {
  event: string | null;
  id: string | null;
  data: string;
}

/** Parses a server-sent event stream out of arbitrary text chunks. */
export async function* parseSse(chunks: AsyncIterable<string>): AsyncGenerator<SseMessage> {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk;
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const message = parseBlock(block);
      if (message) yield message;
      boundary = buffer.indexOf("\n\n");
    }
  }
}

function parseBlock(block: string): SseMessage | null {
  let event: string | null = null;
  let id: string | null = null;
  const data: string[] = [];

  for (const line of block.split("\n")) {
    if (line.startsWith(":") || line.length === 0) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "id") id = value;
    else if (field === "data") data.push(value);
  }

  return data.length > 0 ? { event, id, data: data.join("\n") } : null;
}
