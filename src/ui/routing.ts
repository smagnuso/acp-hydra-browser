// Hash-based routing + chat lifecycle. Owns the WebSocket connect
// (then hands inbound frames to bridge.ts) and the URL fragment that
// survives reloads + back/forward navigation.

import { setState, state } from "./state.js";
import { handleFrame } from "./bridge.js";
import { cancelAllQueued } from "./queue.js";
import type { ChatState, SessionInfo } from "./types.js";

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
    _lastMetaFp: session
      ? `${session.title}|${session.cwd}|${session.agentId}`
      : "",
    promptQueue: [],
    promptChain: null,
    ownPromptIds: new Set(),
    inTurn: false,
    idleListeners: [],
    readyListeners: [],
    currentPlanEntry: null,
  };
  state.current = initial;
  setState({ view: "chat" });

  const url = new URL("/ws", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("session", sessionId);
  if (load) url.searchParams.set("load", "true");
  const ws = new WebSocket(url.toString());
  initial.ws = ws;

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
    if (state.current && state.current.ws === ws) {
      state.current.ready = false;
      // Cancel anything still in the queue — the WS is gone, so the
      // chain would otherwise hang waiting for ready/idle that won't
      // arrive.
      cancelAllQueued(state.current);
      setState({
        banner: { kind: "warn", text: "Disconnected from session." },
      });
    }
  });
  ws.addEventListener("error", () => {
    setState({ banner: { kind: "bad", text: "Connection error." } });
  });
}

export function closeChat(): void {
  setLocationHash("");
  closeChatSocket();
  setState({ view: "list", current: null });
}

function closeChatSocket(): void {
  if (state.current && state.current.ws) {
    try {
      state.current.ws.close();
    } catch {
      /* close errors are non-fatal */
    }
    state.current.ws = null;
  }
}
