#!/usr/bin/env node
import { writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config.js";
import { HydraRestClient } from "./hydra/client.js";
import { ensureAuthkey, rotateAuthkey } from "./server/auth.js";
import { buildContext, createServer } from "./server/http.js";
import { registerSessionRoutes } from "./server/routes-sessions.js";
import { registerAgentRoutes } from "./server/routes-agents.js";
import { registerFileRoutes } from "./server/routes-files.js";
import { registerRootRoutes } from "./server/routes-root.js";
import { attachWsBridge } from "./server/ws-bridge.js";
import { logger, setDebug } from "./util/log.js";

const log = logger("main");

function ensureLoopbackOrTls(host: string, hasTls: boolean): void {
  const isLoopback =
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "localhost" ||
    host === "[::1]";
  if (!isLoopback && !hasTls) {
    throw new Error(
      `Refusing to bind to non-loopback host ${host} without TLS configured. Set BROWSER_TLS_CERT and BROWSER_TLS_KEY in ~/.acp-hydra-browser.conf.`,
    );
  }
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  const rotate = argv.includes("--rotate-authkey");

  const config = loadConfig();
  setDebug(config.debug);

  ensureLoopbackOrTls(config.browserHost, !!config.tls);

  const authkey = rotate
    ? rotateAuthkey(config.authkeyFile)
    : ensureAuthkey(config.authkeyFile);

  const rest = new HydraRestClient(config.hydraDaemonUrl, config.hydraToken);
  const ctx = buildContext(config, rest, authkey);
  const app = createServer(ctx);

  registerRootRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  registerAgentRoutes(app, ctx);
  registerFileRoutes(app, ctx);

  await app.listen({ host: config.browserHost, port: config.browserPort });

  attachWsBridge(app.server, ctx);

  const scheme = config.tls ? "https" : "http";
  const url = `${scheme}://${displayHost(config.browserHost)}:${config.browserPort}/?authkey=${authkey}`;
  writeLinkFile(config.linkFile, url);
  log.info(`hydra daemon: ${config.hydraDaemonUrl}`);
  log.info(`listening on ${scheme}://${config.browserHost}:${config.browserPort}`);
  log.info(`Open: ${url}`);

  const shutdown = async (signal: string) => {
    log.info(`received ${signal}, shutting down`);
    try {
      await app.close();
    } catch (err) {
      log.warn(`shutdown error: ${(err as Error).message}`);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function displayHost(host: string): string {
  if (host === "0.0.0.0") {
    return "127.0.0.1";
  }
  return host;
}

function writeLinkFile(path: string, url: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, url + "\n", { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch (err) {
    log.warn(`unable to write link file ${path}: ${(err as Error).message}`);
  }
}

function printHelp(): void {
  process.stdout.write(
    `acp-hydra-browser — web UI extension for acp-hydra

Usage:
  acp-hydra-browser                Start the server.
  acp-hydra-browser --rotate-authkey
                                   Generate a fresh authkey, kicking existing
                                   browsers, and exit after starting.
  acp-hydra-browser --help         Show this message.

Config: ~/.acp-hydra-browser.conf (KEY=VALUE).
When run as an acp-hydra extension, ACP_HYDRA_DAEMON_URL / ACP_HYDRA_TOKEN /
ACP_HYDRA_WS_URL are injected automatically.
`,
  );
}

main(process.argv.slice(2)).catch((err) => {
  log.error(err);
  process.exit(1);
});
