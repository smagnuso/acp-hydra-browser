import { logger } from "../util/log.js";

const log = logger("hydra-rest");

export interface HydraWorkspaceInfo {
  path: string;
  sourceCwd: string;
  label: string;
  provider: string;
  snapshot?: string;
  vcs?: { kind: string; branch?: string };
  clean?: boolean;
}

export interface HydraSessionInfo {
  sessionId: string;
  cwd: string;
  agentId: string | undefined;
  title: string | undefined;
  attachedClients: number;
  updatedAt: string;
  status: "warm" | "cold";
  busy: boolean;
  awaitingInput: boolean;
  // User-set sort weight, toggled with `*` in the TUI picker. Absent/0
  // = normal, any positive integer = high priority.
  priority?: number;
  // Present only for a session running in an isolated workspace. Named
  // `workspace` on the wire (GET/POST /v1/sessions), not `workspaceInfo`
  // — that name is only used in the separate ACP `_meta["hydra-acp"]`
  // surface. See PROTOCOL.md's "Workspace isolation".
  workspace?: HydraWorkspaceInfo;
  // Present when isolation was requested and fell back to the source
  // tree. Live-only.
  workspaceError?: string;
}

// See cli's PROTOCOL.md "Remotes" section — a federated peer daemon
// registered via `hydra remote add`. `status` reflects the daemon's
// own periodic liveness poll, not a check made by this call.
export interface HydraRemoteInfo {
  name: string;
  host: string;
  port: number;
  label?: string;
  expiresAt: string;
  addedAt: string;
  status?: "ok" | "unauthorized" | "unreachable" | "unknown";
  lastCheckedAt?: string;
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
    // Some endpoints (killSession has been observed doing this) reply
    // success with an empty body on a status other than 204 — read as
    // text first and only parse if there's actually something there,
    // rather than assuming any non-204 2xx has a JSON body. r.json()
    // on an empty string throws "Unexpected end of JSON input", which
    // isn't a HydraRestError, so it was surfacing as a generic kill
    // failure even though the operation had already succeeded.
    const text = await r.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async health(): Promise<{ status: string; version?: string }> {
    return this.json("GET", "/v1/health");
  }

  async listSessions(opts?: {
    cwd?: string;
    all?: boolean;
    // Cursor from a previous listSessions() response. When set, the
    // daemon returns every warm session plus only the cold ones changed
    // since, instead of statting and serializing every cold record on
    // disk — see PROTOCOL.md's GET /v1/sessions `since=`.
    since?: number;
  }): Promise<{ sessions: HydraSessionInfo[]; removed: string[]; cursor: number }> {
    const qs = new URLSearchParams();
    if (opts?.cwd) {
      qs.set("cwd", opts.cwd);
    }
    if (opts?.all) {
      qs.set("all", "true");
    }
    if (opts?.since !== undefined) {
      qs.set("since", String(opts.since));
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const result = await this.json<{
      sessions?: HydraSessionInfo[];
      removed?: string[];
      cursor?: number;
    }>("GET", `/v1/sessions${suffix}`);
    return {
      sessions: result.sessions ?? [],
      removed: result.removed ?? [],
      cursor: result.cursor ?? 0,
    };
  }

  // Single-session equivalent of listSessions — used to keep one
  // session's live metadata (title/cwd/model/workspace) fresh while a
  // client is viewing it, without paying to list and serialize every
  // other session on the install just to read one entry back out.
  async getSession(sessionId: string): Promise<HydraSessionInfo> {
    return this.json("GET", `/v1/sessions/${encodeURIComponent(sessionId)}`);
  }

  async killSession(sessionId: string): Promise<void> {
    await this.json(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/kill`,
    );
  }

  // null clears back to normal priority — mirrors the daemon's own
  // PATCH contract (also used for rename), which treats null and 0
  // interchangeably as "clear".
  async setPriority(sessionId: string, priority: number | null): Promise<void> {
    await this.json(
      "PATCH",
      `/v1/sessions/${encodeURIComponent(sessionId)}`,
      { priority },
    );
  }

  async listAgents(): Promise<{ agents: HydraAgentInfo[] }> {
    return this.json("GET", "/v1/agents");
  }

  async listRemotes(): Promise<{ remotes: HydraRemoteInfo[] }> {
    return this.json("GET", "/v1/remotes");
  }

  // REST session creation — used only for `remote`-targeted creates
  // (see routes-sessions.ts's createSessionOnRemote). Local creates
  // still go through the WS session/new path so an initial prompt can
  // ride the same connection; a remote create sends its initial
  // prompt as a separate attach+prompt afterward instead, since the
  // WS forwarding path (cli's acp-forward.ts) already handles a
  // foreign sessionId transparently once one exists.
  async createSession(body: {
    cwd?: string;
    agentId?: string;
    remote?: string;
  }): Promise<{ sessionId: string; agentId?: string; cwd: string }> {
    return this.json("POST", "/v1/sessions", body);
  }

  // Register a one-shot HTTP callback for a specific prompt's turn
  // completion (see cli's turn-notify.ts / PROTOCOL.md). `already_terminal`
  // means the turn had already finished by the time this landed — the
  // caller should treat that as an immediate completion rather than
  // waiting on a callback that will never come.
  async registerTurnNotify(
    sessionId: string,
    messageId: string,
    callbackUrl: string,
    secret: string,
  ): Promise<{ status: "registered" | "already_terminal"; stopReason?: string }> {
    return this.json(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/prompt/${encodeURIComponent(messageId)}/notify`,
      { callbackUrl, secret },
    );
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
