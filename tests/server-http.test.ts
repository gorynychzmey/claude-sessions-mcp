import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createRequestHandler, loopbackAllowedHosts } from "../src/server.js";
import { VERSION } from "../src/version.js";
import type { ToolDeps } from "../src/tools.js";

// The tools are never invoked here: initialize and tools/list only need the
// registrations, not a bridge or the API.
const deps = { maxSpawned: 3 } as unknown as ToolDeps;

let running: Server | null = null;

async function startServer(): Promise<{ url: string; host: string }> {
  const allowedHosts: string[] = [];
  const server = createServer(createRequestHandler(deps, { allowedHosts }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  running = server;
  const { port } = server.address() as AddressInfo;
  allowedHosts.push(...loopbackAllowedHosts(port));
  return { url: `http://127.0.0.1:${port}/mcp`, host: `127.0.0.1:${port}` };
}

afterEach(async () => {
  const server = running;
  running = null;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function rpc(url: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

const initialize = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.0.0" },
  },
};
const toolsList = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/list", params: {} });

describe("the HTTP endpoint", () => {
  it("answers consecutive requests, because each POST gets a fresh transport", async () => {
    const { url } = await startServer();

    const first = await rpc(url, initialize);
    const second = await rpc(url, toolsList(2));
    const third = await rpc(url, toolsList(3));

    expect(first.status).toBe(200);
    expect(first.text).toContain("claude-sessions-mcp");
    // The handshake reports the package's version, not a copy of it that can
    // drift: a release bumps package.json and nothing else.
    expect(first.text).toContain(`"version":"${VERSION}"`);
    for (const answer of [second, third]) {
      expect(answer.status).toBe(200);
      expect(answer.text).toContain("spawn_session");
      expect(answer.text).not.toContain("cannot be reused");
    }
  });

  it("refuses a request carrying a foreign Host header", async () => {
    const { host } = await startServer();
    // fetch() will not let the Host header be set, so this one goes out raw.
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: Number(host.split(":")[1]),
        path: "/mcp",
        method: "POST",
        headers: {
          host: "attacker.example",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
      }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end(JSON.stringify(initialize));
    });
    expect(status).toBe(403);
  });

  it("serves POST only and 404s anything outside /mcp", async () => {
    const { url } = await startServer();
    const get = await fetch(url, { method: "GET" });
    expect(get.status).toBe(405);
    const elsewhere = await fetch(url.replace("/mcp", "/other"), { method: "POST" });
    expect(elsewhere.status).toBe(404);
  });
});
