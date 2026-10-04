#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionsApi } from "./api.js";
import { createTokenReader } from "./credentials.js";
import { defaultDiscoveryDeps } from "./discovery.js";
import { parseTarget, runTask as runTaskImpl, type GateState, type RunReport } from "./run.js";
import { reattachSessions } from "./tools.js";
import { loadConfig } from "./server.js";

export interface CliDeps {
  api: Pick<SessionsApi, "getSession" | "archiveSession">;
  runTask(instance: string, task: string): Promise<RunReport>;
  reattach(instance: string): Promise<unknown>;
  write(s: string): void;
  warn(s: string): void;
}

const USAGE = "usage: claude-sessions run <instance--task> | show <session-id> | archive <session-id> | reattach <instance>";

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
      case "reattach": {
        if (!rest[0]) throw new Error(USAGE);
        deps.write(`${JSON.stringify(await deps.reattach(rest[0]))}\n`);
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
    exec: execPrecheck,
    readState: async (key: string): Promise<GateState | null> => {
      try {
        return JSON.parse(await readFile(join(gateStateDir(), `${key}.json`), "utf8")) as GateState;
      } catch {
        return null;
      }
    },
    writeState: async (key: string, value: GateState) => {
      const dir = gateStateDir();
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `.${key}.json.tmp`);
      await writeFile(tmp, `${JSON.stringify(value)}\n`);
      await rename(tmp, join(dir, `${key}.json`));
    },
    now: () => Date.now(),
  };
  return {
    api,
    runTask: (instance, task) => runTaskImpl(toolDeps, instance, task),
    reattach: (instance) => reattachWhenUp(toolDeps, instance),
    write: (s) => process.stdout.write(s),
    warn: (s) => process.stderr.write(s),
  };
}

function gateStateDir(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "vector-task");
}

/**
 * Run a task's precheck under bash in the project directory, with WORKDIR set
 * as the task prompts expect. Its stderr goes to ours, i.e. the unit's journal.
 */
function execPrecheck(command: string, cwd: string, timeoutMs: number): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", command], {
      cwd, env: { ...process.env, WORKDIR: cwd }, stdio: ["ignore", "pipe", "inherit"], timeout: timeoutMs,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.on("error", reject);
    // A timeout kills the child: code is null, which the gate treats as failed.
    child.on("close", (code) => resolve({ code: code ?? -1, stdout }));
  });
}

/**
 * Run from the bridge unit's ExecStartPost, which can fire before the new
 * bridge has registered and rewritten its pointer: retry the lookup for a
 * while instead of failing on the first miss.
 */
async function reattachWhenUp(toolDeps: Parameters<typeof reattachSessions>[0], instance: string) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      return await reattachSessions(toolDeps, { instance });
    } catch (error) {
      if (Date.now() > deadline || !String(error).includes("No running bridge")) throw error;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// Run only when executed, not when imported by tests. realpath: the installed
// entry point is a symlink in ~/.local/bin.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), productionDeps()).then((code) => process.exit(code));
}
