import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server.js";

describe("loadConfig", () => {
  it("defaults to the loopback interface and a spawn ceiling of six", () => {
    const config = loadConfig({ HOME: "/home/example" } as NodeJS.ProcessEnv);
    expect(config).toMatchObject({ host: "127.0.0.1", port: 8765, maxSpawned: 6 });
    expect(config.credentialsPath).toBe("/home/example/.claude/.credentials.json");
    expect(config.claudeConfigDir).toBe("/home/example/.claude");
    expect(config.stateDir).toBe("/home/example/.local/state/claude-sessions-mcp/spawned");
  });

  it("keeps the spawn registry under XDG_STATE_HOME, or where it is told", () => {
    expect(loadConfig({ HOME: "/h", XDG_STATE_HOME: "/var/st" } as NodeJS.ProcessEnv).stateDir)
      .toBe("/var/st/claude-sessions-mcp/spawned");
    expect(loadConfig({ HOME: "/h", CLAUDE_SESSIONS_MCP_STATE_DIR: "/srv/reg" } as NodeJS.ProcessEnv).stateDir)
      .toBe("/srv/reg");
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
