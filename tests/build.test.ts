import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// tsc does not preserve or set the executable bit on its output, so
// dist/cli.js loses +x on every `npm run build` unless something restores
// it. npm runs a `postbuild` script automatically after `build` (and
// `npm run release` calls `build` internally), so pinning that script here
// is what keeps the ~/.local/bin/claude-sessions symlink working.
describe("build scripts", () => {
  it("restores the executable bit on dist/cli.js after every build", async () => {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts.postbuild).toBe("chmod +x dist/cli.js");
  });
});
