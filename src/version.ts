import { readFileSync } from "node:fs";

/**
 * The server's version, read from package.json — the one place it is written.
 *
 * Resolved relative to this module, so it works both from `src/` under the
 * test runner and from `dist/` at runtime: in both layouts the file sits one
 * directory up.
 */
export const VERSION: string = readVersion();

function readVersion(): string {
  const packageJson = new URL("../package.json", import.meta.url);
  const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`No version in ${packageJson.pathname}`);
  }
  return parsed.version;
}
