import { readFile, stat } from "node:fs/promises";

export class CredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialsError";
  }
}

export interface TokenReader {
  read(): Promise<string>;
  /** Forget the cached token, so the next read goes back to disk. */
  invalidate(): void;
}

/**
 * Reads the claude.ai OAuth token Claude Code maintains. There is no refresh
 * flow here on purpose: Claude Code refreshes that file itself, so the cache is
 * keyed on the file's mtime and a 401 is answered by invalidating and retrying.
 */
export function createTokenReader(path: string): TokenReader {
  let cached: { token: string; mtimeMs: number } | null = null;

  return {
    invalidate() {
      cached = null;
    },
    async read(): Promise<string> {
      const info = await stat(path).catch(() => null);
      if (info === null) {
        throw new CredentialsError(
          `No Claude Code credentials at ${path}. Run \`claude /login\` on this machine.`,
        );
      }
      if (cached && cached.mtimeMs === info.mtimeMs) return cached.token;

      const raw = await readFile(path, "utf8");
      let token: unknown;
      try {
        token = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } })
          .claudeAiOauth?.accessToken;
      } catch {
        throw new CredentialsError(`Credentials file ${path} is not valid JSON.`);
      }
      if (typeof token !== "string" || token.length === 0) {
        throw new CredentialsError(
          `Credentials file ${path} holds no claude.ai OAuth token. Run \`claude /login\`.`,
        );
      }
      cached = { token, mtimeMs: info.mtimeMs };
      return token;
    },
  };
}
