import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import type { HydraRestClient } from "../hydra/client.js";
import { logger } from "../util/log.js";
import { buildSecurityContext, checkStateChanging, type SecurityContext } from "../util/csrf.js";
import {
  AuthRateLimiter,
  COOKIE_NAME,
  buildSetCookie,
  constantTimeKeyMatch,
  parseCookies,
} from "./auth.js";

const log = logger("http");

export interface ServerContext {
  config: Config;
  rest: HydraRestClient;
  authkey: string;
  security: SecurityContext;
  rateLimiter: AuthRateLimiter;
  scheme: "http" | "https";
}

declare module "fastify" {
  interface FastifyContextConfig {
    skipAuth?: boolean;
    skipCsrf?: boolean;
  }
}

declare module "fastify" {
  interface FastifyRequest {
    cspNonce?: string;
  }
}

export function createServer(ctx: ServerContext): FastifyInstance {
  const httpsOptions = ctx.config.tls
    ? {
        cert: readFileSync(ctx.config.tls.cert),
        key: readFileSync(ctx.config.tls.key),
      }
    : undefined;

  const app = Fastify({
    logger: false,
    https: httpsOptions ?? null,
  });

  app.addHook("onRequest", async (request, reply) => {
    const nonce = randomBytes(16).toString("base64");
    request.cspNonce = nonce;
    setSecurityHeaders(reply, nonce, ctx.scheme === "https");
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions.config?.skipCsrf) {
      return;
    }
    const headers = request.headers;
    const result = checkStateChanging(ctx.security, headers);
    if (!result.ok) {
      log.warn(`csrf reject ${request.method} ${request.url} ${result.reason}`);
      reply.code(result.status).send({ error: result.reason });
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions.config?.skipAuth) {
      return;
    }
    if (!authenticate(request, reply, ctx)) {
      return reply;
    }
  });

  return app;
}

function setSecurityHeaders(
  reply: FastifyReply,
  nonce: string,
  secure: boolean,
): void {
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
  reply.header("Content-Security-Policy", csp);
  reply.header("X-Frame-Options", "DENY");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("Cache-Control", "no-store");
  if (secure) {
    reply.header(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
}

// Returns true if the request is authenticated; otherwise it has already
// written a response and the caller should stop.
function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: ServerContext,
): boolean {
  const ip = request.ip ?? "unknown";
  if (ctx.rateLimiter.isBlocked(ip)) {
    reply.code(429).send({ error: "rate limited" });
    return false;
  }
  const cookies = parseCookies(request.headers.cookie);
  const provided = cookies.get(COOKIE_NAME);
  if (!provided) {
    ctx.rateLimiter.recordFailure(ip);
    reply.code(401).send({ error: "unauthorized" });
    return false;
  }
  if (!constantTimeKeyMatch(provided, ctx.authkey)) {
    ctx.rateLimiter.recordFailure(ip);
    reply.code(401).send({ error: "unauthorized" });
    return false;
  }
  ctx.rateLimiter.recordSuccess(ip);
  return true;
}

// Check + set cookie for a `?authkey=…` query against the root path. Returns
// "redirect" (cookie set, caller should 302), "ok" (already authenticated,
// caller serves the SPA), or "deny" (caller serves the login instructions).
export function processRootAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: ServerContext,
): "redirect" | "ok" | "deny" {
  const ip = request.ip ?? "unknown";
  if (ctx.rateLimiter.isBlocked(ip)) {
    reply.code(429).send({ error: "rate limited" });
    return "deny";
  }
  const query = (request.query ?? {}) as { authkey?: string };
  if (typeof query.authkey === "string") {
    if (constantTimeKeyMatch(query.authkey, ctx.authkey)) {
      ctx.rateLimiter.recordSuccess(ip);
      reply.header(
        "Set-Cookie",
        buildSetCookie(ctx.authkey, {
          secure: ctx.scheme === "https",
          maxAgeSeconds: 60 * 60 * 24 * 30,
        }),
      );
      return "redirect";
    }
    ctx.rateLimiter.recordFailure(ip);
    return "deny";
  }
  const cookies = parseCookies(request.headers.cookie);
  const provided = cookies.get(COOKIE_NAME);
  if (provided && constantTimeKeyMatch(provided, ctx.authkey)) {
    return "ok";
  }
  return "deny";
}

export function buildContext(
  config: Config,
  rest: HydraRestClient,
  authkey: string,
): ServerContext {
  const scheme: "http" | "https" = config.tls ? "https" : "http";
  return {
    config,
    rest,
    authkey,
    security: buildSecurityContext(
      config.browserHost,
      config.browserPort,
      scheme,
      config.allowedHosts,
    ),
    rateLimiter: new AuthRateLimiter(),
    scheme,
  };
}
