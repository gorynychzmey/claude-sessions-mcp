import type { TokenReader } from "./credentials.js";
import { parseSse } from "./stream.js";

export const DEFAULT_BASE_URL = "https://api.anthropic.com";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly requestId: string | null) {
    super(message);
    this.name = "ApiError";
  }
}

export interface RawSession {
  id: string;
  title?: string;
  status?: string;
  status_bucket?: string;
  worker_status?: string;
  connection_status?: string;
  environment_id?: string;
  last_event_at?: string;
  tags?: string[];
}

export interface RawEvent {
  event_id?: string;
  sequence_num?: string;
  event_type?: string;
  payload?: Record<string, unknown>;
  created_at?: string;
}

export interface CreateSessionInput {
  environmentId: string;
  title: string;
  tags: string[];
  effort: string;
  permissionMode: string;
}

export interface SessionsApiOptions {
  token: TokenReader;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
}

const RETRIABLE = (status: number) => status === 429 || status >= 500;

export class SessionsApi {
  private readonly token: TokenReader;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelayMs: number;

  constructor(options: SessionsApiOptions) {
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.retryDelayMs = options.retryDelayMs ?? 500;
  }

  async headers(): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await this.token.read()}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    };
  }

  url(path: string): string {
    return `${this.baseUrl}/v1/code/sessions${path}`;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      const response = await this.fetchImpl(this.url(path), {
        ...init,
        headers: await this.headers(),
        signal: AbortSignal.timeout(30_000),
      });

      if (response.ok) {
        const text = await response.text();
        return text.length > 0 ? JSON.parse(text) : {};
      }

      const requestId = response.headers.get("request-id");
      const body = await response.text();

      if (response.status === 401 && !refreshed) {
        this.token.invalidate();
        refreshed = true;
        continue;
      }
      if (response.status === 401) {
        throw new ApiError(
          "claude.ai rejected the stored token. Run `claude /login` on this machine.",
          401, requestId,
        );
      }
      if (RETRIABLE(response.status) && attempt < 3) {
        await new Promise((r) => setTimeout(r, this.retryDelayMs * attempt));
        continue;
      }
      throw new ApiError(
        `${init.method ?? "GET"} ${path} failed (${response.status}): ${body.slice(0, 300)}`,
        response.status, requestId,
      );
    }
  }

  async createSession(input: CreateSessionInput): Promise<RawSession> {
    const body = await this.request("", {
      method: "POST",
      body: JSON.stringify({
        environment_id: input.environmentId,
        title: input.title,
        tags: input.tags,
        config: {
          effort_level: input.effort,
          permission_mode: input.permissionMode,
          origin: "cli",
        },
      }),
    }) as { session: RawSession };
    return body.session;
  }

  async postUserMessage(sessionId: string, text: string): Promise<void> {
    await this.request(`/${sessionId}/events`, {
      method: "POST",
      body: JSON.stringify({
        events: [{
          event_type: "user_message",
          payload: { type: "user", message: { role: "user", content: text } },
        }],
      }),
    });
  }

  async listSessions(limit = 100): Promise<RawSession[]> {
    // The API ignores query filters such as environment_id, so callers filter
    // client-side on what comes back.
    const body = await this.request(`?limit=${limit}`) as { data?: RawSession[] };
    return body.data ?? [];
  }

  async getSession(sessionId: string): Promise<RawSession> {
    // Only this endpoint wraps the session in response_shape.
    const body = await this.request(`/${sessionId}`) as
      { response_shape?: RawSession; session?: RawSession };
    const session = body.response_shape ?? body.session;
    if (!session) throw new ApiError(`Session ${sessionId} came back empty`, 200, null);
    return session;
  }

  async listEvents(
    sessionId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<{ events: RawEvent[]; resumeCursor: string | null }> {
    const query = new URLSearchParams({ limit: String(options.limit ?? 40) });
    if (options.cursor) query.set("cursor", options.cursor);
    const body = await this.request(`/${sessionId}/events?${query}`) as
      { data?: RawEvent[]; resume_cursor?: string };
    return { events: body.data ?? [], resumeCursor: body.resume_cursor ?? null };
  }

  async archiveSession(sessionId: string): Promise<RawSession> {
    return (await this.request(`/${sessionId}/archive`, { method: "POST" }) as
      { session: RawSession }).session;
  }

  async unarchiveSession(sessionId: string): Promise<RawSession> {
    return (await this.request(`/${sessionId}/unarchive`, { method: "POST" }) as
      { session: RawSession }).session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request(`/${sessionId}`, { method: "DELETE" });
  }

  /**
   * Live events for one session. Resumes from `lastEventId` when given, which
   * is what makes a dropped connection cost a reconnect rather than a missed
   * result.
   */
  async *streamEvents(
    sessionId: string,
    options: { lastEventId?: string; signal: AbortSignal },
  ): AsyncGenerator<{ id: string | null; event: string | null; payload: unknown }> {
    const headers: Record<string, string> = {
      ...(await this.headers()),
      accept: "text/event-stream",
    };
    if (options.lastEventId) headers["last-event-id"] = options.lastEventId;

    const response = await this.fetchImpl(this.url(`/${sessionId}/events/stream`), {
      headers,
      signal: options.signal,
    });
    if (!response.ok || !response.body) {
      throw new ApiError(
        `stream ${sessionId} failed (${response.status})`,
        response.status,
        response.headers.get("request-id"),
      );
    }

    const decoder = new TextDecoder();
    const body = response.body;
    async function* text(): AsyncGenerator<string> {
      for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
        yield decoder.decode(bytes, { stream: true });
      }
    }

    for await (const message of parseSse(text())) {
      let payload: unknown = null;
      try {
        payload = JSON.parse(message.data);
      } catch {
        continue; // a frame we cannot read is not a reason to end the wait
      }
      yield { id: message.id, event: message.event, payload };
    }
  }
}
