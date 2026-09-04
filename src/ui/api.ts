// REST helpers for the SPA. The host server proxies these to hydra
// (with the bearer token attached server-side); the browser only
// presents its session cookie.

import { setState, state, sameValue, markRailDirty } from "./state.js";
import { render, isActivelyTyping } from "./renderer.js";
import { isWideLayout } from "./dom.js";
import { forceReconnect } from "./routing.js";
import { mergeSessionListPage } from "./session-merge.js";
import { loadPersistedSessionCache, queueSessionCacheWrite } from "./session-cache.js";
import type { SessionInfo } from "./types.js";

function hasActiveSelection(): boolean {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) {
    return false;
  }
  return sel.toString().length > 0;
}

// `timeoutMs` guards against a request that never settles. A bare fetch
// has no timeout: if the connection stalls (a cell/wifi handoff, the tab
// backgrounded mid-flight) the promise simply never resolves, and any UI
// gated on its completion is stuck until a reload.
export async function api<T = unknown>(
  path: string,
  opts?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const { timeoutMs, ...init } = opts ?? {};
  const controller = timeoutMs !== undefined ? new AbortController() : undefined;
  const timer =
    controller !== undefined
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined;
  let r: Response;
  try {
    r = await fetch(path, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      ...(controller ? { signal: controller.signal } : {}),
      ...init,
    });
  } catch (err) {
    if (controller?.signal.aborted) {
      throw new Error("timed out — it may still have completed; check the session list");
    }
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const j = (await r.json()) as { error?: string };
      if (j && j.error) msg = j.error;
    } catch {
      // Non-JSON error body; fall through with status text.
    }
    throw new Error(msg);
  }
  if (r.status === 204) return null as T;
  return (await r.json()) as T;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
// Cursor from the last pollAllSessions() response, or from the
// IndexedDB-persisted cache once seedSessionCache() has run. undefined
// means "no cursor yet" — that poll is a full listing same as before;
// every poll after merges incrementally via mergeSessionListPage.
let sessionCursor: number | undefined;

// Seed state.sessions and sessionCursor from the persisted cache — see
// session-cache.ts's doc comment for why this is safe even when stale.
// Awaited by main.ts before the first render() so a cold load paints the
// cached list immediately instead of an empty one; startPolling's own
// network request still runs uncached-cursor-aware on top of it exactly
// as if this seed hadn't happened; the daemon's response is what's
// authoritative, this only affects what's on screen before it arrives.
export async function seedSessionCache(): Promise<void> {
  const cached = await loadPersistedSessionCache();
  if (cached) {
    state.sessions = cached.sessions;
    sessionCursor = cached.cursor || undefined;
  }
}

export async function pollSessions(): Promise<void> {
  // Skip this cycle while genuinely, recently typing (renderer.ts's
  // isActivelyTyping — a real keystroke in the last 250ms, not just "a
  // text input happens to have focus"). sameValue's JSON.stringify
  // comparison below is a real synchronous main-thread cost, and it ran
  // unconditionally every 2s on a fixed timer no matter what the user
  // was doing — competing with keystroke handling independent of typing
  // speed, which is what made it show up as periodic stalls during
  // held-key repeat (several characters through, then a stall whenever
  // the poll happened to land, repeat) rather than uniform lag.
  //
  // This used to be a bare "is a text input focused" check instead, on
  // the theory that the list being one cycle staler while focused is
  // invisible — true only because the list wasn't on screen during a
  // chat at all back then. In wide layout's split view the rail stays
  // visible the whole time, and the composer auto-focuses on open and
  // typically just sits focused afterward (not being actively typed
  // into) — so the old check could block every poll for as long as a
  // session was open, not just while typing, and the rail would never
  // pick up e.g. a turn starting elsewhere. isActivelyTyping's recency
  // window fixes that while still protecting actual keystroke bursts.
  if (isActivelyTyping()) {
    return;
  }
  // While viewing a single session, only that session's own metadata
  // (title/cwd/agentId/currentModel/workspace) can possibly need
  // refreshing — nothing else in state.sessions is read from chat view.
  // Polling the full list just to read one entry back out means
  // fetching, JSON-parsing, and (in pollAllSessions' sameValue check)
  // re-serializing every other session on the install every 2s for no
  // reason a long-lived install can have hundreds of entries. Hit the
  // single-session endpoint instead — except in the wide-layout split
  // view, where the session-list rail is on screen the whole time
  // alongside the chat and genuinely needs the full list kept fresh.
  if (state.view === "chat" && state.current && !isWideLayout()) {
    await pollCurrentSessionOnly(state.current.sessionId);
    return;
  }
  await pollAllSessions();
}

// A chat marked cold (bridge.ts's hydra-acp/session/closed handling)
// leaves its WS open but idle — nothing ever closes it, so the existing
// close -> scheduleReconnect -> connectChatSocket chain (routing.ts)
// never fires on its own. If the daemon now reports this same session
// warm again, something else (the TUI, another tab) already resurrected
// it — forcing the stale socket closed just lets that chain pick up the
// live session instead of leaving the pill stuck on "cold" until the
// user backs out to the list and back in. This never resurrects a
// session itself; it only reacts to warmth the daemon already reports.
function reattachIfWarmedElsewhere(live: SessionInfo): void {
  if (
    live.status === "warm" &&
    state.current &&
    state.current.sessionId === live.sessionId &&
    state.current.cold
  ) {
    forceReconnect();
  }
}

// Merges the refreshed entry into state.sessions in place (by
// sessionId) rather than replacing the array, so every other
// state.sessions.find(...) call site elsewhere in the app still sees
// whatever it last had — stale, but nothing else is on-screen to read
// it while we're viewing one session.
async function pollCurrentSessionOnly(sessionId: string): Promise<void> {
  try {
    const live = await api<SessionInfo>(
      `/api/sessions/${encodeURIComponent(sessionId)}`,
    );
    const idx = state.sessions.findIndex((s) => s.sessionId === sessionId);
    if (idx >= 0) {
      state.sessions[idx] = live;
    } else {
      state.sessions.push(live);
    }
    // Navigated away (or the chat closed) while the request was in
    // flight — the fetched data is still merged above for whenever the
    // list is next shown, but there's no chat-view fingerprint to
    // reconcile against anymore.
    if (!state.current || state.current.sessionId !== sessionId) {
      return;
    }
    reattachIfWarmedElsewhere(live);
    // This is what makes deep-link reloads eventually pick up the real
    // session title.
    const fp = `${live.title}|${live.cwd}|${live.agentId}|${live.currentModel}|${live.workspace?.label}|${live.workspace?.vcs?.branch}|${live.workspace?.clean}`;
    if (fp !== state.current._lastMetaFp) {
      state.current._lastMetaFp = fp;
      render();
    }
  } catch {
    // Best-effort — a transient failure just skips this cycle's
    // refresh; the next poll tries again. A genuinely closed/deleted
    // session is already surfaced via the WS-level
    // hydra-acp/session/closed banner (bridge.ts), so duplicating that
    // here as a second, possibly-stale error banner would just be
    // noise.
  }
}

async function pollAllSessions(): Promise<void> {
  try {
    // Daemon's default `/v1/sessions` view already excludes one-shot
    // `hydra cat` runs and editor-spawned empty sessions (anything not
    // effective-interactive). views.ts still filters cold cards
    // client-side when state.showCold is false.
    //
    // `since=sessionCursor` (once we have one) asks the daemon for only
    // what changed since the last poll instead of statting and
    // serializing every cold session on disk — the full listing is what
    // made this endpoint expensive enough to peg a core on a long-lived
    // install. See PROTOCOL.md's GET /v1/sessions `since=`.
    const incremental = sessionCursor !== undefined;
    const path =
      incremental ? `/api/sessions?since=${sessionCursor}` : "/api/sessions";
    const data = await api<{
      sessions?: unknown[];
      removed?: string[];
      cursor?: number;
    }>(path);
    const page = {
      sessions: (data.sessions as SessionInfo[]) ?? [],
      removed: data.removed ?? [],
      cursor: data.cursor ?? 0,
    };
    const newSessions = mergeSessionListPage(state.sessions, page, incremental) as never;
    sessionCursor = page.cursor;
    // Only worth persisting when a cold session actually changed — most
    // polls carry nothing but warm-session churn (busy/timestamps), and
    // the persisted cache doesn't even store warm rows. See
    // session-cache.ts's doc comment for why queuing this on every tick
    // regardless would defeat its own purpose.
    if (page.removed.length > 0 || page.sessions.some((s) => s.status === "cold")) {
      queueSessionCacheWrite(newSessions as SessionInfo[], sessionCursor);
    }
    const hadBanner = state.banner !== null;
    const sessionsChanged = !sameValue(state.sessions, newSessions);
    state.sessions = newSessions;
    state.banner = null;
    // Wide layout keeps the rail (and this full-list poll) active even
    // while a chat is open — see reattachIfWarmedElsewhere for why a
    // cold chat needs this nudge.
    if (state.current) {
      const live = (newSessions as SessionInfo[]).find(
        (s) => s.sessionId === state.current!.sessionId,
      );
      if (live) {
        reattachIfWarmedElsewhere(live);
      }
    }
    // Bypasses setState (the assignment above), so its rail-dirty
    // tracking needs the same signal explicitly — see state.ts.
    if (sessionsChanged) {
      markRailDirty();
    }
    if (!sessionsChanged && !hadBanner) {
      return;
    }
    // Don't disrupt the user mid-selection. Skip this cycle; the next
    // poll re-checks. Banner changes still render so errors surface.
    if (!hadBanner && hasActiveSelection()) {
      return;
    }
    // While a modal is open the list is hidden behind a backdrop and
    // the user is focused on the form. Re-rendering blows away native
    // <select> popups (and any other transient UI the browser owns).
    if (!hadBanner && state.modal) {
      return;
    }
    render();
  } catch (err) {
    // Could be from hydra-acp-browser (auth, CSRF, host allowlist) or
    // from the upstream hydra daemon (502). The error text comes from
    // whichever responded; surface it directly without claiming hydra.
    setState({
      banner: { kind: "bad", text: "session list failed: " + (err as Error).message },
    });
  }
}

export function startPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  void pollSessions();
  pollTimer = setInterval(() => {
    void pollSessions();
  }, 2000);
}

export async function loadAgents(): Promise<void> {
  try {
    const data = await api<{ agents?: unknown[] }>("/api/agents");
    setState({ agents: (data.agents as never) ?? [] });
  } catch (err) {
    setState({
      banner: { kind: "warn", text: "agents unavailable: " + (err as Error).message },
    });
  }
}

// Failures are silent (no banner): an older daemon predating
// federation, or one with no remotes configured, both just leave the
// "create on" dropdown showing only "local" — not worth alarming
// anyone over.
export async function loadRemotes(): Promise<void> {
  try {
    const data = await api<{ remotes?: unknown[] }>("/api/remotes");
    setState({ remotes: (data.remotes as never) ?? [] });
  } catch {
    setState({ remotes: [] });
  }
}

export async function loadConfig(): Promise<void> {
  try {
    const data = await api<{ defaultCwd?: string }>("/api/config");
    setState({ defaultCwd: data.defaultCwd ?? null });
  } catch {
    // Older daemons don't expose /v1/config; fall through silently and
    // the modal uses its existing fallbacks.
  }
}

// Post a parsed bundle to the proxy, which forwards to the daemon's
// /v1/sessions/import. Returns the new local sessionId (or the
// preserved one on replace). On 409 the error message carries the
// existing local id so the caller can offer "replace?".
export interface ImportResult {
  sessionId: string;
  importedFromSessionId: string;
  replaced: boolean;
}

export async function importBundle(
  bundle: unknown,
  opts: { replace?: boolean } = {},
): Promise<ImportResult> {
  return api<ImportResult>("/api/sessions/import", {
    method: "POST",
    body: JSON.stringify({ bundle, replace: opts.replace === true }),
  });
}

// Detect the 409 (BundleAlreadyImported) response and pull the
// existing-local-id out of the JSON body, so views.ts can offer a
// "replace?" prompt instead of forcing the user to retry blindly.
// Returns undefined if the response was not a 409. The api() helper
// throws on any non-2xx, so this is a parallel low-level path.
export async function tryImportBundleWith409(
  bundle: unknown,
): Promise<{ ok: true; result: ImportResult } | { ok: false; existingSessionId?: string; status: number; message: string }> {
  const r = await fetch("/api/sessions/import", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bundle }),
  });
  if (r.ok) {
    return { ok: true, result: (await r.json()) as ImportResult };
  }
  let existingSessionId: string | undefined;
  let message = `${r.status} ${r.statusText}`;
  try {
    const j = (await r.json()) as { error?: string; existingSessionId?: string };
    if (j.existingSessionId) existingSessionId = j.existingSessionId;
    if (j.error) message = j.error;
  } catch {
    // Non-JSON error body; surface status text.
  }
  return { ok: false, status: r.status, message, existingSessionId };
}
