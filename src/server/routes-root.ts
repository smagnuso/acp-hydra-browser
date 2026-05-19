import { promises as fsp } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  buildClearCookie,
  buildSetCookie,
  COOKIE_NAME,
  COOKIE_MAX_AGE_SECONDS,
  parseCookies,
} from "./auth.js";
import type { ServerContext } from "./http.js";
import { logger } from "../util/log.js";

const log = logger("routes-root");

const here = dirname(fileURLToPath(import.meta.url));

// In dist layout: dist/server/routes-root.js → ../ui/index.html
const UI_DIR = resolve(here, "..", "ui");

let cachedHtml: string | undefined;

async function loadHtml(): Promise<string> {
  if (cachedHtml) {
    return cachedHtml;
  }
  const path = resolve(UI_DIR, "index.html");
  cachedHtml = await fsp.readFile(path, "utf8");
  return cachedHtml;
}

export function registerRootRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
): void {
  app.get(
    "/",
    {
      config: { skipAuth: true, skipCsrf: true },
    },
    async (request, reply) => {
      reply.header("Content-Type", "text/html; charset=utf-8");
      if (request.sessionToken) {
        const html = await loadHtml();
        reply.send(injectNonce(html, request.cspNonce ?? ""));
        return;
      }
      reply.code(200).send(loginPage(request.cspNonce ?? ""));
    },
  );

  app.post(
    "/login",
    {
      config: { skipAuth: true, skipCsrf: true },
    },
    async (request, reply) => {
      await handleLogin(request, reply, ctx);
    },
  );

  app.post(
    "/logout",
    {
      // skipAuth so a stale cookie can still hit logout without being
      // bounced to 401. We still want CSRF protection on the POST.
      config: { skipAuth: true },
    },
    async (request, reply) => {
      await handleLogout(request, reply, ctx);
    },
  );

  app.get(
    "/favicon.ico",
    { config: { skipAuth: true, skipCsrf: true } },
    async (_request, reply) => {
      reply.code(204).send();
    },
  );
}

async function handleLogin(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: ServerContext,
): Promise<void> {
  const ip = request.ip ?? "unknown";
  if (ctx.rateLimiter.isBlocked(ip)) {
    reply.code(429).type("text/html; charset=utf-8").send(
      loginPage(
        request.cspNonce ?? "",
        "Too many failed attempts. Try again in a few minutes.",
      ),
    );
    return;
  }

  const body = request.body as { password?: string } | undefined;
  const password =
    body && typeof body.password === "string" ? body.password : "";
  if (password.length === 0) {
    reply.code(400).type("text/html; charset=utf-8").send(
      loginPage(request.cspNonce ?? "", "Password required."),
    );
    return;
  }

  const daemonResp = await fetch(`${ctx.config.hydraDaemonUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password, label: "hydra-acp-browser" }),
  });

  if (daemonResp.status === 200) {
    const issued = (await daemonResp.json()) as { session_token: string };
    ctx.rateLimiter.recordSuccess(ip);
    reply.header(
      "Set-Cookie",
      buildSetCookie(issued.session_token, {
        secure: ctx.scheme === "https",
        maxAgeSeconds: COOKIE_MAX_AGE_SECONDS,
      }),
    );
    reply.code(303).header("Location", "/").send();
    return;
  }

  ctx.rateLimiter.recordFailure(ip);
  let errMsg = "Incorrect password.";
  try {
    const errBody = (await daemonResp.json()) as { error?: string };
    if (daemonResp.status === 403 && errBody.error) {
      errMsg = errBody.error;
    } else if (daemonResp.status === 429) {
      errMsg = "Too many failed attempts on the daemon. Try again later.";
    }
  } catch {
    void 0;
  }
  log.warn(`login failed (HTTP ${daemonResp.status}) from ${ip}`);
  reply
    .code(daemonResp.status === 403 ? 403 : 401)
    .type("text/html; charset=utf-8")
    .send(loginPage(request.cspNonce ?? "", errMsg));
}

async function handleLogout(
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: ServerContext,
): Promise<void> {
  const cookies = parseCookies(request.headers.cookie);
  const token = cookies.get(COOKIE_NAME);
  if (token) {
    try {
      await fetch(`${ctx.config.hydraDaemonUrl}/v1/auth/logout`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
    } catch (err) {
      log.warn(`logout daemon call failed: ${(err as Error).message}`);
    }
  }
  reply.header("Set-Cookie", buildClearCookie());
  reply.code(303).header("Location", "/").send();
}

function injectNonce(html: string, nonce: string): string {
  return html.replaceAll("__CSP_NONCE__", nonce);
}

function loginPage(nonce: string, error?: string): string {
  const errorHtml = error
    ? `<p class="error" role="alert">${escapeHtml(error)}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>hydra-acp-browser</title>
<style nonce="${nonce}">
:root { color-scheme: dark; font-family: system-ui, sans-serif; }
body { background: #0e1116; color: #d6deeb; margin: 0; padding: 4rem 1.5rem; max-width: 26rem; margin-inline: auto; line-height: 1.5; }
h1 { font-size: 1.25rem; margin: 0 0 1.5rem; }
form { display: flex; flex-direction: column; gap: 0.75rem; }
label { font-size: 0.95rem; color: #a8b3c7; }
input[type=password] {
  background: #1c2230;
  color: #d6deeb;
  border: 1px solid #2b3346;
  padding: 0.55rem 0.7rem;
  border-radius: 6px;
  font: inherit;
}
input[type=password]:focus { outline: none; border-color: #4a90e2; }
button {
  background: #4a90e2;
  color: #fff;
  border: 0;
  padding: 0.55rem 0.7rem;
  border-radius: 6px;
  font: inherit;
  cursor: pointer;
}
button:hover { background: #5ba0f0; }
.error { color: #f06060; font-size: 0.95rem; margin: 0; }
.note { color: #7c8aa8; font-size: 0.9rem; margin-top: 1.5rem; }
code { background: #1c2230; padding: 0.1rem 0.4rem; border-radius: 4px; }
</style>
</head>
<body>
<h1>hydra-acp-browser</h1>
${errorHtml}
<form id="loginForm" method="POST" action="/login" autocomplete="off">
  <label for="password">Password</label>
  <input type="password" id="password" name="password" autofocus required autocomplete="off">
  <button type="submit">Sign in</button>
</form>
<p class="note">Set the password on the daemon host with <code>hydra-acp auth password</code>.</p>
<script nonce="${nonce}">
// Disarm macOS Secure Event Input before the redirect navigation
// fires. Browsers hold the kernel-level keyboard lock as long as
// they think a password field is focused / present; same-origin
// navigation alone isn't enough to release it (Synergy + similar
// KVMs can't intercept keystrokes until the tab closes otherwise).
// Blurring + flipping the type to "text" tells the browser this is
// no longer a password input, which releases the lock immediately.
// Name attribute is unchanged so the POST body still carries the
// password.
(() => {
  const form = document.getElementById("loginForm");
  const pw = document.getElementById("password");
  if (!form || !(pw instanceof HTMLInputElement)) return;
  form.addEventListener("submit", () => {
    pw.blur();
    pw.type = "text";
  });
})();
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
