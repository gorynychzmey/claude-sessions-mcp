#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SessionsApi } from "./api.js";
import { createTokenReader } from "./credentials.js";
import { defaultDiscoveryDeps } from "./discovery.js";
import { parseTarget, runTask as runTaskImpl, type RunReport } from "./run.js";
import { loadConfig } from "./server.js";

export interface CliDeps {
  api: Pick<SessionsApi, "getSession" | "archiveSession">;
  runTask(instance: string, task: string): Promise<RunReport>;
  write(s: string): void;
  warn(s: string): void;
}

const USAGE = "usage: claude-sessions run <instance--task> | show <session-id> | archive <session-id>";

export async function main(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "run": {
        const { instance, task } = parseTarget(rest);
        let report: RunReport;
        try {
          report = await deps.runTask(instance, task);
        } catch (error) {
          deps.warn(`${error instanceof Error ? error.message : String(error)}\n`);
          return 2;
        }
        deps.write(`${JSON.stringify(report)}\n`);
        if (!report.ok) deps.warn(`task ${instance}/${task} failed: ${report.outcome} ${report.detail}\n`);
        return report.ok ? 0 : 1;
      }
      case "show": {
        if (!rest[0]) throw new Error(USAGE);
        const s = await deps.api.getSession(rest[0]);
        deps.write(`${JSON.stringify({ id: s.id, title: s.title ?? "", status: s.status ?? "", tags: s.tags ?? [] })}\n`);
        return 0;
      }
      case "archive": {
        if (!rest[0]) throw new Error(USAGE);
        await deps.api.archiveSession(rest[0]);
        return 0;
      }
      default:
        deps.warn(`${USAGE}\n`);
        return 2;
    }
  } catch (error) {
    deps.warn(`${error instanceof Error ? error.message : String(error)}\n`);
    return command === "run" ? 2 : 1;
  }
}

function productionDeps(): CliDeps {
  const config = loadConfig(process.env);
  const api = new SessionsApi({ token: createTokenReader(config.credentialsPath) });
  const toolDeps = {
    api, discovery: defaultDiscoveryDeps(config.claudeConfigDir), maxSpawned: config.maxSpawned,
    readFile: (p: string) => readFile(p, "utf8"),
  };
  return {
    api,
    runTask: (instance, task) => runTaskImpl(toolDeps, instance, task),
    write: (s) => process.stdout.write(s),
    warn: (s) => process.stderr.write(s),
  };
}

// Run only when executed, not when imported by tests. realpath: the installed
// entry point is a symlink in ~/.local/bin.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), productionDeps()).then((code) => process.exit(code));
}
