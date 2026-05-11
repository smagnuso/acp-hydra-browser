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
    // Daemon always returns everything; views.ts filters cold cards
    // client-side when state.showCold is false.
    const data = await api<{ sessions?: unknown[] }>("/api/sessions");
    const newSessions = (data.sessions as Array<Record<string, unknown>> ?? []) as never;
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
      const fp = live ? `${live.title}|${live.cwd}|${live.agentId}` : "";
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
