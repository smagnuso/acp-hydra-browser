// Hash-based routing + chat lifecycle. Owns the WebSocket connect
// (then hands inbound frames to bridge.ts) and the URL fragment that
// survives reloads + back/forward navigation.

import { setState, state } from "./state.js";
import { handleFrame } from "./bridge.js";
import { cancelUnboundQueued } from "./queue.js";
import { render } from "./renderer.js";
import type { ChatState, SessionInfo } from "./types.js";

// Exponential backoff for WS reconnect: 1s, 2s, 4s, 8s, 16s, 30s cap.
// Indexed by reconnectAttempt (0 = first retry after a drop).
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
// After this many consecutive failed attempts, escalate the banner from
// "Reconnecting…" (warn) to "Still disconnected — retrying…" (bad).
const RECONNECT_BANNER_ESCALATE_AT = 5;

// Reflect the current session in the URL fragment so a reload (or
// copy-pasted link) drops the user back into the same chat.
export function buildSessionHash(sessionId: string, load: boolean): string {
  const id = encodeURIComponent(sessionId);
  return load ? `#/session/${id}?load=true` : `#/session/${id}`;
}

// pushState (not replaceState) so the browser's back/forward buttons
// step through chat ↔ list transitions. The "already matches" guard
// makes the case where applyHashRoute is the caller (hashchange after
// a user-initiated back/forward) a no-op — the URL is already where
// it needs to be, so we skip the push and don't double up history.
// hashWriting still defends against a re-entrant applyHashRoute if a
// future browser variant queues hashchange synchronously off pushState.
let hashWriting = false;
function setLocationHash(hash: string): void {
  if (window.location.hash === hash) return;
  hashWriting = true;
  try {
    history.pushState(
      null,
      "",
      hash || window.location.pathname + window.location.search,
    );
  } finally {
    queueMicrotask(() => {
      hashWriting = false;
    });
  }
}

export function applyHashRoute(): void {
  if (hashWriting) return;
  const hash = window.location.hash;
  const m = hash.match(/^#\/session\/([^?]+)(?:\?(.*))?$/);
  if (m) {
    const sessionId = decodeURIComponent(m[1]!);
    const params = new URLSearchParams(m[2] ?? "");
    const load = params.get("load") === "true";
    if (state.view === "chat" && state.current?.sessionId === sessionId) {
      return;
    }
    openChat(sessionId, load);
    return;
  }
  if (state.view !== "list") {
    closeChat();
  }
}

export function openChat(sessionId: string, load: boolean): void {
  setLocationHash(buildSessionHash(sessionId, load));
  closeChatSocket();
  const session = state.sessions.find(
    (s: SessionInfo) => s.sessionId === sessionId,
  );
  const initial: ChatState = {
    sessionId,
    // Empty string is the right sentinel here — renderChat falls back
    // to its own placeholder when this is empty and there's no live
    // session metadata yet. Doing the placeholder here too would mean
    // a brief flash of "untitled · …" before the title-cache landed.
    title: session?.title ?? "",
    cwd: session?.cwd || "",
    agentId: session?.agentId || "",
    ws: null,
    ready: false,
    log: [],
    toolCalls: new Map(),
    pendingPermissions: new Map(),
    pendingRequestById: new Map(),
    responseHandlers: new Map(),
    spinner: null,
    plan: null,
    mode: null,
    model: null,
    modes: [],
    models: [],
    contextUsed: null,
    contextSize: null,
    cost: null,
    fileOverlay: null,
    composerValue: "",
    attachments: [],
    busy: false,
    recentOwnPrompts: [],
    history: [],
    historyIndex: null,
    historyDraft: null,
    _lastMetaFp: session
      ? `${session.title}|${session.cwd}|${session.agentId}`
      : "",
    promptQueue: [],
    queueByMessageId: new Map(),
    ownPromptIds: new Set(),
    inTurn: false,
    idleListeners: [],
    readyListeners: [],
    currentPlanEntry: null,
    daemonSupportsAmend: false,
    loadOnConnect: load,
    reconnectAttempt: 0,
    headerExpanded: false,
    unsolicitedTurnOpen: new Set(),
    configOptions: [],
  };
  state.current = initial;
  setState({ view: "chat" });
  connectChatSocket(initial);
}

// Open a WS to /ws for the given chat and wire its event listeners.
// Called for the initial connect from openChat and for every retry from
// the reconnect loop. The caller is responsible for resetting the
// connection-scoped slice of `chat` before invoking on a reconnect
// (resetConnectionStateForReconnect) — the history-bearing slice (log,
// tool cards, queue, …) is left alone here and only cleared later, by
// bridge.ts, if the bridge/replay_policy frame says the daemon couldn't
// honor our afterMessageId request.
function connectChatSocket(chat: ChatState): void {
  const url = new URL("/ws", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("session", chat.sessionId);
  if (chat.loadOnConnect) url.searchParams.set("load", "true");
  // Ask the bridge for a delta replay instead of a full one — see
  // acp.ts's lastSeenMessageId tracking and ws-bridge.ts's doHandshake.
  // Only set once we've actually seen a recordable update, which also
  // means a session's very first connect never sends this (nothing to
  // anchor on yet) and correctly gets a full replay.
  if (chat.lastSeenMessageId !== undefined) {
    url.searchParams.set("afterMessageId", chat.lastSeenMessageId);
  }
  const ws = new WebSocket(url.toString());
  chat.ws = ws;

  ws.addEventListener("open", () => {
    /* wait for bridge/ready */
  });
  ws.addEventListener("message", (ev) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    handleFrame(parsed as never);
  });
  ws.addEventListener("close", () => {
    // Ignore close events for sockets that have been superseded — either
    // by another reconnect attempt or by the user navigating away.
    if (!state.current || state.current.ws !== ws) {
      return;
    }
    scheduleReconnect(state.current);
  });
  ws.addEventListener("error", () => {
    // The browser fires `error` immediately before `close` on most
    // failure modes; the close handler is what drives the retry. Avoid
    // setting a misleading banner here — scheduleReconnect picks the
    // right one based on attempt count.
  });
}

function scheduleReconnect(chat: ChatState): void {
  chat.ready = false;
  // Drop only prompts the daemon never acknowledged — the ones it did
  // (bound to a messageId) keep their bubble and chip as-is; an
  // after_message reconnect (or the attach response's queue snapshot)
  // will report their true status. See cancelUnboundQueued.
  cancelUnboundQueued(chat);

  const attempt = chat.reconnectAttempt ?? 0;
  const delay =
    RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]!;
  const escalate = attempt >= RECONNECT_BANNER_ESCALATE_AT;
  setState({
    banner: escalate
      ? { kind: "bad", text: "Still disconnected — retrying…" }
      : { kind: "warn", text: "Reconnecting…" },
  });

  chat.reconnectTimer = setTimeout(() => {
    // Bail if the chat was closed or replaced while we were waiting.
    if (!state.current || state.current !== chat) {
      return;
    }
    chat.reconnectTimer = undefined;
    chat.reconnectAttempt = attempt + 1;
    resetConnectionStateForReconnect(chat);
    render();
    connectChatSocket(chat);
  }, delay);
}

// Wipe only the state tied to the dead socket itself before opening a
// new one. The history-bearing slice (log, tool cards, queue, live turn
// state, …) is deliberately left alone: we don't yet know whether the
// upcoming attach will be a delta (afterMessageId) or a full replay, and
// clearing it here would blank the transcript and re-snap scroll to
// bottom even when the delta path lands cleanly. bridge.ts's
// bridge/replay_policy handling clears that slice itself, but only if
// the daemon couldn't honor the delta request. Identity, composer text,
// and the up/down history buffer are preserved either way.
function resetConnectionStateForReconnect(chat: ChatState): void {
  chat.ws = null;
  chat.ready = false;
  chat.pendingRequestById = new Map();
  chat.responseHandlers = new Map();
  chat.idleListeners = [];
  chat.readyListeners = [];
  chat.nextId = undefined;
}

export function closeChat(): void {
  setLocationHash("");
  closeChatSocket();
  setState({
    view: "list",
    current: null,
    lastSessionId: state.current?.sessionId ?? state.lastSessionId,
  });
}

function closeChatSocket(): void {
  if (!state.current) {
    return;
  }
  if (state.current.reconnectTimer) {
    clearTimeout(state.current.reconnectTimer);
    state.current.reconnectTimer = undefined;
  }
  if (state.current.ws) {
    try {
      state.current.ws.close();
    } catch {
      /* close errors are non-fatal */
    }
    state.current.ws = null;
  }
}
