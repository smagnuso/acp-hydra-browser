// REST helpers for the SPA. The host server proxies these to hydra
// (with the bearer token attached server-side); the browser only
// presents its session cookie.

import { setState, state, sameValue } from "./state.js";
import { render } from "./renderer.js";

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
    // While the user is typing in chat view, re-rendering blows away
    // the textarea (and focus). Render the list view normally; render
    // chat view only when a banner was just cleared, or when the
    // current session's visible metadata (title/cwd/agentId) changed
    // since the last poll. This is what makes deep-link reloads
    // eventually pick up the real session title.
    if (state.view === "list" || hadBanner) {
      render();
    } else if (state.view === "chat" && state.current) {
      const live = state.sessions.find(
        (s) => s.sessionId === state.current!.sessionId,
      );
      const fp = live
        ? `${live.title}|${live.cwd}|${live.agentId}|${live.currentModel}`
        : "";
      if (fp !== state.current._lastMetaFp) {
        state.current._lastMetaFp = fp;
        render();
      }
    }
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
    const data = await api<{ defaultAgent?: string; defaultCwd?: string }>(
      "/api/config",
    );
    setState({
      defaultAgent: data.defaultAgent ?? null,
      defaultCwd: data.defaultCwd ?? null,
    });
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
