#!/usr/bin/env node
import { writeFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode-terminal";
import { loadConfig, type Config } from "./config.js";
import { buildContext, createServer } from "./server/http.js";
import { registerSessionRoutes } from "./server/routes-sessions.js";
import { registerAgentRoutes } from "./server/routes-agents.js";
import { registerFileRoutes } from "./server/routes-files.js";
import { registerRootRoutes } from "./server/routes-root.js";
import { registerConfigRoutes } from "./server/routes-config.js";
import { registerPushRoutes } from "./server/routes-push.js";
import { startTurnNotifyCallbackServer } from "./server/turn-notify-callback.js";
import { attachWsBridge } from "./server/ws-bridge.js";
import { UpstreamConnection, runInitialize } from "./hydra/ws.js";
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
      `Refusing to bind to non-loopback host ${host} without TLS configured. Set BROWSER_TLS_CERT and BROWSER_TLS_KEY in ~/.hydra-acp-browser.conf.`,
    );
  }
}

async function main(argv: string[]): Promise<void> {
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`hydra-acp-browser ${readVersion()}\n`);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  if (argv[0] === "tailscale" && argv[1] === "setup") {
    const { runTailscaleSetup } = await import("./setup/tailscale-wizard.js");
    await runTailscaleSetup();
    return;
  }
  if (argv[0] === "url") {
    const url = computeDisplayUrl(loadConfig(undefined, { requireToken: false }));
    process.stdout.write(`${url}\n`);
    qrcode.generate(url, { small: true });
    return;
  }

  const config = loadConfig();
  setDebug(config.debug);

  ensureLoopbackOrTls(config.browserHost, !!config.tls);

  const ctx = buildContext(config);
  const app = createServer(ctx);

  registerRootRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  registerAgentRoutes(app, ctx);
  registerFileRoutes(app, ctx);
  registerConfigRoutes(app, ctx);
  registerPushRoutes(app, ctx);

  await app.listen({ host: config.browserHost, port: config.browserPort });

  await startTurnNotifyCallbackServer();
  attachWsBridge(app.server, ctx);

  // Register this process's version with the daemon using its own token so
  // `hydra extension list` can show the version column. Fire-and-forget —
  // a failure here is not fatal.
  void registerVersion(config.hydraWsUrl, config.hydraToken);

  const scheme = config.tls ? "https" : "http";
  const url = computeDisplayUrl(config);
  writeLinkFile(config.linkFile, url);
  log.info(`hydra daemon: ${config.hydraDaemonUrl}`);
  log.info(`listening on ${scheme}://${config.browserHost}:${config.browserPort}`);
  log.info(`Open: ${url}`);
  log.info(
    `Sign in with the password set via \`hydra-acp auth password\` on the daemon host.`,
  );

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

// Open a short-lived WS connection using the extension's own process token
// to call initialize and let the daemon record our version. This is separate
// from the per-session bridges that use user session tokens.
async function registerVersion(wsUrl: string, token: string): Promise<void> {
  const conn = new UpstreamConnection({ daemonWsUrl: wsUrl, token });
  await new Promise<void>((resolve) => {
    conn.once("open", () => resolve());
    conn.once("error", () => resolve());
    conn.once("close", () => resolve());
    conn.start();
  });
  if (!conn.isConnected) {
    return;
  }
  try {
    await runInitialize(conn);
  } catch {
    void 0;
  } finally {
    conn.stop();
  }
}

// preferredHost (set by `tailscale setup` to the tailnet MagicDNS name)
// wins outright — browserHost itself is bound to a raw IP in that case,
// not something worth showing anyone. Otherwise 0.0.0.0 is genuinely
// ambiguous (it's not a value you can put in a browser bar), so this
// substitutes the machine's own hostname for display purposes only;
// hostname() essentially never throws, but the fallback keeps a listen
// that came up fine from getting undone by a display-only lookup.
// Any other explicit bind host (a specific LAN/tailnet IP, say) is
// already the precise address to connect to, so it passes through
// unchanged rather than risking a hostname that resolves somewhere else.
function resolveDisplayHost(config: Config): string {
  if (config.preferredHost) {
    return config.preferredHost;
  }
  if (config.browserHost === "0.0.0.0") {
    try {
      return hostname() || "127.0.0.1";
    } catch {
      return "127.0.0.1";
    }
  }
  return config.browserHost;
}

function computeDisplayUrl(config: Config): string {
  const scheme = config.tls ? "https" : "http";
  return `${scheme}://${resolveDisplayHost(config)}:${config.browserPort}/`;
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

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(resolve(here, "../package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function printHelp(): void {
  process.stdout.write(
    `hydra-acp-browser — web UI extension for hydra-acp

Usage:
  hydra-acp-browser                Start the server.
  hydra-acp-browser url            Print the URL to open (and a QR code
                                      for it) without starting the server.
  hydra-acp-browser tailscale setup  Mint a Tailscale cert and configure
                                      HTTPS + Tailscale-only access.
  hydra-acp-browser --version      Print version and exit.
  hydra-acp-browser --help         Show this message.

Set the master password on the daemon host:
  hydra-acp auth password

Sign in by opening the printed URL in your browser and entering the
password.

Config: ~/.hydra-acp/browser.conf (KEY=VALUE).
When run as a hydra-acp extension, HYDRA_ACP_DAEMON_URL / HYDRA_ACP_TOKEN /
HYDRA_ACP_WS_URL are injected automatically.
`,
  );
}

main(process.argv.slice(2)).catch((err) => {
  log.error(err);
  process.exit(1);
});
