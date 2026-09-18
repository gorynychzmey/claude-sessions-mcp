// Usage: node scripts/e2e.mjs <instance-name>
// Spawns a session in a running bridge, waits for its answer, deletes it.
import { SessionsApi } from "../dist/api.js";
import { createTokenReader } from "../dist/credentials.js";
import { defaultDiscoveryDeps } from "../dist/discovery.js";
import { deleteSession, spawnSession, waitForIdle } from "../dist/tools.js";
import { join } from "node:path";

const instance = process.argv[2];
if (!instance) {
  console.error("usage: node scripts/e2e.mjs <instance-name>");
  process.exit(2);
}

const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME, ".claude");
const deps = {
  api: new SessionsApi({ token: createTokenReader(join(claudeConfigDir, ".credentials.json")) }),
  discovery: defaultDiscoveryDeps(claudeConfigDir),
  maxSpawned: 3,
};

const spawned = await spawnSession(deps, {
  instance,
  prompt: "Reply with the single word E2E_OK and stop. Do not use tools.",
  title: "claude-sessions-mcp e2e",
  effort: "low",
  caller: "e2e",
});
console.log("spawned", spawned.session_id);

let outcome;
try {
  outcome = await waitForIdle(deps, { session_id: spawned.session_id, timeout_s: 180 });
  console.log("outcome", JSON.stringify(outcome, null, 2));
} finally {
  // The delete has to run even when the wait throws, or the script leaves a
  // live agent behind holding a bridge slot.
  await deleteSession(deps, { session_id: spawned.session_id })
    .then(() => console.log("deleted"))
    .catch((error) => {
      console.error(`could not delete ${spawned.session_id}:`, error);
      process.exitCode = 1;
    });
}

if (!outcome.finished || !outcome.result?.text.includes("E2E_OK")) process.exit(1);
