import type { FastifyInstance } from "fastify";
import { HydraRestError } from "../hydra/client.js";
import type { ServerContext } from "./http.js";

export function registerAgentRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
): void {
  app.get("/api/agents", async (_request, reply) => {
    try {
      const result = await ctx.rest.listAgents();
      reply.send(result);
    } catch (err) {
      const status = err instanceof HydraRestError ? err.status : 502;
      reply.code(status).send({ error: (err as Error).message });
    }
  });
}
