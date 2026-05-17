import { homedir } from "node:os";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { HydraRestClient, HydraRestError } from "../hydra/client.js";
import { UpstreamConnection, runInitialize } from "../hydra/ws.js";
import { logger } from "../util/log.js";
import type { ServerContext } from "./http.js";

function clientFor(ctx: ServerContext, request: FastifyRequest): HydraRestClient {
  // Prefer the per-user session token from the hb_session cookie. Fall
  // back to the service token (env-injected by hydra) for paths that
  // skip auth — currently just /api/health, which the SPA polls before
  // it has a session.
  const token = request.sessionToken ?? ctx.config.hydraToken;
  return HydraRestClient.forRequest(ctx.config.hydraDaemonUrl, token);
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

const log = logger("routes-sessions");

interface CreateSessionBody {
  cwd?: string;
  agentId?: string;
  name?: string;
  prompt?: string;
}

interface KillBody {
  sessionId?: string;
}

// Drop the redundant "hydra_session_" prefix from the daemon's
// Content-Disposition filename so downloads show the short session id.
// Falls back to a synthesized name if parsing fails.
function rewriteExportDisposition(disposition: string, id: string): string {
  const shortId = id.replace(/^hydra_session_/, "");
  const fallback = `attachment; filename="${shortId}.hydra"`;
  const match = disposition.match(/filename\*?=("[^"]+"|[^;]+)/i);
  if (!match || !match[1]) return fallback;
  const raw = match[1].replace(/^"|"$/g, "");
  const stripped = raw.replace(/hydra_session_/, "");
  if (stripped === raw) return disposition;
  return `attachment; filename="${stripped}"`;
}

export function registerSessionRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
): void {
  app.get(
    "/api/health",
    { config: { skipAuth: true } },
    async (request, reply) => {
      try {
        const upstream = await clientFor(ctx, request).health();
        reply.send({ status: "ok", upstream });
      } catch (err) {
        reply
          .code(502)
          .send({ status: "degraded", error: (err as Error).message });
      }
    },
  );

  app.get("/api/sessions", async (request, reply) => {
    const query = request.query as { cwd?: string; all?: string } | undefined;
    const all = query?.all === "true" || query?.all === "1";
    try {
      const result = await clientFor(ctx, request).listSessions({
        cwd: query?.cwd,
        all,
      });
      reply.send(result);
    } catch (err) {
      const status = err instanceof HydraRestError ? err.status : 502;
      reply.code(status).send({ error: (err as Error).message });
    }
  });

  app.post("/api/kill", async (request, reply) => {
    const body = (request.body ?? {}) as KillBody;
    if (!body.sessionId) {
      reply.code(400).send({ error: "sessionId required" });
      return;
    }
    try {
      await clientFor(ctx, request).killSession(body.sessionId);
      reply.code(204).send();
    } catch (err) {
      const status = err instanceof HydraRestError ? err.status : 502;
      reply.code(status).send({ error: (err as Error).message });
    }
  });

  app.post("/api/sessions", async (request, reply) => {
    const body = (request.body ?? {}) as CreateSessionBody;
    if (!body.cwd || typeof body.cwd !== "string") {
      reply.code(400).send({ error: "cwd required" });
      return;
    }
    try {
      const result = await createSession(ctx, request, body);
      reply.code(201).send(result);
    } catch (err) {
      log.warn(`session creation failed: ${(err as Error).message}`);
      reply.code(502).send({ error: (err as Error).message });
    }
  });

  // Forward the daemon's bundle download, but strip the "hydra_session_"
  // prefix from the filename so users see a short session id locally.
  // Session cookie auth carries naturally over a plain <a download> tag
  // in the SPA, so no blob/CSP dance is needed on the client side.
  app.get(
    "/api/sessions/:id/export",
    { config: { skipCsrf: true } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const upstream = await clientFor(ctx, request).fetchExport(id);
        const disposition = upstream.headers.get("content-disposition");
        if (disposition) {
          reply.header(
            "Content-Disposition",
            rewriteExportDisposition(disposition, id),
          );
        }
        const contentType =
          upstream.headers.get("content-type") ?? "application/json";
        reply.header("Content-Type", contentType);
        const bytes = Buffer.from(await upstream.arrayBuffer());
        reply.code(200).send(bytes);
      } catch (err) {
        const status = err instanceof HydraRestError ? err.status : 502;
        reply.code(status).send({ error: (err as Error).message });
      }
    },
  );

  // Accept a bundle the browser parsed locally; forward to the daemon
  // for the actual import work. Returns daemon's payload verbatim, with
  // 409 (BundleAlreadyImported) propagated unchanged so the SPA can
  // surface the existing local id.
  app.post("/api/sessions/import", async (request, reply) => {
    const body = (request.body ?? {}) as {
      bundle?: unknown;
      replace?: boolean;
    };
    if (body.bundle === undefined) {
      reply.code(400).send({ error: "bundle required" });
      return;
    }
    try {
      const result = await clientFor(ctx, request).importBundle(body.bundle, {
        replace: body.replace === true,
      });
      reply.code(201).send(result);
    } catch (err) {
      const status = err instanceof HydraRestError ? err.status : 502;
      reply.code(status).send({ error: (err as Error).message });
    }
  });
}

interface CreateSessionResult {
  sessionId: string;
  agentId: string | undefined;
  cwd: string;
}

// Open a transient WSS to hydra, initialize, session/new (with name in
// _meta), optionally session/prompt, close. Returns the new sessionId.
async function createSession(
  ctx: ServerContext,
  request: FastifyRequest,
  body: CreateSessionBody,
): Promise<CreateSessionResult> {
  const token = request.sessionToken ?? ctx.config.hydraToken;
  const conn = new UpstreamConnection({
    daemonWsUrl: ctx.config.hydraWsUrl,
    token,
    clientName: "hydra-acp-browser-session",
  });

  const opened = new Promise<void>((resolveOpen, rejectOpen) => {
    conn.once("open", () => resolveOpen());
    conn.once("error", (err) => rejectOpen(err));
    conn.once("close", () => rejectOpen(new Error("upstream closed")));
  });
  conn.start();
  await opened;

  const cwd = expandHome(body.cwd!);
  try {
    await runInitialize(conn);
    const newParams: Record<string, unknown> = {
      cwd,
      mcpServers: [],
    };
    if (body.agentId) {
      newParams.agentId = body.agentId;
    }
    if (body.name) {
      newParams._meta = { "hydra-acp": { name: body.name } };
    }
    const newResult = (await conn.request("session/new", newParams)) as {
      sessionId: string;
      _meta?: Record<string, unknown>;
    };
    if (body.prompt && body.prompt.trim().length > 0) {
      await conn.request("session/prompt", {
        sessionId: newResult.sessionId,
        prompt: [{ type: "text", text: body.prompt }],
      });
    }
    return {
      sessionId: newResult.sessionId,
      agentId: body.agentId,
      cwd,
    };
  } finally {
    conn.stop();
  }
}
