import type { FastifyInstance } from "fastify";
import { HydraRestClient, HydraRestError } from "../hydra/client.js";
import type { ServerContext } from "./http.js";

export function registerAgentRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
): void {
  app.get("/api/agents", async (request, reply) => {
    const token = request.sessionToken ?? ctx.config.hydraToken;
    const client = HydraRestClient.forRequest(ctx.config.hydraDaemonUrl, token);
    try {
      const result = await client.listAgents();
      reply.send(result);
    } catch (err) {
      const status = err instanceof HydraRestError ? err.status : 502;
      reply.code(status).send({ error: (err as Error).message });
    }
  });
}
