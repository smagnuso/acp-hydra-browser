// Local persistence for the session list, so a cold page load (app
// relaunch, hard refresh, iOS killing a backgrounded PWA) can paint the
// rail immediately instead of showing an empty list while the daemon
// answers the first /api/sessions request.
//
// THAT IS ALL IT DOES. It is a picture, not a source of truth — see
// history-cache.ts's doc comment for the incident history behind that
// rule on the sibling chat cache; the same discipline applies here.
// api.ts's pollAllSessions always treats the daemon's response as
// authoritative and merges onto whatever this seeded, never the other
// way around. Being stale, holed or entirely absent costs nothing but a
// slower first paint.
//
// It DOES also seed the `since=` cursor used to ask the daemon for an
// incremental listing (see PROTOCOL.md's GET /v1/sessions `since=`, and
// session-merge.ts). That is safe in a way the chat cache's old cursor
// usage was not: an incorrect/stale cursor here can only make the next
// response BIGGER (more rows come back as "changed since"), never drop
// data, because the daemon's tombstones never expire (session-manager.ts)
// and mtime-based filtering is monotonic. Worst case is a wasted byte or
// two, not a silently missing session.
//
// IndexedDB, not localStorage — at a few thousand sessions this can run
// into the hundreds of KB (see trimForCache for what's actually kept),
// past the threshold history-cache.ts's own comment gives for avoiding
// localStorage's shared, smaller per-origin quota.
//
// Only COLD sessions are persisted. Warm ones are always returned in
// full on every poll regardless (served from the daemon's in-memory
// map, no disk cost) — caching them here would be dead weight rewritten
// on every save for no benefit.

import type { SessionInfo } from "./types.js";

const DB_NAME = "hydra-acp-session-cache";
const DB_VERSION = 1;
const STORE = "cache";
const RECORD_KEY = "sessions";
const FLUSH_DEBOUNCE_MS = 2000;

// The subset of SessionInfo the session-list card (views.ts) actually
// renders. Pick<> rather than a hand-copied interface so this can't
// silently drift out of sync with SessionInfo's field types.
export type CachedSessionInfo = Pick<
  SessionInfo,
  | "sessionId"
  | "cwd"
  | "agentId"
  | "currentModel"
  | "title"
  | "status"
  | "busy"
  | "awaitingInput"
  | "priority"
  | "importedFromMachine"
  | "upstreamSessionId"
  | "armedTasks"
  | "updatedAt"
>;

interface CacheRecord {
  key: typeof RECORD_KEY;
  sessions: CachedSessionInfo[];
  cursor: number;
}

export function trimForCache(sessions: SessionInfo[]): CachedSessionInfo[] {
  const out: CachedSessionInfo[] = [];
  for (const s of sessions) {
    if (s.status === "warm") {
      continue;
    }
    out.push({
      sessionId: s.sessionId,
      cwd: s.cwd,
      agentId: s.agentId,
      currentModel: s.currentModel,
      title: s.title,
      status: s.status,
      busy: s.busy,
      awaitingInput: s.awaitingInput,
      priority: s.priority,
      importedFromMachine: s.importedFromMachine,
      upstreamSessionId: s.upstreamSessionId,
      armedTasks: s.armedTasks,
      updatedAt: s.updatedAt,
    });
  }
  return out;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (!("indexedDB" in window)) {
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbPromise;
}

// Read the persisted cache. Returns null on a cold install, a storage
// failure, or a malformed record — always safe to treat the same as
// "nothing cached": the caller falls back to an uncursored first poll.
export async function loadPersistedSessionCache(): Promise<
  { sessions: CachedSessionInfo[]; cursor: number } | null
> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, "readonly");
    } catch {
      resolve(null);
      return;
    }
    const req = tx.objectStore(STORE).get(RECORD_KEY);
    req.onsuccess = () => {
      const rec = req.result as CacheRecord | undefined;
      if (!rec || !Array.isArray(rec.sessions) || typeof rec.cursor !== "number") {
        resolve(null);
        return;
      }
      resolve({ sessions: rec.sessions, cursor: rec.cursor });
    };
    req.onerror = () => resolve(null);
  });
}

// Debounced write of the full current session list + cursor. Callers
// should only queue this when something cold actually changed (see
// api.ts's pollAllSessions) — most polls touch nothing but warm-session
// fields this cache doesn't store, and queuing unconditionally would
// mean re-trimming and flushing on every 2s tick for no benefit. Unlike
// history-cache.ts's frame queue, there's nothing to merge onto: the
// caller always holds the full current list, so each queued write simply
// replaces whatever's pending.
let pendingWrite: { sessions: SessionInfo[]; cursor: number } | undefined;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let flushChain: Promise<void> = Promise.resolve();

export function queueSessionCacheWrite(sessions: SessionInfo[], cursor: number): void {
  pendingWrite = { sessions, cursor };
  if (flushTimer === undefined) {
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      enqueueFlush();
    }, FLUSH_DEBOUNCE_MS);
  }
}

// Flush whatever's pending right away — used when the tab is about to go
// away (pagehide/visibilitychange) so the last debounce window's write
// isn't lost. Same rationale as history-cache.ts's flushHistoryCacheNow.
export function flushSessionCacheNow(): void {
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  enqueueFlush();
}

function enqueueFlush(): void {
  // Chained rather than fired independently, same reasoning as
  // history-cache.ts's flushChain: the debounce timer and a
  // pagehide-triggered flush can both land close together, and a `put`
  // of the full record makes overlap harmless either way (last one to
  // land wins, not a merge that can drop data) — but chaining still
  // avoids two concurrent transactions racing the same store for no
  // reason.
  flushChain = flushChain.then(flushPending).catch(() => undefined);
}

async function flushPending(): Promise<void> {
  const write = pendingWrite;
  if (!write) return;
  pendingWrite = undefined;
  const db = await openDb();
  if (!db) return;
  const rec: CacheRecord = {
    key: RECORD_KEY,
    sessions: trimForCache(write.sessions),
    cursor: write.cursor,
  };
  return new Promise((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, "readwrite");
    } catch {
      resolve();
      return;
    }
    tx.objectStore(STORE).put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

// Guarded — trimForCache above is unit tested directly under Node
// (test/session-cache.test.ts), where window/document don't exist.
if (typeof window !== "undefined" && typeof document !== "undefined") {
  window.addEventListener("pagehide", flushSessionCacheNow);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSessionCacheNow();
  });
}
