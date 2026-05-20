import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";
import { logger } from "../util/log.js";

const log = logger("hydra-ws");

const pkg = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

// ACP wire protocol version this extension speaks. Single source of
// truth for the initialize handshake; never a literal at the callsite.
export const ACP_PROTOCOL_VERSION = 1;

export type JsonRpcId = number | string;

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: P;
}

export interface JsonRpcResponse<R = unknown> {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: R;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification<P = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: P;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcResponse
  | JsonRpcNotification;

export function isRequest(m: JsonRpcMessage): m is JsonRpcRequest {
  return "method" in m && "id" in m;
}

export function isNotification(m: JsonRpcMessage): m is JsonRpcNotification {
  return "method" in m && !("id" in m);
}

export function isResponse(m: JsonRpcMessage): m is JsonRpcResponse {
  return !("method" in m) && "id" in m;
}

export interface UpstreamOptions {
  daemonWsUrl: string;
  token: string;
  protocolVersion?: number;
  clientCapabilities?: Record<string, unknown>;
  clientName?: string;
  clientVersion?: string;
}

export interface UpstreamEvents {
  open: [];
  close: [{ code: number; reason: string }];
  error: [Error];
  request: [JsonRpcRequest];
  notification: [JsonRpcNotification];
  response: [JsonRpcResponse];
}

interface PendingRequest {
  resolve: (r: JsonRpcResponse) => void;
  reject: (err: Error) => void;
}

// Thin wrapper around an outbound WSS connection to hydra's `/acp` endpoint.
// Authenticates via the `hydra-acp-token.<token>` subprotocol (alongside
// `acp.v1`), exposes JSON-RPC request/notify primitives and an event stream
// for inbound traffic. Handshake (initialize + session/attach or session/new)
// is the caller's responsibility — see ws-bridge.ts and routes-sessions.ts.
export class UpstreamConnection extends EventEmitter<UpstreamEvents> {
  private ws: WebSocket | undefined;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private connected = false;
  private closed = false;

  constructor(private readonly opts: UpstreamOptions) {
    super();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get clientName(): string {
    return this.opts.clientName ?? "hydra-acp-browser";
  }

  get clientVersion(): string {
    return this.opts.clientVersion ?? pkg.version;
  }

  start(): void {
    log.debug(`connecting ${this.opts.daemonWsUrl}`);
    const subprotocols = ["acp.v1", `hydra-acp-token.${this.opts.token}`];
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.daemonWsUrl, subprotocols);
    } catch (err) {
      this.emit("error", err as Error);
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      this.connected = true;
      this.emit("open");
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }
      const text = data.toString("utf8");
      try {
        const parsed = JSON.parse(text) as JsonRpcMessage;
        this.onMessage(parsed);
      } catch (err) {
        log.warn(`parse error: ${(err as Error).message}; raw=${text.slice(0, 200)}`);
      }
    });

    ws.on("error", (err) => {
      log.warn(`ws error: ${err.message}`);
      this.emit("error", err);
    });

    ws.on("close", (code, reason) => {
      this.connected = false;
      this.closed = true;
      const reasonText = reason.toString("utf8");
      for (const [, p] of this.pending) {
        p.reject(new Error("ws closed"));
      }
      this.pending.clear();
      this.emit("close", { code, reason: reasonText });
    });
  }

  stop(): void {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      try {
        this.ws.close();
      } catch {
        void 0;
      }
    }
  }

  async request<R = unknown>(method: string, params?: unknown): Promise<R> {
    const id = this.nextId++;
    const msg: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.write(msg);
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (resp) => {
          if (resp.error) {
            reject(new Error(`${resp.error.code}: ${resp.error.message}`));
          } else {
            resolve(resp.result as R);
          }
        },
        reject,
      });
    });
  }

  notify(method: string, params?: unknown): void {
    const msg: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.write(msg);
  }

  reply(id: JsonRpcId, result: unknown): void {
    const msg: JsonRpcResponse = { jsonrpc: "2.0", id, result };
    this.write(msg);
  }

  replyError(id: JsonRpcId, code: number, message: string): void {
    const msg: JsonRpcResponse = {
      jsonrpc: "2.0",
      id,
      error: { code, message },
    };
    this.write(msg);
  }

  // Send a frame as-is. Used by the WS bridge to forward browser-originated
  // JSON-RPC messages to hydra unchanged (after method-whitelist validation).
  sendRaw(frame: JsonRpcMessage): void {
    this.write(frame);
  }

  private write(msg: JsonRpcMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (!this.closed) {
        log.warn(`drop write to closed ws: ${JSON.stringify(msg).slice(0, 200)}`);
      }
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  private onMessage(m: JsonRpcMessage): void {
    if (isResponse(m)) {
      const p = this.pending.get(m.id);
      if (p) {
        this.pending.delete(m.id);
        p.resolve(m);
      }
      this.emit("response", m);
    } else if (isRequest(m)) {
      this.emit("request", m);
    } else if (isNotification(m)) {
      this.emit("notification", m);
    }
  }
}

export interface HandshakeOptions {
  protocolVersion?: number;
  clientCapabilities?: Record<string, unknown>;
}

export async function runInitialize(
  conn: UpstreamConnection,
  opts: HandshakeOptions = {},
): Promise<unknown> {
  return await conn.request("initialize", {
    protocolVersion: opts.protocolVersion ?? ACP_PROTOCOL_VERSION,
    clientCapabilities: opts.clientCapabilities ?? {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
  });
}
