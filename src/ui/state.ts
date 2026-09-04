// Module-scoped app state. All other modules read/write through this
// object and call setState() (or directly mutate then call render()) to
// surface changes. Kept loose by design — typing every wire-shape would
// add ceremony with little payoff.

import type { AppState } from "./types.js";
import { render } from "./renderer.js";

// Topbar filters survive a reload so switching devices/tabs doesn't
// reset how the session list is sliced.
const FILTER_STORAGE_KEY = "hydra-acp-browser:filters";
const PERSISTED_KEYS = [
  "groupBy",
  "showCold",
  "hostFilter",
  "hideThoughts",
  "notifyOnTurnEnd",
  "theme",
  "fontScale",
  "railWidth",
  // Which session to come back to on a cold load — see
  // maybeRestoreLastSession.
  "lastSessionId",
] as const;

function loadPersistedFilters(): Partial<AppState> {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function savePersistedFilters(): void {
  try {
    const out: Record<string, unknown> = {};
    for (const k of PERSISTED_KEYS) out[k] = state[k];
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(out));
  } catch {
    // Private browsing / quota — the filters just won't persist.
  }
}

export const state: AppState = {
  view: "list",
  sessions: [],
  agents: [],
  remotes: [],
  defaultCwd: null,
  groupBy: "recent",
  // Show cold (disk-only) sessions by default. The "show cold"
  // toggle in the topbar can hide them; clicking one attaches over
  // WSS, which causes hydra to resurrect it from disk automatically.
  showCold: true,
  sessionSearch: "",
  fontScale: 1,
  railWidth: null,
  // Default to local: imported sessions (from peer hosts via the
  // archiver) are noisy if they all show up alongside the user's own
  // work. The dropdown lets them switch to a specific peer or "all".
  hostFilter: "__local",
  listHighlightedSessionId: null,
  hideThoughts: false,
  notifyOnTurnEnd: false,
  // Matches the app's always-dark behavior before theming existed —
  // "system" is opt-in, not the default, so nobody's UI silently
  // switches to light just because their OS happens to be.
  theme: "dark",
  banner: null,
  modal: null,
  current: null,
  lastSessionId: null,
  ...loadPersistedFilters(),
};

// Fields that affect the session-list rail's rendering (wide-layout
// split view, views.ts's renderSplitLayout). tryPatchChat's fast path
// keeps the chat pane patching in place during a stream without a full
// #app teardown, which means the rail — a sibling, not touched by that
// patch — needs its own cheap "did anything I'd render change" signal
// instead of unconditionally rebuilding hundreds of session cards on
// every streamed chunk (a render() fires roughly every 100ms during an
// active turn). markRailClean()/isRailDirty() below back that check;
// this list is what feeds it. pollAllSessions (api.ts) mutates
// `sessions` directly rather than through setState, so it calls
// markRailDirty() itself.
const RAIL_AFFECTING_KEYS = [
  "sessions",
  "groupBy",
  "showCold",
  "hostFilter",
  "listHighlightedSessionId",
  "sessionSearch",
] as const;

let railDirty = true;
export function markRailDirty(): void {
  railDirty = true;
}
export function isRailDirty(): boolean {
  return railDirty;
}
export function markRailClean(): void {
  railDirty = false;
}

export function setState(patch: Partial<AppState>): void {
  let changed = false;
  let filtersChanged = false;
  for (const k of Object.keys(patch) as Array<keyof AppState>) {
    const next = (patch as Record<string, unknown>)[k as string];
    if (!sameValue(state[k], next)) {
      (state as unknown as Record<string, unknown>)[k as string] = next;
      changed = true;
      if ((PERSISTED_KEYS as readonly string[]).includes(k as string)) {
        filtersChanged = true;
      }
      if ((RAIL_AFFECTING_KEYS as readonly string[]).includes(k as string)) {
        railDirty = true;
      }
    }
  }
  if (filtersChanged) {
    savePersistedFilters();
  }
  if (changed) {
    render();
  }
}

// Shallow-deep equality good enough for state slices (banner objects,
// session arrays, etc.). Stops setState from triggering a re-render
// when the patch repeats existing values — common when poll fails
// repeatedly with the same banner text.
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
