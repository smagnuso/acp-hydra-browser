import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import { logger } from "../util/log.js";
import { buildSecurityContext, checkStateChanging, type SecurityContext } from "../util/csrf.js";
import {
  AuthRateLimiter,
  COOKIE_NAME,
  parseCookies,
} from "./auth.js";

const log = logger("http");

export interface ServerContext {
  config: Config;
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
    // The user's daemon-issued session token, extracted from the cookie.
    // Set by the auth middleware; undefined when the route was skipAuth
    // or no cookie was present. Used by daemon-calling routes as the
    // bearer credential.
    sessionToken?: string;
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

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    },
  );

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
      // Still surface the cookie value for skipAuth routes that might
      // want to read it (e.g. the root handler decides login vs SPA).
      const cookies = parseCookies(request.headers.cookie);
      const provided = cookies.get(COOKIE_NAME);
      if (provided && provided.length > 0) {
        request.sessionToken = provided;
      }
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
    "manifest-src 'self' data:",
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

// Returns true if the request carries an hb_session cookie. The actual
// validity of the token is enforced by the daemon when this server
// proxies the cookie value as a bearer — a forged/expired cookie will
// hit a 403 on the very next daemon call and propagate to the user as a
// 401 here, prompting a re-login.
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
    reply.code(401).send({ error: "unauthorized" });
    return false;
  }
  request.sessionToken = provided;
  return true;
}

export function buildContext(config: Config): ServerContext {
  const scheme: "http" | "https" = config.tls ? "https" : "http";
  // preferredHost is always implicitly allowed — it's the host the server
  // itself will tell you to open (see index.ts's resolveDisplayHost), so
  // requiring it to also be listed in BROWSER_ALLOWED_HOSTS would just be
  // the same value written twice.
  const extraHosts = config.preferredHost
    ? [...config.allowedHosts, config.preferredHost]
    : config.allowedHosts;
  return {
    config,
    security: buildSecurityContext(
      config.browserHost,
      config.browserPort,
      scheme,
      extraHosts,
    ),
    rateLimiter: new AuthRateLimiter(),
    scheme,
  };
}
