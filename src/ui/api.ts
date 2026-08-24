// REST helpers for the SPA. The host server proxies these to hydra
// (with the bearer token attached server-side); the browser only
// presents its session cookie.

import { setState, state, sameValue, markRailDirty } from "./state.js";
import { render } from "./renderer.js";
import { isWideLayout } from "./dom.js";
import type { SessionInfo } from "./types.js";

function hasActiveSelection(): boolean {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) {
    return false;
  }
  return sel.toString().length > 0;
}

export async function api<T = unknown>(
  path: string,
  opts?: RequestInit,
): Promise<T> {
  const r = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
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

export async function pollSessions(): Promise<void> {
  // Skip this cycle entirely while a text input is focused. sameValue's
  // JSON.stringify comparison below is a real synchronous main-thread
  // cost, and it ran unconditionally every 2s on a fixed timer no
  // matter what the user was doing — competing with keystroke handling
  // independent of typing speed, which is what made it show up as
  // periodic stalls during held-key repeat (several characters through,
  // then a stall whenever the poll happened to land, repeat) rather
  // than uniform lag. The session list being one cycle staler while
  // focused is invisible; a dropped or delayed keystroke isn't.
  if (
    document.activeElement instanceof HTMLTextAreaElement ||
    document.activeElement instanceof HTMLInputElement
  ) {
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
    const data = await api<{ sessions?: unknown[] }>("/api/sessions");
    const rawSessions =
      (data.sessions as Array<Record<string, unknown>>) ?? [];
    const newSessions = rawSessions as never;
    const hadBanner = state.banner !== null;
    const sessionsChanged = !sameValue(state.sessions, newSessions);
    state.sessions = newSessions;
    state.banner = null;
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
