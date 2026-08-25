// Lightweight WebSocket bridge primitives. The chat-side WebSocket
// itself is created in routing.ts (which knows the URL). This module
// just owns the JSON-RPC framing — `send`, `reply`, and the inbound
// frame router that fans out to acp.ts and queue.ts.

import { state } from "./state.js";
import { render } from "./renderer.js";
import {
  ensureSpinner,
  finalizeTurn,
  handleAgentRequest,
  handleNotification,
  hydrateQueueFromSnapshot,
  markActive,
  pushLog,
  resetChatHistoryState,
} from "./acp.js";
import { cancelAllQueued, flushOfflineQueue } from "./queue.js";
import { parseArmedTaskList } from "./acp.js";
import { getPushEndpoint, tabIsHidden } from "./notifications.js";
import type { ChatState, PermissionEntry } from "./types.js";

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

// Tells the bridge (server-side, this connection only — see ws-bridge.ts's
// bridge/visibility handling) whether this tab is actually being looked
// at right now, so it can skip a turn-end push when the answer's already
// on screen. Local-only: the server intercepts this before it would ever
// reach the daemon. Call on visibilitychange/focus/blur and once the
// session is ready, since the server assumes visible=true by default
// until told otherwise.
export function reportVisibility(): void {
  notify("bridge/visibility", { visible: !tabIsHidden() });
}

// Tells the bridge (server-side, this connection only — see ws-bridge.ts's
// bridge/push-endpoint handling) which Web Push subscription, if any,
// belongs to this device, so a turn-end push targets it specifically
// instead of every subscribed device (see turn-notify-callback.ts). Call
// once the session is ready and again whenever the subscription changes
// (notify toggle flipped on/off).
export function reportPushEndpoint(): void {
  void getPushEndpoint().then((endpoint) => {
    notify("bridge/push-endpoint", { endpoint: endpoint ?? null });
  });
}

// Application-level "is this connection actually alive" check.
// readyState and navigator.onLine can both keep reporting "fine" well
// after the connection is really dead — observed directly on iOS
// Safari, where navigator.onLine is a known-unreliable API (especially
// in standalone PWA mode) that doesn't reflect reality. This doesn't
// trust any browser API's opinion about connectivity; it just sends
// traffic over the actual WS in use and reacts if nothing comes back.
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;

function scheduleNextPing(c: ChatState): void {
  c.heartbeatTimer = setTimeout(() => sendPing(c), HEARTBEAT_INTERVAL_MS);
}

function sendPing(c: ChatState): void {
  if (state.current !== c || !c.ws || c.ws.readyState !== WebSocket.OPEN) {
    return;
  }
  notify("bridge/ping", {});
  c.heartbeatDeadline = setTimeout(() => {
    // No pong within the deadline. queue.ts's offline detection checks
    // connectionHealthy directly, so a send attempted right now
    // correctly gets held instead of going out over what's actually a
    // dead pipe. Force a reconnect rather than waiting for a TCP-level
    // timeout, which can take far longer than this.
    c.connectionHealthy = false;
    render();
    try {
      c.ws?.close();
    } catch {
      /* close errors are non-fatal */
    }
  }, HEARTBEAT_TIMEOUT_MS);
}

// Called on a pong — clears the deadline and lines up the next ping.
function onPong(c: ChatState): void {
  c.connectionHealthy = true;
  if (c.heartbeatDeadline !== undefined) {
    clearTimeout(c.heartbeatDeadline);
    c.heartbeatDeadline = undefined;
  }
  scheduleNextPing(c);
}

// Called from bridge/ready — the start of a live connection, so this is
// also where connectionHealthy resets to true after coming back from a
// prior drop.
export function startHeartbeat(c: ChatState): void {
  stopHeartbeat(c);
  c.connectionHealthy = true;
  scheduleNextPing(c);
}

// Called from routing.ts whenever the connection-scoped slice of a chat
// gets torn down (reconnect, close) — stale timers from a superseded
// connection must not fire against a new one.
export function stopHeartbeat(c: ChatState): void {
  if (c.heartbeatTimer !== undefined) {
    clearTimeout(c.heartbeatTimer);
    c.heartbeatTimer = undefined;
  }
  if (c.heartbeatDeadline !== undefined) {
    clearTimeout(c.heartbeatDeadline);
    c.heartbeatDeadline = undefined;
  }
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
  // Arrives before the replayed session/update frames it describes, per
  // the bridge's buffer-then-decide handshake (ws-bridge.ts doHandshake).
  // "after_message" means our existing transcript is still valid and the
  // upcoming frames are just the delta — leave it alone. Anything else
  // ("full", or an older bridge build that never sends this at all) means
  // a fresh replay is about to land, so clear first or it'd duplicate.
  if (frame.method === "bridge/replay_policy") {
    const policy = (frame.params as Record<string, unknown> | undefined)?.policy;
    if (policy !== "after_message") {
      resetChatHistoryState(state.current);
    }
    return;
  }
  if (frame.method === "bridge/ready") {
    state.current.ready = true;
    state.current.cold = false;
    state.banner = null;
    state.current.reconnectAttempt = 0;
    // Capture the server-side bridge's clientId so we can recognize
    // our own hydra-acp/prompt_queue/added events. The bridge passes
    // it through from the upstream session/attach response.
    const params = (frame.params ?? {}) as Record<string, unknown>;
    if (typeof params.clientId === "string") {
      state.current.ownClientId = params.clientId;
    }
    // Initial config-option snapshot (model/mode/agent plus whatever the
    // agent advertises, e.g. effort). Only rides on the attach response
    // itself — a bare reattach doesn't get a config_option_update
    // notification, so this is the sole source until the next live
    // change (see acp.ts's config_option_update handling for that).
    if (Array.isArray(params.configOptions)) {
      state.current.configOptions = params.configOptions as ChatState["configOptions"];
    }
    // Hydrate from the attach-response queue snapshot so a fresh
    // attach paints existing queued/running prompts immediately
    // instead of waiting for new prompt_queue_added events to arrive.
    // The bridge forwards _meta from session/attach verbatim, so the
    // snapshot lives at params._meta["hydra-acp"].queue.
    const meta = params._meta as Record<string, unknown> | undefined;
    const hydraMeta = meta?.["hydra-acp"] as Record<string, unknown> | undefined;
    // Self-heal a turn that ended while we were disconnected. For our
    // OWN prompts the only end-of-turn signal is the session/prompt RPC
    // response (hydra excludes the originator from turn_complete
    // fan-out), and that response dies with the socket. The reconnect's
    // after_message delta doesn't reliably replace it either: the cursor
    // is lastSeenMessageId, and turn_complete is recorded under that
    // same messageId, so "everything after M" can skip the very frame
    // that would have cleaned up. Left alone, inTurn stays true and the
    // spinner sits in the log forever, which is what put a stale spinner
    // above every subsequently-sent prompt. `busy` on the attach
    // response is authoritative (PROTOCOL.md: "mid-turn flag, a prompt
    // is in flight"), so trust it over our own stale belief. Checked
    // before the queue snapshot hydrates below, so hydration gets the
    // last word on per-entry status.
    if (hydraMeta?.busy === false && state.current.inTurn) {
      finalizeTurn();
    }
    // The other direction: the daemon says a turn IS in flight. Adopt
    // that (pill, Stop button, elapsed ticker), and let the daemon's
    // turnStartedAt — when this turn actually began — correct a
    // thinking block whose clock was guessed. Replay normally anchors
    // the block off the in-flight turn's own prompt_received with its
    // recordedAt; this covers the paths that couldn't (a delta replay
    // that skipped the prompt frame, ensureSpinner's Date.now()
    // fallback), and only for anonymous blocks — one opened by a known
    // prompt (spinnerOwner set) already has the right clock.
    if (hydraMeta?.busy === true) {
      markActive();
      const turnStartedAt = hydraMeta.turnStartedAt;
      if (typeof turnStartedAt === "number" && Number.isFinite(turnStartedAt)) {
        if (!state.current.spinner) {
          ensureSpinner();
        }
        if (state.current.spinner && state.current.spinnerOwner === undefined) {
          state.current.spinner.startedAt = turnStartedAt;
        }
      } else if (!state.current.spinner) {
        ensureSpinner();
      }
    }
    const snapshot = hydraMeta?.queue;
    if (Array.isArray(snapshot)) {
      hydrateQueueFromSnapshot(snapshot);
    }
    // Gate the Amend button on the daemon advertising support. Without
    // it the composer falls back to a single Send button (the chord
    // would otherwise produce a target_not_found from the daemon).
    const promptCaps = hydraMeta?.prompt as
      | { amending?: boolean }
      | undefined;
    if (promptCaps?.amending === true) {
      state.current.daemonSupportsAmend = true;
    }
    // Seed the armed-tasks badge from this attach/reattach's snapshot.
    // The armed set lives in-memory on the daemon's Session object only:
    // a resurrect or agent swap can silently reset it to empty with
    // no notification, so re-seeding on every attach (not just the
    // first) is what keeps this from going stale after a daemon
    // restart. A present armedTasks (including 0) always overwrites; a
    // genuinely absent field (older daemon) leaves prior state as-is.
    if (typeof hydraMeta?.armedTasks === "number") {
      state.current.armedTasks = hydraMeta.armedTasks;
      state.current.armedSince =
        hydraMeta.armedTasks > 0 && typeof hydraMeta.armedSince === "number"
          ? hydraMeta.armedSince
          : undefined;
      state.current.armedTaskList = parseArmedTaskList(hydraMeta.armedTaskList);
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
    // The bridge assumes visible=true on connect as a default, not a
    // measurement — send the real state now that there's a connection
    // to send it on.
    reportVisibility();
    // Same idea, for this device's push subscription — a fresh
    // connection doesn't know it yet either.
    reportPushEndpoint();
    // Reset connectionHealthy before flushing — a prior connection that
    // died via a missed heartbeat would otherwise leave it false right
    // through the flush below.
    startHeartbeat(state.current);
    // Dispatch anything held locally from being offline — covers both a
    // live reconnect (already in c.promptQueue) and a fresh app launch
    // (routing.ts rehydrated persisted entries before this connect).
    flushOfflineQueue(state.current);
    render();
    return;
  }
  if (frame.method === "bridge/pong") {
    if (state.current) {
      onPong(state.current);
    }
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
  // drop the queue chain) and mark it cold rather than banner-ing: the
  // chat-header pill (views.ts) reads `cold` to say "cold" instead of
  // the generic (and here misleading, since nothing is actually
  // reconnecting yet) "connecting…". The list view's "cold" badge
  // updates on its own next refresh via session/list.
  if (frame.method === "hydra-acp/session/closed") {
    if (state.current) {
      state.current.ready = false;
      state.current.cold = true;
      cancelAllQueued(state.current);
      // If a turn was actually streaming when the session died, its
      // spinner and inTurn flag were never torn down — nothing else
      // does that for an abrupt close the way finalizeTurn does for a
      // normal turn_complete. Left alone, the stale spinner (and its
      // still-truthy c.spinner) sits at its old position forever:
      // ensureSpinner()'s "one already exists in the log" guard skips
      // creating a fresh, correctly-positioned one for whatever turn
      // eventually resurrects the session, so that turn's activity
      // renders through the leftover spinner sitting ABOVE the new
      // prompt that triggered it instead of below.
      finalizeTurn();
    }
    render();
    return;
  }
  if (frame.method && "id" in frame) {
    handleAgentRequest(frame);
    // Before bridge/ready, this is part of session/attach's full-history
    // replay — skip the paint so a long session doesn't grow the chat
    // body (and re-snap scroll to bottom) once per replayed frame. The
    // bridge/ready handler above does one final render() once the whole
    // backlog is in state.
    if (state.current.ready) render();
    return;
  }
  if (frame.method) {
    handleNotification(frame);
    if (state.current.ready) render();
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
    // A live response (success or error) is proof of life, same as any
    // notification — see the matching check in acp.ts's
    // handleNotification. Without this, a prompt that resurrected a
    // killed session over an already-open connection (no fresh WS
    // handshake, so no bridge/ready) would leave the pill stuck on
    // "cold" even though the turn just completed.
    if (state.current.cold) {
      state.current.cold = false;
      state.current.ready = true;
    }
    if (frame.error) {
      const err = frame.error as { code?: number; message?: string };
      pushLog({
        kind: "error",
        text: `Prompt failed: ${err.message ?? "unknown error"}`,
      });
      finalizeTurn();
      render();
      return;
    }
    const result = frame.result as { stopReason?: unknown } | undefined;
    const stopReason =
      typeof result?.stopReason === "string" ? result.stopReason : undefined;
    // own=true: this response IS the end-of-turn signal for a turn we
    // started, and the daemon sends us no turn_complete for it — see
    // finalizeTurn.
    finalizeTurn(stopReason, undefined, true);
    render();
    return;
  }
  // Per-id response callbacks (e.g. amendPrompt). Fire-and-forget — the
  // callback handles success/error itself.
  if ("id" in frame && frame.id !== undefined) {
    const handler = state.current.responseHandlers.get(String(frame.id));
    if (handler) {
      state.current.responseHandlers.delete(String(frame.id));
      handler({ result: frame.result, error: frame.error });
    }
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
