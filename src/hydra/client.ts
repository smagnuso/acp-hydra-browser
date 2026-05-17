import { logger } from "../util/log.js";

const log = logger("hydra-rest");

export interface HydraSessionInfo {
  sessionId: string;
  cwd: string;
  agentId: string | undefined;
  title: string | undefined;
  attachedClients: number;
  updatedAt: string;
  status: "live" | "cold";
}

export interface HydraAgentInfo {
  id: string;
  name?: string;
  version?: string;
  description?: string;
  // Whatever the registry exposes; passed through.
  [key: string]: unknown;
}

export class HydraRestClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  static forRequest(baseUrl: string, token: string): HydraRestClient {
    return new HydraRestClient(baseUrl, token);
  }

  get bearerToken(): string {
    return this.token;
  }

  private async json<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    const init: RequestInit = { method, headers };
    // Only set Content-Type when there's a body. Fastify v5 rejects
    // POST with Content-Type: application/json and an empty body
    // (FST_ERR_CTP_EMPTY_JSON_BODY), which broke bodyless POSTs like
    // /v1/sessions/:id/kill.
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const r = await fetch(`${this.baseUrl}${path}`, init);
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      log.warn(`${method} ${path} → ${r.status} ${text.slice(0, 200)}`);
      throw new HydraRestError(r.status, `${method} ${path}: ${r.status}`);
    }
    if (r.status === 204) {
      return undefined as T;
    }
    return (await r.json()) as T;
  }

  async health(): Promise<{ status: string; version?: string }> {
    return this.json("GET", "/v1/health");
  }

  async listSessions(opts?: {
    cwd?: string;
    all?: boolean;
  }): Promise<{ sessions: HydraSessionInfo[] }> {
    const qs = new URLSearchParams();
    if (opts?.cwd) {
      qs.set("cwd", opts.cwd);
    }
    if (opts?.all) {
      qs.set("all", "true");
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.json("GET", `/v1/sessions${suffix}`);
  }

  async killSession(sessionId: string): Promise<void> {
    await this.json(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/kill`,
    );
  }

  async listAgents(): Promise<{ agents: HydraAgentInfo[] }> {
    return this.json("GET", "/v1/agents");
  }

  async getConfig(): Promise<{ defaultAgent: string; defaultCwd: string }> {
    return this.json("GET", "/v1/config");
  }

  // Fetch the raw response so the proxy can stream the JSON body straight
  // to the client and forward the daemon's Content-Disposition filename.
  // Throws HydraRestError on non-2xx. Caller is responsible for consuming
  // (or piping) response.body.
  async fetchExport(sessionId: string): Promise<Response> {
    const r = await fetch(
      `${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/export`,
      { headers: { Authorization: `Bearer ${this.token}` } },
    );
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      log.warn(
        `GET /v1/sessions/${sessionId}/export → ${r.status} ${text.slice(0, 200)}`,
      );
      throw new HydraRestError(
        r.status,
        `GET /v1/sessions/:id/export: ${r.status}`,
      );
    }
    return r;
  }

  async importBundle(
    bundle: unknown,
    opts: { replace?: boolean } = {},
  ): Promise<{
    sessionId: string;
    importedFromSessionId: string;
    replaced: boolean;
  }> {
    return this.json("POST", "/v1/sessions/import", {
      bundle,
      replace: opts.replace === true,
    });
  }
}

export class HydraRestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HydraRestError";
  }
}
