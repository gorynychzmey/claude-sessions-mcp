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
      let info;
      try {
        info = await stat(path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          throw new CredentialsError(
            `No Claude Code credentials at ${path}. Run \`claude /login\` on this machine.`,
          );
        }
        // Anything else — EACCES, ENOTDIR, EIO — is a file that exists and
        // cannot be read. Sending the user to `claude /login` would send them
        // to fix the wrong thing.
        throw new CredentialsError(
          `Cannot read the credentials file ${path} (${code ?? "unknown error"}: ` +
          `${(error as Error).message}). The server must run as the user that owns that file.`,
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
