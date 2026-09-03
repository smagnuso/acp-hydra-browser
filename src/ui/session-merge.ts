// Pure merge for GET /api/sessions responses. Deliberately has no
// dependency on state.ts/dom.ts/renderer.ts so it can be unit tested
// with plain node:test — see test/session-merge.test.ts — without pulling
// in any browser globals (document, localStorage, ...) those modules
// touch at import time.
import type { SessionInfo } from "./types.js";

export interface SessionListPage {
  sessions: SessionInfo[];
  // Session ids deleted at or after the cursor the request was made
  // with. Always [] for a request made with no `since`.
  removed: string[];
  // Pass back as `since` on the next request to keep polling incrementally.
  cursor: number;
}

// Merge a GET /api/sessions response into the client's current session
// list. `incremental` must be false for a page fetched with no `since`
// (a plain replace) and true for one fetched with a cursor — see
// PROTOCOL.md's GET /v1/sessions `since=` for the daemon's contract this
// mirrors.
//
// On an incremental page the daemon returns the FULL warm set plus only
// the cold rows that changed, so: drop the OLD warm rows (the incoming
// warm set is the complete, current truth), drop anything in `removed`,
// then upsert what came back — new/changed cold rows and the fresh warm
// rows both land by the same upsert. A session that went warm->cold
// between polls is covered without special-casing: the daemon bumps that
// record's mtime on cool-down specifically so it shows up here as a
// changed cold row instead of surviving as a stale warm entry.
export function mergeSessionListPage(
  current: SessionInfo[],
  page: SessionListPage,
  incremental: boolean,
): SessionInfo[] {
  if (!incremental) {
    return page.sessions;
  }
  const merged = new Map(current.map((s) => [s.sessionId, s]));
  // Purge anything NOT definitively cold, rather than only `=== "warm"`.
  // The incoming page carries the complete truth for every non-cold row,
  // so a local row that isn't cold must either come back in this response
  // or not exist. `SessionInfo.status` is optional, so keying the purge on
  // `=== "warm"` left a status-less row un-purged AND un-overwritten
  // (nothing in page.sessions to replace it) — an immortal stale card that
  // renders as live and never updates again, and that session-cache.ts
  // would then persist to IndexedDB so it survived reloads too.
  for (const s of merged.values()) {
    if (s.status !== "cold") {
      merged.delete(s.sessionId);
    }
  }
  for (const id of page.removed) {
    merged.delete(id);
  }
  for (const s of page.sessions) {
    merged.set(s.sessionId, s);
  }
  return [...merged.values()];
}
