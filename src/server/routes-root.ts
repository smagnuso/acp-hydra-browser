import { promises as fsp } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { processRootAuth, type ServerContext } from "./http.js";

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
      const result = processRootAuth(request, reply, ctx);
      if (result === "redirect") {
        reply.code(302).header("Location", "/").send();
        return;
      }
      reply.header("Content-Type", "text/html; charset=utf-8");
      if (result === "deny") {
        reply
          .code(401)
          .send(loginPage(request.cspNonce ?? ""));
        return;
      }
      const html = await loadHtml();
      reply.send(injectNonce(html, request.cspNonce ?? ""));
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

// Replace the literal placeholder __CSP_NONCE__ in the HTML template with
// the per-request nonce.
function injectNonce(html: string, nonce: string): string {
  return html.replaceAll("__CSP_NONCE__", nonce);
}

function loginPage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>acp-hydra-browser</title>
<style nonce="${nonce}">
:root { color-scheme: dark; font-family: system-ui, sans-serif; }
body { background: #0e1116; color: #d6deeb; margin: 0; padding: 4rem 1.5rem; max-width: 38rem; margin-inline: auto; line-height: 1.5; }
h1 { font-size: 1.25rem; margin: 0 0 1rem; }
code { background: #1c2230; padding: 0.1rem 0.4rem; border-radius: 4px; }
.note { color: #7c8aa8; font-size: 0.95rem; }
</style>
</head>
<body>
<h1>acp-hydra-browser</h1>
<p>Authentication required.</p>
<p class="note">Open the URL printed by the server (it contains <code>?authkey=…</code>). The link is also written to <code>~/.acp-hydra-browser/link</code>.</p>
</body>
</html>`;
}
