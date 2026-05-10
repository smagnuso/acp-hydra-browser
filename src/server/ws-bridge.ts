import { WebSocket, WebSocketServer } from "ws";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { logger } from "../util/log.js";
import {
  UpstreamConnection,
  isNotification,
  isRequest,
  isResponse,
  runInitialize,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcId,
} from "../hydra/ws.js";
import {
  COOKIE_NAME,
  constantTimeKeyMatch,
  parseCookies,
} from "./auth.js";
import { extractPromptText, seedSessionTitle } from "./title-cache.js";
import { checkStateChanging } from "../util/csrf.js";
import type { ServerContext } from "./http.js";

const log = logger("ws-bridge");

const ALLOWED_BROWSER_REQUEST_METHODS = new Set<string>([
  "session/prompt",
  // session/cancel is kept here for backward compat with older browser
  // builds that frame it as a request. New builds send the notification
  // form (see ALLOWED_BROWSER_NOTIFICATION_METHODS) per the ACP spec.
  "session/cancel",
  "session/set_mode",
  "session/set_model",
]);

const ALLOWED_BROWSER_NOTIFICATION_METHODS = new Set<string>([
  "session/cancel",
]);

const SHORT_CIRCUIT_AGENT_REQUEST_METHODS = new Set<string>([
  "fs/read_text_file",
  "fs/write_text_file",
]);

export function attachWsBridge(
  httpServer: HttpServer,
  ctx: ServerContext,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://placeholder");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const ip = (request.socket.remoteAddress ?? "unknown").toString();
    if (ctx.rateLimiter.isBlocked(ip)) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      socket.destroy();
      return;
    }
    const csrf = checkStateChanging(ctx.security, request.headers);
    if (!csrf.ok) {
      socket.write(`HTTP/1.1 ${csrf.status} ${csrf.reason}\r\n\r\n`);
      socket.destroy();
      return;
    }
    const cookies = parseCookies(request.headers.cookie);
    const provided = cookies.get(COOKIE_NAME);
    if (!provided || !constantTimeKeyMatch(provided, ctx.authkey)) {
      ctx.rateLimiter.recordFailure(ip);
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    ctx.rateLimiter.recordSuccess(ip);
    const sessionId = url.searchParams.get("session");
    const load = url.searchParams.get("load") === "true";
    if (!sessionId) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (browserWs) => {
      handleConnection(browserWs, request, ctx, sessionId, load);
    });
  });

  return wss;
}

function handleConnection(
  browserWs: WebSocket,
  _req: IncomingMessage,
  ctx: ServerContext,
  sessionId: string,
  load: boolean,
): void {
  log.info(`bridge open session=${sessionId} load=${load}`);

  const upstream = new UpstreamConnection({
    daemonWsUrl: ctx.config.hydraWsUrl,
    token: ctx.config.hydraToken,
  });

  // Track ids of outstanding upstream→browser requests so we can validate
  // browser-supplied responses (and reject responses for unknown ids,
  // which would otherwise be a path for a compromised tab to spoof
  // permission outcomes).
  const outstandingFromUpstream = new Set<string>();

  let upstreamReady = false;
  // While the upstream handshake is running we can't yet forward browser
  // frames. Buffer them and flush once attach completes.
  const browserBuffer: JsonRpcMessage[] = [];

  upstream.on("open", () => {
    void doHandshake().catch((err: unknown) => {
      log.warn(
        `handshake failed for ${sessionId}: ${(err as Error).message}`,
      );
      sendBrowserError("handshake_failed", (err as Error).message);
      cleanup();
    });
  });

  upstream.on("notification", (n) => {
    sendBrowserFrame(n);
  });

  upstream.on("request", (r) => {
    if (SHORT_CIRCUIT_AGENT_REQUEST_METHODS.has(r.method)) {
      // We advertised fs/* off in initialize; if an agent still asks,
      // refuse rather than expose the user's filesystem to it.
      upstream.replyError(
        r.id,
        -32601,
        `method not supported: ${r.method}`,
      );
      return;
    }
    outstandingFromUpstream.add(String(r.id));
    sendBrowserFrame(r);
  });

  upstream.on("response", (r) => {
    sendBrowserFrame(r);
  });

  upstream.on("close", ({ code, reason }) => {
    log.info(`upstream closed session=${sessionId} code=${code} reason=${reason}`);
    try {
      browserWs.close();
    } catch {
      void 0;
    }
  });

  upstream.on("error", (err) => {
    log.warn(`upstream error session=${sessionId}: ${err.message}`);
  });

  browserWs.on("message", (data, isBinary) => {
    if (isBinary) {
      return;
    }
    let parsed: JsonRpcMessage;
    try {
      parsed = JSON.parse(data.toString("utf8")) as JsonRpcMessage;
    } catch (err) {
      log.warn(`browser parse error: ${(err as Error).message}`);
      return;
    }
    handleBrowserFrame(parsed);
  });

  browserWs.on("close", () => {
    log.info(`browser closed session=${sessionId}`);
    cleanup();
  });

  browserWs.on("error", (err) => {
    log.warn(`browser error session=${sessionId}: ${err.message}`);
  });

  upstream.start();

  function handleBrowserFrame(msg: JsonRpcMessage): void {
    if (!upstreamReady) {
      browserBuffer.push(msg);
      return;
    }
    forwardBrowserFrame(msg);
  }

  function forwardBrowserFrame(msg: JsonRpcMessage): void {
    if (isRequest(msg)) {
      if (!ALLOWED_BROWSER_REQUEST_METHODS.has(msg.method)) {
        log.warn(`reject browser request method=${msg.method}`);
        sendBrowserResponseError(
          msg.id,
          -32601,
          `method not allowed: ${msg.method}`,
        );
        return;
      }
      // Coerce sessionId in params to the URL-bound session so a
      // compromised tab can't redirect prompts at sessions it doesn't
      // hold the WS for.
      const params =
        msg.params && typeof msg.params === "object"
          ? { ...(msg.params as Record<string, unknown>), sessionId }
          : { sessionId };
      // Seed a fallback title from the first prompt's text so sessions
      // without an editor-supplied name (e.g. spawned through this UI)
      // still get a useful header in the list view.
      if (msg.method === "session/prompt") {
        const text = extractPromptText(params);
        if (text) {
          seedSessionTitle(sessionId, text);
        }
      }
      upstream.sendRaw({
        jsonrpc: "2.0",
        id: msg.id,
        method: msg.method,
        params,
      });
      return;
    }
    if (isResponse(msg)) {
      const idStr = String(msg.id);
      if (!outstandingFromUpstream.has(idStr)) {
        log.warn(`reject browser response for unknown id=${idStr}`);
        return;
      }
      outstandingFromUpstream.delete(idStr);
      upstream.sendRaw(msg);
      return;
    }
    if (isNotification(msg)) {
      if (!ALLOWED_BROWSER_NOTIFICATION_METHODS.has(msg.method)) {
        log.debug(`ignore browser notification method=${msg.method}`);
        return;
      }
      // Same sessionId coercion as the request branch: a compromised tab
      // shouldn't be able to send notifications targeting other sessions.
      const params =
        msg.params && typeof msg.params === "object"
          ? { ...(msg.params as Record<string, unknown>), sessionId }
          : { sessionId };
      upstream.sendRaw({
        jsonrpc: "2.0",
        method: msg.method,
        params,
      });
      return;
    }
  }

  function sendBrowserFrame(msg: JsonRpcMessage): void {
    if (browserWs.readyState !== WebSocket.OPEN) {
      return;
    }
    browserWs.send(JSON.stringify(msg));
  }

  function sendBrowserError(code: string, message: string): void {
    sendBrowserFrame({
      jsonrpc: "2.0",
      method: "bridge/error",
      params: { code, message },
    });
  }

  function sendBrowserResponseError(
    id: JsonRpcId,
    code: number,
    message: string,
  ): void {
    const resp: JsonRpcResponse = {
      jsonrpc: "2.0",
      id,
      error: { code, message },
    };
    sendBrowserFrame(resp);
  }

  async function doHandshake(): Promise<void> {
    await runInitialize(upstream);
    if (load) {
      try {
        await upstream.request("session/load", { sessionId });
      } catch (err) {
        log.warn(
          `session/load failed for ${sessionId}: ${(err as Error).message} — will still attempt attach`,
        );
      }
    }
    await upstream.request("session/attach", {
      sessionId,
      role: "controller",
      historyPolicy: "full",
      clientInfo: {
        name: upstream.clientName,
        version: upstream.clientVersion,
      },
    });
    sendBrowserFrame({
      jsonrpc: "2.0",
      method: "bridge/ready",
      params: { sessionId },
    });
    upstreamReady = true;
    while (browserBuffer.length > 0) {
      const next = browserBuffer.shift()!;
      forwardBrowserFrame(next);
    }
  }

  function cleanup(): void {
    upstream.stop();
    if (browserWs.readyState === WebSocket.OPEN) {
      try {
        browserWs.close();
      } catch {
        void 0;
      }
    }
  }
}

// Exported for tests.
export const _internal = {
  ALLOWED_BROWSER_REQUEST_METHODS,
  ALLOWED_BROWSER_NOTIFICATION_METHODS,
  SHORT_CIRCUIT_AGENT_REQUEST_METHODS,
};

export type { JsonRpcRequest };
