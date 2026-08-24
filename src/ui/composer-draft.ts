// Persists the composer's not-yet-sent draft text per session, so a
// reload, an app relaunch, or iOS killing a backgrounded PWA doesn't
// silently discard a half-typed prompt. ChatState.composerValue itself
// is pure in-memory and always starts blank on a fresh openChat() — this
// is what lets a fresh ChatState come back with the draft intact.
//
// localStorage, not IndexedDB: a single session's draft is a few KB of
// text at most, so it doesn't need history-cache.ts's byte-capping/LRU
// machinery, and localStorage being synchronous means no race with the
// page actually going away. Text only — pasted image attachments aren't
// persisted here; those can run to hundreds of KB each and would need
// IndexedDB to be safe against localStorage's much smaller per-origin
// quota, for what's a rarer interruption case than "was mid-sentence."

const KEY_PREFIX = "hydra-acp-draft:";
const WRITE_DEBOUNCE_MS = 400;

function storageKey(sessionId: string): string {
  return KEY_PREFIX + sessionId;
}

// Read is synchronous and uncached — called once per openChat(), not a
// hot path.
export function loadDraft(sessionId: string): string {
  try {
    return localStorage.getItem(storageKey(sessionId)) ?? "";
  } catch {
    return "";
  }
}

const pendingWrites = new Map<string, string>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

// Called on every keystroke — debounced so typing doesn't hit
// localStorage (synchronous, main-thread, and genuinely slow on some
// platforms — iOS Safari in particular) on every character. Must be a
// true debounce (reset the timer on each call), not a throttle: an
// earlier version only started the timer if none was already running,
// which meant a burst of continuous typing still hit localStorage once
// per WRITE_DEBOUNCE_MS the whole time typing continued, instead of
// once after it actually paused — periodic main-thread stalls for as
// long as you kept typing.
export function queueDraftWrite(sessionId: string, text: string): void {
  pendingWrites.set(sessionId, text);
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer);
  }
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    flushDraftWrites();
  }, WRITE_DEBOUNCE_MS);
}

// Called wherever composerValue is cleared after a successful send, so
// a sent prompt doesn't reappear as a "draft" next time the session
// opens.
export function clearDraft(sessionId: string): void {
  pendingWrites.delete(sessionId);
  try {
    localStorage.removeItem(storageKey(sessionId));
  } catch {
    /* storage unavailable (private mode, quota) — nothing to clear */
  }
}

function flushDraftWrites(): void {
  for (const [sessionId, text] of pendingWrites) {
    try {
      if (text) {
        localStorage.setItem(storageKey(sessionId), text);
      } else {
        localStorage.removeItem(storageKey(sessionId));
      }
    } catch {
      /* quota exceeded or storage disabled — drop this write */
    }
  }
  pendingWrites.clear();
}

export function flushDraftWritesNow(): void {
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  flushDraftWrites();
}

// Guarded — this module is reachable from acp.ts's import graph, which
// the server-side test suite imports under Node, where window/document
// don't exist (see history-cache.ts for the same pattern).
if (typeof window !== "undefined" && typeof document !== "undefined") {
  window.addEventListener("pagehide", flushDraftWritesNow);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushDraftWritesNow();
  });
}
