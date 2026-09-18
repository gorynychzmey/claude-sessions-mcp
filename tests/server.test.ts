import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server.js";

describe("loadConfig", () => {
  it("defaults to the loopback interface and a spawn ceiling of three", () => {
    const config = loadConfig({ HOME: "/home/example" } as NodeJS.ProcessEnv);
    expect(config).toMatchObject({ host: "127.0.0.1", port: 8765, maxSpawned: 3 });
    expect(config.credentialsPath).toBe("/home/example/.claude/.credentials.json");
    expect(config.claudeConfigDir).toBe("/home/example/.claude");
  });

  it("takes overrides from the environment", () => {
    const config = loadConfig({
      HOME: "/home/example", PORT: "9000",
      CLAUDE_SESSIONS_MCP_MAX_SPAWNED: "5",
      CLAUDE_CONFIG_DIR: "/etc/claude",
    } as NodeJS.ProcessEnv);
    expect(config).toMatchObject({ port: 9000, maxSpawned: 5, claudeConfigDir: "/etc/claude" });
  });

  it("refuses to bind anything but the loopback", () => {
    expect(() => loadConfig({ HOME: "/home/example", HOST: "0.0.0.0" } as NodeJS.ProcessEnv))
      .toThrow(/loopback/i);
  });
});
