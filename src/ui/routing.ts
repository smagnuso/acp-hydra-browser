// Hash-based routing + chat lifecycle. Owns the WebSocket connect
// (then hands inbound frames to bridge.ts) and the URL fragment that
// survives reloads + back/forward navigation.

import { setState, state } from "./state.js";
import { handleFrame, stopHeartbeat } from "./bridge.js";
import { cancelUnboundQueued } from "./queue.js";
import { render, renderNow } from "./renderer.js";
import { timed } from "./perf.js";
import { isWideLayout } from "./dom.js";
import { handleNotification, resetChatHistoryState } from "./acp.js";
import { loadCachedSession } from "./history-cache.js";
import { loadDraft } from "./composer-draft.js";
import { loadOfflineEntries } from "./offline-queue.js";
import { peekChatScrollTop } from "./views.js";
import type { ChatState, QueueEntry, SessionInfo } from "./types.js";

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

// The installed PWA registers as the OS handler for web+hydra:// links
// (manifest protocol_handlers). Per the Web App Manifest spec, clicking
// one launches us at /?protocol_launch=<encoded original URL> rather
// than navigating the browser to the custom scheme directly. Rewrite
// that into our own hash route before applyHashRoute runs, matching the
// web+hydra://sessions/<id> shape hydra-acp-reviewer/planner already
// emit as hydra://sessions/<id> links elsewhere in the ecosystem.
export function applyProtocolLaunch(): void {
  const params = new URLSearchParams(window.location.search);
  const launch = params.get("protocol_launch");
  if (!launch) {
    return;
  }
  // Scrub the query string immediately so a reload or copy-pasted URL
  // doesn't replay the same redirect.
  history.replaceState(null, "", window.location.pathname + window.location.hash);
  let parsed: URL;
  try {
    parsed = new URL(launch);
  } catch {
    return;
  }
  if (parsed.protocol !== "web+hydra:" || parsed.hostname !== "sessions") {
    return;
  }
  const sessionId = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (!sessionId) {
    return;
  }
  window.location.hash = buildSessionHash(sessionId, true);
}

// pushState (not replaceState) so the browser's back/forward buttons
// step through chat ↔ list transitions. The "already matches" guard
// makes the case where applyHashRoute is the caller (hashchange after
// a user-initiated back/forward) a no-op — the URL is already where
// it needs to be, so we skip the push and don't double up history.
// hashWriting still defends against a re-entrant applyHashRoute if a
// future browser variant queues hashchange synchronously off pushState.
let hashWriting = false;
// Set for a navigation that restores state rather than expressing an
// intent to navigate — currently just the boot-time last-session
// restore. Such a navigation must REPLACE the current history entry:
// pushing one means the restored session becomes a phantom step that
// Back walks into on the way out of the app, which made Back behave
// differently depending on how the page was reached.
let replaceNextHash = false;

// Installed PWA (no browser chrome, so no Back button — Back is the edge
// swipe). iOS does not reliably keep a standalone app alive across a
// history back: the gesture unwinds past our entry and the whole app cold
// boots, which is a multi-second freeze while the bundle parses, the
// cache hydrates, frames replay and the socket reconnects.
//
// Measured, not inferred: the diagnostics counters only reset on a fresh
// page load, and a back that had been sitting at node-hit:19217 came back
// reading 178.
//
// So in standalone we keep exactly one history entry. Back then does what
// the platform intends — leaves the app — instead of restarting it, and
// chat <-> list stays with the in-app control, which never touched
// history anyway. Browsers are unaffected: both Safari and Chrome paint
// this transition instantly, because there the entry is browser history,
// not the app's whole lifetime.
function isStandalonePwa(): boolean {
  try {
    return (
      window.matchMedia?.("(display-mode: standalone)").matches === true ||
      (navigator as unknown as { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
}

function setLocationHash(hash: string): void {
  if (window.location.hash === hash) return;
  hashWriting = true;
  const write =
    replaceNextHash || isStandalonePwa() ? history.replaceState : history.pushState;
  replaceNextHash = false;
  try {
    write.call(
      history,
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
    composerValue: loadDraft(sessionId),
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
    ownPromptIds: new Map(),
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
    connectionHealthy: true,
  };
  state.current = initial;
  // Keeps the split-view rail's highlight glued to whichever session is
  // actually being viewed — every way of opening a session (card click,
  // Enter, a fresh deep link, session creation) funnels through here, so
  // this one line is the single place that needs to know about it,
  // rather than every call site remembering to sync it separately.
  setState({ view: "chat", listHighlightedSessionId: sessionId, lastSessionId: sessionId });
  void hydrateFromCacheThenConnect(initial);
}

// Cache lookup is async, so the connect that needs lastSeenMessageId
// (to request an afterMessageId delta instead of a full replay) has to
// wait on it — an IndexedDB read is a few ms at most, worth it to avoid
// re-fetching the whole transcript on every cold app launch. Replays
// cached frames through the same handleNotification path live/replayed
// frames go through, so coalescing (message chunks, tool_call_update
// merges, …) stays identical either way.
async function hydrateFromCacheThenConnect(chat: ChatState): Promise<void> {
  const cached = await loadCachedSession(chat.sessionId);
  // Bail if the user navigated away (or into a different session) while
  // the cache read was in flight.
  if (state.current !== chat) {
    return;
  }
  if (cached) {
    timed("cache-replay", () => {
    for (const frame of cached.frames) {
      // One malformed frame must not cost us the rest of the
      // transcript. This is a bare loop over every cached frame, so an
      // exception here abandons all the frames after it — the whole
      // remainder of the session silently missing, which is far worse
      // than losing the single frame that actually failed.
      try {
        handleNotification(frame, true);
      } catch (err) {
        console.error("[hydra] cached frame failed to replay", err, frame);
      }
    }
    });
    chat.lastSeenMessageId = chat.lastSeenMessageId ?? cached.lastSeenMessageId;
    // The cache is byte-capped (history-cache.ts), so a hit doesn't
    // guarantee we have this session's whole history — just render()
    // returns you the "load full history" button once you scroll to the
    // top of what we do have.
    chat.historyIsPartial = true;
  }
  // Prompts that couldn't be sent last time this session was open (see
  // offline-queue.ts) — append them after the replayed history as
  // "offline" bubbles so they're visible immediately, and so
  // flushOfflineQueue (fired from bridge.ts on bridge/ready) has
  // something in c.promptQueue to actually dispatch once connected.
  const held = await loadOfflineEntries(chat.sessionId);
  if (state.current !== chat) {
    return;
  }
  for (const persisted of held) {
    const entry: QueueEntry = {
      id: persisted.id,
      text: persisted.text,
      status: "offline",
      aheadAtEnqueue: 0,
      attachments: persisted.attachments,
    };
    chat.promptQueue.push(entry);
    chat.log.push({
      kind: "stream",
      role: "user",
      text: persisted.text,
      closed: true,
      queueEntry: entry,
      attachments: entry.attachments,
    });
  }
  if (cached || held.length > 0) {
    render();
  }
  connectChatSocket(chat);
}

// Discards whatever's loaded and forces a genuine full session/attach
// replay, bypassing the afterMessageId delta path entirely — the
// fallback for when the user scrolls past what the local cache (or a
// prior delta reconnect) actually has. Mirrors what already happens on
// a session's very first-ever open (lastSeenMessageId starts undefined
// there too), just triggered explicitly instead of by having nothing
// cached.
export function requestFullHistory(chat: ChatState): void {
  if (state.current !== chat) {
    return;
  }
  // Remember which message was topmost on screen so renderer.ts can
  // scroll back to it once the fresh replay lands, instead of leaving
  // the user wherever the raw scrollTop happens to fall in a rebuilt
  // (and likely now-longer) log. First bubble whose bottom edge is
  // still below the container's top edge — i.e. not yet fully
  // scrolled past.
  const body = document.querySelector<HTMLElement>(".chat-body");
  if (body) {
    const containerTop = body.getBoundingClientRect().top;
    for (const el of body.querySelectorAll<HTMLElement>("[data-message-id]")) {
      if (el.getBoundingClientRect().bottom > containerTop) {
        chat.scrollRestoreMessageId = el.dataset.messageId;
        break;
      }
    }
  }
  closeChatSocket();
  resetConnectionStateForReconnect(chat);
  resetChatHistoryState(chat);
  chat.historyIsPartial = false;
  render();
  connectChatSocket(chat);
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
  // Both cursors go out when we have them (PROTOCOL.md recommends it, and
  // the TUI does the same): the daemon prefers afterSeq, which names one
  // frame, and falls back to afterMessageId, which can only name a whole
  // message. A seq can only have come from a daemon that stamps them —
  // and any such daemon understands afterSeq — so the fallback is really
  // just for daemons predating the field.
  if (chat.lastSeenMessageId !== undefined) {
    url.searchParams.set("afterMessageId", chat.lastSeenMessageId);
  }
  if (chat.lastSeenSeq !== undefined) {
    url.searchParams.set("afterSeq", String(chat.lastSeenSeq));
  }
  // Which cursor the daemon will actually resolve, and so whether the
  // delta overlaps what we already rendered. See dropPendingCursorGroup.
  chat.resumedByMessageId =
    chat.lastSeenSeq === undefined && chat.lastSeenMessageId !== undefined;
  const ws = new WebSocket(url.toString());
  chat.ws = ws;

  ws.addEventListener("open", () => {
    /* wait for bridge/ready */
  });
  ws.addEventListener("message", (ev) => {
    // Ignore frames from a socket that's already been superseded — the
    // same guard the close handler below has always had, and for the
    // same reason. closeChatSocket() calls ws.close() and drops the
    // reference, but close() is asynchronous and does NOT detach this
    // listener: frames already in flight (or buffered by the bridge
    // mid-replay) keep arriving afterwards. Without this check they
    // were merged into whatever transcript was current by then, so a
    // session switch / reload / "Load full history" during a replay
    // interleaved the dying socket's remaining frames with the new
    // connection's fresh ones. Measured live as a full second copy of
    // history landing in one log: 168 prompt_received frames against 88
    // rendered prompts, agent bubbles duplicated verbatim (prompts
    // dedupe by messageId, streamed chunks can't), turn-stamps stranded
    // from the content they belonged to.
    if (!state.current || state.current.ws !== ws) {
      return;
    }
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
  // JSON-RPC responses can't cross sockets, so an id awaiting its
  // session/prompt response is unresolvable the moment the connection
  // dies — and worse than useless to keep: nextId (below) restarts at 1
  // per connection, so the new socket re-issues the same small ids and
  // the first response to ANY request on it can false-match a stale
  // entry, firing a phantom finalizeTurn mid-turn. That tears down the
  // live spinner; the next streamed chunk re-creates it at what is then
  // the bottom of the log, and it visibly fossilizes mid-transcript as
  // the rest of the turn streams in below. The orphaned prompt's real
  // turn-end still arrives: the reattached client carries a fresh
  // clientId, so it's no longer excluded from turn_complete fan-out as
  // the originator (see hydrateQueueFromSnapshot's comment), and the
  // bridge/ready busy=false reconciliation backstops even that.
  chat.ownPromptIds = new Map();
  chat.idleListeners = [];
  chat.readyListeners = [];
  chat.nextId = undefined;
  // Stale timers from the dead connection must not fire against
  // whatever socket replaces it — bridge.ts's startHeartbeat (fired
  // from the new connection's bridge/ready) sets up fresh ones.
  stopHeartbeat(chat);
}

// On a cold load with no session in the URL, fall back to whichever
// session was open last: highlight it in the list, and in split layout
// (where the chat pane would otherwise sit empty next to the rail) open
// it outright.
//
// Deliberately waits for the first session list rather than opening
// blind. Attaching to a cold, disk-only session resurrects it, and doing
// that unbidden just because a tab was reloaded would spin an agent back
// up nobody asked for — so a cold session is highlighted but not opened.
export function maybeRestoreLastSession(): void {
  // A hash route already picked a session; it wins.
  if (state.view === "chat") return;
  const id = state.lastSessionId;
  if (!id) return;
  setState({ listHighlightedSessionId: id });
  if (!isWideLayout()) return;
  const attempt = (n: number): void => {
    // The user got there first, or navigated away while we waited.
    if (state.view === "chat") return;
    const found = state.sessions.find((s) => s.sessionId === id);
    if (found) {
      if (found.status !== "cold") {
        replaceNextHash = true;
        openChat(id, false);
      }
      return;
    }
    if (n < 20) setTimeout(() => attempt(n + 1), 250);
  };
  attempt(0);
}

// Stashed by closeChat() below. Two consumers, both in swipe-nav.ts's
// list→chat drag-reveal: getLastClosedChat() lets the preview reuse the
// just-closed session's real, still-intact chat DOM (views.ts's
// peekChatViewRoot) instead of a blank/loading placeholder, and
// reopenClosedChat() below lets a committed swipe back into that same
// session resume the SAME ChatState in place — rather than openChat()'s
// usual fresh-from-scratch rebuild, which starts the log empty and
// re-snaps scroll to the bottom while cache/replay refills it. That
// reset is invisible on an ordinary tap (nothing was on screen a moment
// before), but right after the drag-reveal showed the real, already-
// scrolled transcript, it read as the whole view flickering back to
// blank-then-top on release.
let lastClosedChat: ChatState | null = null;
export function getLastClosedChat(): ChatState | null {
  return lastClosedChat;
}

// Captured alongside lastClosedChat, synchronously in closeChat() before
// its own teardown runs — i.e. while .chat-body is still attached and
// correctly laid out. swipe-nav.ts's drag-reveal needs this rather than
// re-reading the live DOM's scrollTop once it reuses the cached node:
// reinserting a detached scrollable element resets its scrollTop to 0
// on at least some browsers (the same class of bug the chat log's own
// syncChildren hit reordering nodes mid-stream), and the reveal's own
// reinsertion is exactly that operation. Capturing once here and
// threading the number through sidesteps it regardless of how many
// times the node gets detached/reattached before it's shown again.
let lastClosedScrollTop = 0;
export function getLastClosedScrollTop(): number {
  return lastClosedScrollTop;
}

// Resumes the given ChatState in place instead of rebuilding one from
// scratch — same mechanism scheduleReconnect already uses for an
// ordinary dropped-socket reconnect (resetConnectionStateForReconnect +
// connectChatSocket), which is exactly what "swiped away and back"
// looks like from the daemon's side: the socket closed, lastSeenMessageId
// still points at the right spot, and afterMessageId picks up a delta
// instead of a full replay. log/scroll/toolCalls/queue are untouched.
// Returns false (does nothing) if `chat` isn't actually the most
// recently closed one — stale by the time the caller's animation
// finished (a different session opened and closed meanwhile) — so the
// caller can fall back to a normal openChat().
export function reopenClosedChat(chat: ChatState): boolean {
  if (lastClosedChat !== chat) return false;
  lastClosedChat = null;
  setLocationHash(buildSessionHash(chat.sessionId, false));
  resetConnectionStateForReconnect(chat);
  chat.reconnectAttempt = 0;
  state.current = chat;
  setState({
    view: "chat",
    listHighlightedSessionId: chat.sessionId,
    lastSessionId: chat.sessionId,
  });
  connectChatSocket(chat);
  return true;
}

export function closeChat(): void {
  setLocationHash("");
  closeChatSocket();
  const returningFrom = state.current?.sessionId ?? state.lastSessionId;
  lastClosedChat = state.current;
  lastClosedScrollTop = state.current ? peekChatScrollTop(state.current) : 0;
  setState({
    view: "list",
    current: null,
    lastSessionId: returningFrom,
    // Land the keyboard-nav cursor (views.ts's listHighlightedSessionId)
    // on the card we just backed out of, so the list isn't cursor-less
    // on return — matches the TUI's session picker behavior.
    listHighlightedSessionId: returningFrom ?? state.listHighlightedSessionId,
  });
  // Paint the list and its highlight together on the next frame — see
  // renderNow. setState's own render is throttled, which is what made
  // the highlight arrive after the list it belongs to.
  renderNow();
}

// Called from main.ts's `online` listener. A WebSocket left open
// through a spell of no connectivity doesn't necessarily know it's
// dead yet — readyState can keep reporting OPEN until some future send
// finally times out, which could be a while. Nudging it closed here
// lets the existing close → scheduleReconnect → connectChatSocket chain
// take over immediately instead of waiting on that. Closing an
// already-effectively-dead (or already fine) socket is harmless either
// way — the `ws.addEventListener("close", ...)` in connectChatSocket
// already no-ops for a socket that's been superseded.
export function forceReconnect(): void {
  if (!state.current?.ws) {
    return;
  }
  try {
    state.current.ws.close();
  } catch {
    /* close errors are non-fatal */
  }
}

function closeChatSocket(): void {
  if (!state.current) {
    return;
  }
  if (state.current.reconnectTimer) {
    clearTimeout(state.current.reconnectTimer);
    state.current.reconnectTimer = undefined;
  }
  stopHeartbeat(state.current);
  if (state.current.ws) {
    try {
      state.current.ws.close();
    } catch {
      /* close errors are non-fatal */
    }
    state.current.ws = null;
  }
}
