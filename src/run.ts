import { createHash } from "node:crypto";
import { join } from "node:path";
import { archiveSession, requireInstance, spawnSession, waitForIdle, type ToolDeps } from "./tools.js";

/** Marks a session as a Vector Prime task run; the Primes hook keys on it. */
export const VECTOR_TAG = "role:vector-prime";
export const DEFAULT_TIMEOUT_MIN = 60;
/** A precheck is a cheap shell probe; anything slower is treated as failed. */
export const PRECHECK_TIMEOUT_MS = 60_000;

export interface TaskSpec {
  cron: string;
  prompt_file: string;
  timeout_min?: number;
  model?: string;
  /**
   * Permission mode of the spawned session (default "auto"). "dontAsk" turns a
   * tool call outside the project's allowlist into an immediate refusal instead
   * of a prompt nobody can answer in an unattended run, which would hold the
   * session until timeout_min. Validated by spawnSession.
   */
  permission_mode?: string;
  /**
   * Shell command run in the project directory before spawning. Its stdout
   * lists the work there is; the run is skipped when that is empty or the same
   * as at the last successful run. A non-zero exit runs the task anyway.
   */
  precheck?: string;
  /** Run even without new work once this many hours passed since the last real run. */
  precheck_max_skip_h?: number;
}

/** What the gate remembers about the last successful run of a task. */
export interface GateState {
  fingerprint: string;
  ranAt: number;
}

export interface RunDeps extends ToolDeps {
  readFile(path: string): Promise<string>;
  exec(command: string, cwd: string, timeoutMs: number): Promise<{ code: number; stdout: string }>;
  readState(key: string): Promise<GateState | null>;
  writeState(key: string, value: GateState): Promise<void>;
  now(): number;
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

type Gate = { skip: true; detail: string } | { skip: false; fingerprint: string | null };

/**
 * Decide whether a run has anything to do. Fails open: a precheck that errors
 * or exits non-zero lets the run through and records nothing, so a broken
 * probe costs money but never silently stops a task.
 */
async function precheckGate(deps: RunDeps, cwd: string, key: string, spec: TaskSpec): Promise<Gate> {
  if (!spec.precheck) return { skip: false, fingerprint: null };
  let out: { code: number; stdout: string };
  try {
    out = await deps.exec(spec.precheck, cwd, PRECHECK_TIMEOUT_MS);
  } catch {
    return { skip: false, fingerprint: null };
  }
  if (out.code !== 0) return { skip: false, fingerprint: null };

  const work = out.stdout.trim();
  const fingerprint = createHash("sha256").update(work).digest("hex");
  const last = await deps.readState(key);
  const maxSkipMs = (spec.precheck_max_skip_h ?? 0) * 3_600_000;
  if (maxSkipMs > 0 && (!last || deps.now() - last.ranAt >= maxSkipMs)) {
    return { skip: false, fingerprint };
  }
  if (work === "") return { skip: true, detail: "precheck: no work" };
  if (last?.fingerprint === fingerprint) return { skip: true, detail: "precheck: no new work since the last run" };
  return { skip: false, fingerprint };
}

export async function runTask(deps: RunDeps, instance: string, task: string): Promise<RunReport> {
  // Both checks happen before anything is created, so a misconfigured timer
  // fails without leaving a session behind.
  const bridge = await requireInstance(deps, instance);
  const spec = await loadSpec(deps, bridge.cwd, task);
  const stateKey = `${instance}--${task}`;
  const gate = await precheckGate(deps, bridge.cwd, stateKey, spec);
  if (gate.skip) return { ok: true, sessionId: null, outcome: "skipped", detail: gate.detail };
  const promptPath = join(bridge.cwd, ".claude", "background", spec.prompt_file);

  const { session_id } = await spawnSession(deps, {
    instance,
    title: `Вектор Прайм · ${task}`,
    prompt: `Background task ${task} firing. Read \`${promptPath}\` and follow it exactly. ` +
      "Be terse. End your turn cleanly.",
    caller: "vector-task",
    permission_mode: spec.permission_mode ?? "auto",
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
  // Only a successful run consumes the work it saw; after a failure the next
  // firing sees the same work and retries.
  if (report.ok && gate.fingerprint !== null) {
    await deps.writeState(stateKey, { fingerprint: gate.fingerprint, ranAt: deps.now() });
  }
  return report;
}
