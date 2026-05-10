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

  private async json<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
    };
    if (body !== undefined) {
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

  async deleteSession(sessionId: string): Promise<void> {
    await this.json(
      "DELETE",
      `/v1/sessions/${encodeURIComponent(sessionId)}`,
    );
  }

  async listAgents(): Promise<{ agents: HydraAgentInfo[] }> {
    return this.json("GET", "/v1/agents");
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
