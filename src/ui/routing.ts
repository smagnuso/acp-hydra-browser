// Hash-based routing + chat lifecycle. Owns the WebSocket connect
// (then hands inbound frames to bridge.ts) and the URL fragment that
// survives reloads + back/forward navigation.

import { setState, state } from "./state.js";
import { handleFrame } from "./bridge.js";
import { cancelAllQueued } from "./queue.js";
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
  };
  state.current = initial;
  setState({ view: "chat" });
  connectChatSocket(initial);
}

// Open a WS to /ws for the given chat and wire its event listeners.
// Called for the initial connect from openChat and for every retry from
// the reconnect loop. The caller is responsible for resetting the
// WS-dependent slice of `chat` before invoking on a reconnect
// (resetChatStateForReconnect).
function connectChatSocket(chat: ChatState): void {
  const url = new URL("/ws", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("session", chat.sessionId);
  if (chat.loadOnConnect) url.searchParams.set("load", "true");
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
  // Drop the queue chain so prompts don't sit waiting for an idle that
  // won't arrive on the dead socket; the upcoming attach replay will
  // repopulate any entries the server still has.
  cancelAllQueued(chat);

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
    resetChatStateForReconnect(chat);
    render();
    connectChatSocket(chat);
  }, delay);
}

// Wipe the WS-dependent slice of state before a reconnect. The server
// bridge does session/attach with historyPolicy:"full" so the log,
// queue, tool cards, etc. will all be re-replayed — leaving the old
// copies in place would dupe everything. Identity, composer text, and
// the up/down history buffer are preserved.
function resetChatStateForReconnect(chat: ChatState): void {
  chat.ws = null;
  chat.ready = false;
  chat.log = [];
  chat.toolCalls = new Map();
  chat.pendingPermissions = new Map();
  chat.pendingRequestById = new Map();
  chat.responseHandlers = new Map();
  chat.spinner = null;
  chat.plan = null;
  chat.mode = null;
  chat.model = null;
  chat.modes = [];
  chat.models = [];
  chat.contextUsed = null;
  chat.contextSize = null;
  chat.cost = null;
  chat.busy = false;
  chat.recentOwnPrompts = [];
  chat.promptQueue = [];
  chat.queueByMessageId = new Map();
  chat.ownPromptIds = new Set();
  chat.inTurn = false;
  chat.idleListeners = [];
  chat.readyListeners = [];
  chat.currentPlanEntry = null;
  chat.daemonSupportsAmend = false;
  chat.ownClientId = undefined;
  chat.currentHeadMessageId = undefined;
  chat.nextId = undefined;
}

export function closeChat(): void {
  setLocationHash("");
  closeChatSocket();
  setState({ view: "list", current: null });
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
