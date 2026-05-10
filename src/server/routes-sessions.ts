import type { FastifyInstance } from "fastify";
import { HydraRestError } from "../hydra/client.js";
import { UpstreamConnection, runInitialize } from "../hydra/ws.js";
import { logger } from "../util/log.js";
import type { ServerContext } from "./http.js";

const log = logger("routes-sessions");

interface SpawnBody {
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
      await ctx.rest.deleteSession(body.sessionId);
      reply.code(204).send();
    } catch (err) {
      const status = err instanceof HydraRestError ? err.status : 502;
      reply.code(status).send({ error: (err as Error).message });
    }
  });

  app.post("/api/spawn", async (request, reply) => {
    const body = (request.body ?? {}) as SpawnBody;
    if (!body.cwd || typeof body.cwd !== "string") {
      reply.code(400).send({ error: "cwd required" });
      return;
    }
    try {
      const result = await spawnSession(ctx, body);
      reply.code(201).send(result);
    } catch (err) {
      log.warn(`spawn failed: ${(err as Error).message}`);
      reply.code(502).send({ error: (err as Error).message });
    }
  });
}

interface SpawnResult {
  sessionId: string;
  agentId: string | undefined;
  cwd: string;
}

// Open a transient WSS to hydra, initialize, session/new (with name in
// _meta), optionally session/prompt, close. Returns the new sessionId.
async function spawnSession(
  ctx: ServerContext,
  body: SpawnBody,
): Promise<SpawnResult> {
  const conn = new UpstreamConnection({
    daemonWsUrl: ctx.config.hydraWsUrl,
    token: ctx.config.hydraToken,
    clientName: "acp-hydra-browser-spawn",
  });

  const opened = new Promise<void>((resolveOpen, rejectOpen) => {
    conn.once("open", () => resolveOpen());
    conn.once("error", (err) => rejectOpen(err));
    conn.once("close", () => rejectOpen(new Error("upstream closed")));
  });
  conn.start();
  await opened;

  try {
    await runInitialize(conn);
    const newParams: Record<string, unknown> = {
      cwd: body.cwd,
      mcpServers: [],
    };
    if (body.agentId) {
      newParams.agentId = body.agentId;
    }
    if (body.name) {
      newParams._meta = { "acp-hydra": { name: body.name } };
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
      cwd: body.cwd!,
    };
  } finally {
    conn.stop();
  }
}
