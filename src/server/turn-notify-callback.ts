// Receives the daemon's turn-notify webhook (cli's turn-notify.ts) and
// turns it into a Web Push delivery. Runs its own tiny loopback-only
// HTTP server rather than a route on the main Fastify app: the daemon's
// callback fetch has to land in plain HTTP even when the main app is
// TLS-only for LAN/Tailscale access (self-signed certs aren't in the
// daemon's trust store), and since the daemon and this extension always
// run on the same host, a 127.0.0.1-bound listener is reachable either
// way without needing a cert at all — same trust boundary as the
// existing authenticated daemon<->extension traffic, just one hop
// shorter.

import { createServer, type Server } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { HydraRestClient } from "../hydra/client.js";
import { sendPushToAll } from "./push-store.js";
import { logger } from "../util/log.js";
import type { Config } from "../config.js";

const log = logger("turn-notify");

interface PendingPush {
  secret: string;
  sessionId: string;
  sessionTitle: string;
}

const pending = new Map<string, PendingPush>();

let serverPort: number | undefined;

export async function startTurnNotifyCallbackServer(): Promise<number> {
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void handleDelivery(Buffer.concat(chunks).toString("utf8"), req.headers);
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  serverPort = typeof addr === "object" && addr ? addr.port : undefined;
  if (!serverPort) {
    throw new Error("turn-notify callback server failed to bind");
  }
  return serverPort;
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

// Registers a one-shot callback for this messageId's turn completion.
// `sessionTitle` is captured now (best-effort session lookup at the
// caller) since the delivery payload only carries
// sessionId/messageId/stopReason — nothing to build a friendly
// notification off of on its own.
export async function registerForPush(
  config: Config,
  sessionId: string,
  messageId: string,
  sessionTitle: string,
): Promise<void> {
  if (!serverPort || !isLoopback(config.hydraDaemonUrl)) {
    return;
  }
  const secret = randomBytes(32).toString("hex");
  pending.set(messageId, { secret, sessionId, sessionTitle });
  const callbackUrl = `http://127.0.0.1:${serverPort}/turn-notify`;
  const client = HydraRestClient.forRequest(config.hydraDaemonUrl, config.hydraToken);
  try {
    const result = await client.registerTurnNotify(sessionId, messageId, callbackUrl, secret);
    log.info(`registered turn-notify session=${sessionId} messageId=${messageId} status=${result.status}`);
    if (result.status === "already_terminal") {
      pending.delete(messageId);
      await sendPushToAll(buildPayload(sessionId, sessionTitle, result.stopReason));
    }
  } catch (err) {
    pending.delete(messageId);
    log.warn(`registerTurnNotify failed for ${sessionId}/${messageId}: ${(err as Error).message}`);
  }
}

async function handleDelivery(
  rawBody: string,
  headers: NodeJS.Dict<string | string[]>,
): Promise<void> {
  let payload: { sessionId?: string; messageId?: string; stopReason?: string };
  try {
    payload = JSON.parse(rawBody) as typeof payload;
  } catch {
    log.warn("turn-notify callback: unparseable body");
    return;
  }
  const messageId = payload.messageId;
  if (!messageId) return;
  const entry = pending.get(messageId);
  if (!entry) {
    log.warn(`turn-notify callback: no pending registration for ${messageId}`);
    return;
  }
  const signature = headers["x-hydra-turn-notify-signature"];
  const provided = Array.isArray(signature) ? signature[0] : signature;
  const expected = createHmac("sha256", entry.secret).update(rawBody).digest("hex");
  if (!provided || !safeEqualHex(provided, expected)) {
    log.warn(`turn-notify callback: bad signature for ${messageId}`);
    return;
  }
  pending.delete(messageId);
  log.info(`turn-notify delivered session=${entry.sessionId} messageId=${messageId} stopReason=${payload.stopReason}`);
  await sendPushToAll(buildPayload(entry.sessionId, entry.sessionTitle, payload.stopReason));
}

// iOS/Safari auto-appends "from <site name>" under every web push
// notification as OS-level origin disclosure — not something the
// payload can suppress — so a title that's also just "Hydra" reads as
// redundant ("Hydra" / "from Hydra"). Use the session's own title
// instead, which is actually useful on a lock screen with several
// sessions finishing around the same time.
function buildPayload(
  sessionId: string,
  sessionTitle: string,
  stopReason: string | undefined,
): { title: string; body: string; url: string; tag: string } {
  return {
    title: sessionTitle,
    body: describeStopReason(stopReason),
    url: `/#/session/${encodeURIComponent(sessionId)}`,
    tag: `hydra-acp-turn-${sessionId}`,
  };
}

function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function describeStopReason(stopReason: string | undefined): string {
  switch (stopReason) {
    case "cancelled":
      return "Cancelled.";
    case "interrupted":
      return "Interrupted.";
    case "max_tokens":
      return "Stopped: max tokens reached.";
    case "refusal":
      return "Stopped: refused.";
    default:
      return "Turn finished.";
  }
}
