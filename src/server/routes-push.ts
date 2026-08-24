import type { FastifyInstance } from "fastify";
import {
  addSubscription,
  getVapidPublicKey,
  removeSubscription,
  type PushSubscriptionJSON,
} from "./push-store.js";
import type { ServerContext } from "./http.js";

function isSubscription(body: unknown): body is PushSubscriptionJSON {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.endpoint !== "string") return false;
  const keys = b.keys as Record<string, unknown> | undefined;
  return !!keys && typeof keys.p256dh === "string" && typeof keys.auth === "string";
}

export function registerPushRoutes(app: FastifyInstance, _ctx: ServerContext): void {
  app.get("/api/push/vapid-public-key", async (_request, reply) => {
    reply.send({ publicKey: await getVapidPublicKey() });
  });

  app.post("/api/push/subscribe", async (request, reply) => {
    if (!isSubscription(request.body)) {
      reply.code(400).send({ error: "invalid subscription" });
      return;
    }
    await addSubscription(request.body);
    reply.code(204).send();
  });

  app.post("/api/push/unsubscribe", async (request, reply) => {
    const body = request.body as { endpoint?: string } | undefined;
    if (!body?.endpoint) {
      reply.code(400).send({ error: "endpoint required" });
      return;
    }
    await removeSubscription(body.endpoint);
    reply.code(204).send();
  });
}
