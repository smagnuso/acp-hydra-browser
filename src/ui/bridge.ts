// Lightweight WebSocket bridge primitives. The chat-side WebSocket
// itself is created in routing.ts (which knows the URL). This module
// just owns the JSON-RPC framing — `send`, `reply`, and the inbound
// frame router that fans out to acp.ts and queue.ts.

import { state } from "./state.js";
import { render } from "./renderer.js";
import {
  finalizeTurn,
  handleAgentRequest,
  handleNotification,
  hydrateQueueFromSnapshot,
  pushLog,
} from "./acp.js";
import { cancelAllQueued } from "./queue.js";
import type { PermissionEntry } from "./types.js";

interface JsonRpcFrame {
  method?: string;
  params?: Record<string, unknown>;
  id?: number | string;
  result?: unknown;
  error?: unknown;
}

// Send a JSON-RPC request over the active chat WS. Returns the
// allocated id, or undefined if the socket isn't OPEN.
export function send(method: string, params: unknown): number | undefined {
  const c = state.current;
  if (!c || !c.ws || c.ws.readyState !== WebSocket.OPEN) {
    return undefined;
  }
  const id = (c.nextId = c.nextId ?? 1);
  c.nextId = id + 1;
  c.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  return id;
}

// Send a JSON-RPC notification (no id, no response expected). Used for
// session/cancel, which is a notification per the ACP spec.
export function notify(method: string, params: unknown): void {
  const c = state.current;
  if (!c || !c.ws || c.ws.readyState !== WebSocket.OPEN) {
    return;
  }
  c.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
}

// Send a JSON-RPC response (used for replying to permission asks).
export function reply(id: number | string, result: unknown): void {
  const c = state.current;
  if (!c || !c.ws || c.ws.readyState !== WebSocket.OPEN) {
    return;
  }
  c.ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

// Top-level inbound frame router. Called from the chat WS message
// handler in routing.ts.
export function handleFrame(frame: JsonRpcFrame): void {
  if (!state.current) return;
  if (frame.method === "bridge/ready") {
    state.current.ready = true;
    state.banner = null;
    // Capture the server-side bridge's clientId so we can recognize
    // our own hydra-acp/prompt_queue_added events. The bridge passes
    // it through from the upstream session/attach response.
    const params = (frame.params ?? {}) as Record<string, unknown>;
    if (typeof params.clientId === "string") {
      state.current.ownClientId = params.clientId;
    }
    // Hydrate from the attach-response queue snapshot so a fresh
    // attach paints existing queued/running prompts immediately
    // instead of waiting for new prompt_queue_added events to arrive.
    // The bridge forwards _meta from session/attach verbatim, so the
    // snapshot lives at params._meta["hydra-acp"].queue.
    const meta = params._meta as Record<string, unknown> | undefined;
    const hydraMeta = meta?.["hydra-acp"] as Record<string, unknown> | undefined;
    const snapshot = hydraMeta?.queue;
    if (Array.isArray(snapshot)) {
      hydrateQueueFromSnapshot(snapshot);
    }
    // Wake any queued prompt that was waiting for the bridge handshake.
    const listeners = state.current.readyListeners;
    state.current.readyListeners = [];
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        /* listener errors don't block other listeners */
      }
    }
    render();
    return;
  }
  if (frame.method === "bridge/error") {
    pushLog({
      kind: "error",
      text: `Bridge error: ${(frame.params?.["message"] as string | undefined) ?? "?"}`,
    });
    render();
    return;
  }
  // Daemon closed our session (user typed /hydra kill, idle-close fired,
  // record was deleted, etc.). The WS itself is still up — only the
  // session is gone — so we mirror the WS-close cleanup (ready=false,
  // drop the queue chain) and tell the user. The list view's "cold"
  // badge updates on its own next refresh via session/list.
  if (frame.method === "hydra-acp/session_closed") {
    if (state.current) {
      state.current.ready = false;
      cancelAllQueued(state.current);
    }
    state.banner = {
      kind: "warn",
      text: "Session is now cold — opening a new prompt will resurrect it.",
    };
    render();
    return;
  }
  if (frame.method && "id" in frame) {
    handleAgentRequest(frame);
    render();
    return;
  }
  if (frame.method) {
    handleNotification(frame);
    render();
    return;
  }
  // It's a JSON-RPC response. Most replies we don't track (we observe
  // the resulting notifications instead). One exception: responses to
  // session/prompt requests we sent — those are the only own-turn-end
  // signal hydra gives us, since it excludes the originator from
  // turn_complete fan-out. When we see one, drive idle-drain so the
  // queue chain unblocks the next entry.
  if (
    "id" in frame &&
    frame.id !== undefined &&
    state.current.ownPromptIds.has(String(frame.id))
  ) {
    state.current.ownPromptIds.delete(String(frame.id));
    finalizeTurn();
    render();
  }
}

// Forward to acp.ts respondPermission — but the actual reply goes
// through this module's reply(). Defining respondPermission here so
// views.ts can import a single button-click handler without touching
// acp.ts internals.
export function respondPermission(toolCallId: string, optionId: string): void {
  if (!state.current) return;
  const entry = state.current.pendingPermissions.get(toolCallId) as
    | PermissionEntry
    | undefined;
  if (!entry) return;
  state.current.pendingPermissions.delete(toolCallId);
  state.current.log = state.current.log.filter(
    (e) => !(e.kind === "perm" && e.toolCallId === toolCallId),
  );
  // Reply with the original JSON-RPC request id so the agent's pending
  // promise resolves; toolCallId is only the UI correlation key.
  reply(entry.requestId, {
    outcome:
      optionId === "__cancel__"
        ? { outcome: "cancelled" }
        : { outcome: "selected", optionId },
  });
  render();
}
