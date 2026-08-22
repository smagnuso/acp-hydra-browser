// Module-scoped app state. All other modules read/write through this
// object and call setState() (or directly mutate then call render()) to
// surface changes. Kept loose by design — typing every wire-shape would
// add ceremony with little payoff.

import type { AppState } from "./types.js";
import { render } from "./renderer.js";

// Topbar filters survive a reload so switching devices/tabs doesn't
// reset how the session list is sliced.
const FILTER_STORAGE_KEY = "hydra-acp-browser:filters";
const PERSISTED_KEYS = ["groupBy", "showCold", "hostFilter"] as const;

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
  defaultCwd: null,
  groupBy: "project",
  // Hide cold (disk-only) sessions by default. The "show cold"
  // toggle in the topbar reveals them; clicking one attaches over
  // WSS, which causes hydra to resurrect it from disk automatically.
  showCold: false,
  // Default to local: imported sessions (from peer hosts via the
  // archiver) are noisy if they all show up alongside the user's own
  // work. The dropdown lets them switch to a specific peer or "all".
  hostFilter: "__local",
  banner: null,
  modal: null,
  current: null,
  ...loadPersistedFilters(),
};

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
