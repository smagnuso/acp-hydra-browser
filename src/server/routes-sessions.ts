import { homedir } from "node:os";
import type { FastifyInstance } from "fastify";
import { HydraRestError } from "../hydra/client.js";
import { UpstreamConnection, runInitialize } from "../hydra/ws.js";
import { logger } from "../util/log.js";
import type { ServerContext } from "./http.js";

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

export function registerSessionRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
): void {
  app.get(
    "/api/health",
    { config: { skipAuth: true } },
    async (_request, reply) => {
      try {
        const upstream = await ctx.rest.health();
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
      const result = await ctx.rest.listSessions({ cwd: query?.cwd, all });
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
      await ctx.rest.killSession(body.sessionId);
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
      const result = await createSession(ctx, body);
      reply.code(201).send(result);
    } catch (err) {
      log.warn(`session creation failed: ${(err as Error).message}`);
      reply.code(502).send({ error: (err as Error).message });
    }
  });

  // Forward the daemon's bundle download verbatim, including its
  // Content-Disposition filename. The session cookie auth carries
  // naturally over a plain <a download> tag in the SPA, so no blob/CSP
  // dance is needed on the client side.
  app.get(
    "/api/sessions/:id/export",
    { config: { skipCsrf: true } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const upstream = await ctx.rest.fetchExport(id);
        const disposition = upstream.headers.get("content-disposition");
        if (disposition) {
          reply.header("Content-Disposition", disposition);
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
      const result = await ctx.rest.importBundle(body.bundle, {
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
  body: CreateSessionBody,
): Promise<CreateSessionResult> {
  const conn = new UpstreamConnection({
    daemonWsUrl: ctx.config.hydraWsUrl,
    token: ctx.config.hydraToken,
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
