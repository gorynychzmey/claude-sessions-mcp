import { join } from "node:path";
import { archiveSession, requireInstance, spawnSession, waitForIdle, type ToolDeps } from "./tools.js";

/** Marks a session as a Vector Prime task run; the Primes hook keys on it. */
export const VECTOR_TAG = "role:vector-prime";
export const DEFAULT_TIMEOUT_MIN = 60;

export interface TaskSpec {
  cron: string;
  prompt_file: string;
  timeout_min?: number;
  model?: string;
}

export interface RunDeps extends ToolDeps {
  readFile(path: string): Promise<string>;
}

export interface RunReport {
  ok: boolean;
  sessionId: string | null;
  outcome: string;
  detail: string;
}

/** `vts--ci-monitor` (systemd instance) or `vts ci-monitor`. */
export function parseTarget(args: string[]): { instance: string; task: string } {
  if (args.length === 2 && args[0] && args[1]) return { instance: args[0], task: args[1] };
  const [one] = args;
  const cut = one?.indexOf("--") ?? -1;
  if (args.length === 1 && one && cut > 0 && cut < one.length - 2) {
    return { instance: one.slice(0, cut), task: one.slice(cut + 2) };
  }
  throw new Error("usage: claude-sessions run <instance--task> | <instance> <task>");
}

async function loadSpec(deps: RunDeps, cwd: string, task: string): Promise<TaskSpec> {
  const path = join(cwd, ".claude", "background", "tasks.json");
  const parsed = JSON.parse(await deps.readFile(path)) as { tasks?: Record<string, TaskSpec> };
  const spec = parsed.tasks?.[task];
  if (!spec) throw new Error(`Task "${task}" is not defined in ${path}`);
  return spec;
}

export async function runTask(deps: RunDeps, instance: string, task: string): Promise<RunReport> {
  // Both checks happen before anything is created, so a misconfigured timer
  // fails without leaving a session behind.
  const bridge = await requireInstance(deps, instance);
  const spec = await loadSpec(deps, bridge.cwd, task);
  const promptPath = join(bridge.cwd, ".claude", "background", spec.prompt_file);

  const { session_id } = await spawnSession(deps, {
    instance,
    title: `Вектор Прайм · ${task}`,
    prompt: `Background task ${task} firing. Read \`${promptPath}\` and follow it exactly. ` +
      "Be terse. End your turn cleanly.",
    caller: "vector-task",
    permission_mode: "auto",
    tags: [VECTOR_TAG],
    model: spec.model,
  });

  let report: RunReport;
  try {
    const timeoutMin = spec.timeout_min ?? DEFAULT_TIMEOUT_MIN;
    const waited = await waitForIdle(deps, { session_id, timeout_s: timeoutMin * 60 });
    const failed = !waited.finished || waited.outcome !== "result" || waited.result?.isError === true;
    report = {
      ok: !failed,
      sessionId: session_id,
      outcome: waited.outcome,
      detail: waited.result?.text ?? waited.note ?? "",
    };
  } catch (error) {
    report = { ok: false, sessionId: session_id, outcome: "error", detail: String(error) };
  }

  // Archive in every outcome: an unarchived run keeps a bridge slot, and on
  // timeout archiving is what stops the worker.
  try {
    await archiveSession(deps, { session_id });
  } catch (error) {
    report = { ...report, ok: false, detail: `${report.detail}\narchive failed: ${String(error)}`.trim() };
  }
  return report;
}
