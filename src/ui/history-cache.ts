// Local persistence for chat history, so a cold page load (app relaunch,
// hard refresh, iOS killing a backgrounded PWA) can paint a session's
// recent transcript immediately from cache and ask the daemon for only
// the delta (afterMessageId) instead of a full replay. Complements the
// in-memory lastSeenMessageId tracking in acp.ts/routing.ts, which only
// survives a live socket drop within the same tab session.
//
// IndexedDB, not localStorage — a single chatty session's cache can run
// into the hundreds of KB, and localStorage's ~5-10MB per-origin quota is
// shared with every other session plus the rest of the app.
//
// Two caps keep this bounded regardless of how long a session runs or
// how many sessions get opened over time:
//   - MAX_BYTES_PER_SESSION: oldest cached frames are dropped once a
//     session's own cache exceeds this (sized in bytes, not frame count,
//     since a single tool-output frame can dwarf a thousand chat chunks).
//   - MAX_CACHED_SESSIONS: an LRU across sessions themselves, evicting
//     the least-recently-opened session's entire cache once the count
//     is exceeded.
//
// A cache miss (nothing stored, or IndexedDB unavailable/blocked, e.g.
// private browsing) is always safe — callers fall back to the existing
// full-replay attach path, same as before this module existed.

import type { JsonRpcFrame } from "./acp.js";

const DB_NAME = "hydra-acp-history-cache";
const DB_VERSION = 1;
const STORE = "sessions";
const MAX_BYTES_PER_SESSION = 1_000_000;
const MAX_CACHED_SESSIONS = 10;
const FLUSH_DEBOUNCE_MS = 2000;

interface CachedFrame {
  frame: JsonRpcFrame;
  bytes: number;
}

interface CachedSession {
  sessionId: string;
  lastSeenMessageId?: string;
  frames: CachedFrame[];
  totalBytes: number;
  lastAccessed: number;
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
      req.result.createObjectStore(STORE, { keyPath: "sessionId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbPromise;
}

function byteSize(frame: JsonRpcFrame): number {
  try {
    return new TextEncoder().encode(JSON.stringify(frame)).length;
  } catch {
    return 0;
  }
}

// Read a session's cached transcript and bump its LRU timestamp. Returns
// null on a cache miss or any storage failure — always safe to treat the
// same as "nothing cached".
export async function loadCachedSession(
  sessionId: string,
): Promise<{ lastSeenMessageId?: string; frames: JsonRpcFrame[] } | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, "readwrite");
    } catch {
      resolve(null);
      return;
    }
    const store = tx.objectStore(STORE);
    const req = store.get(sessionId);
    req.onsuccess = () => {
      const rec = req.result as CachedSession | undefined;
      if (!rec) {
        resolve(null);
        return;
      }
      rec.lastAccessed = Date.now();
      store.put(rec);
      resolve({
        lastSeenMessageId: rec.lastSeenMessageId,
        frames: rec.frames.map((f) => f.frame),
      });
    };
    req.onerror = () => resolve(null);
  });
}

// In-memory buffer of not-yet-flushed frames per session, so a burst of
// chunks during an active turn costs one debounced write instead of one
// IndexedDB round trip per frame.
const pendingFrames = new Map<string, CachedFrame[]>();
const pendingLastSeen = new Map<string, string>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

// Called from acp.ts's handleNotification for every recordable
// session/update — the same gate that already drives ChatState's own
// lastSeenMessageId, so the cache and the live delta-reconnect cursor
// never disagree about what's been "seen".
export function queueFrameForCache(
  sessionId: string,
  frame: JsonRpcFrame,
  messageId: string,
): void {
  const list = pendingFrames.get(sessionId) ?? [];
  list.push({ frame, bytes: byteSize(frame) });
  pendingFrames.set(sessionId, list);
  pendingLastSeen.set(sessionId, messageId);
  if (flushTimer === undefined) {
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flushPending();
    }, FLUSH_DEBOUNCE_MS);
  }
}

// Flushes synchronously-available pending writes right away — used when
// the tab is about to go away (pagehide/visibilitychange) so the last
// debounce window's worth of frames isn't lost.
export function flushHistoryCacheNow(): void {
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  void flushPending();
}

async function flushPending(): Promise<void> {
  if (pendingFrames.size === 0) return;
  const sessionIds = Array.from(pendingFrames.keys());
  const db = await openDb();
  if (!db) {
    pendingFrames.clear();
    pendingLastSeen.clear();
    return;
  }
  for (const sessionId of sessionIds) {
    const newFrames = pendingFrames.get(sessionId);
    const lastSeenMessageId = pendingLastSeen.get(sessionId);
    pendingFrames.delete(sessionId);
    pendingLastSeen.delete(sessionId);
    if (!newFrames || !lastSeenMessageId) continue;
    await mergeAndTrim(db, sessionId, newFrames, lastSeenMessageId);
  }
  await enforceSessionLru(db);
}

function mergeAndTrim(
  db: IDBDatabase,
  sessionId: string,
  newFrames: CachedFrame[],
  lastSeenMessageId: string,
): Promise<void> {
  return new Promise((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, "readwrite");
    } catch {
      resolve();
      return;
    }
    const store = tx.objectStore(STORE);
    const getReq = store.get(sessionId);
    getReq.onsuccess = () => {
      const existing = getReq.result as CachedSession | undefined;
      const frames = [...(existing?.frames ?? []), ...newFrames];
      let totalBytes =
        (existing?.totalBytes ?? 0) +
        newFrames.reduce((sum, f) => sum + f.bytes, 0);
      // Trim oldest-first until back under budget. A single oversized
      // frame (e.g. a huge tool-output blob) can still exceed the cap on
      // its own — that's fine, it just means this session temporarily
      // caches only itself rather than nothing.
      while (frames.length > 1 && totalBytes > MAX_BYTES_PER_SESSION) {
        const dropped = frames.shift();
        if (dropped) totalBytes -= dropped.bytes;
      }
      const rec: CachedSession = {
        sessionId,
        lastSeenMessageId,
        frames,
        totalBytes,
        lastAccessed: Date.now(),
      };
      store.put(rec);
      resolve();
    };
    getReq.onerror = () => resolve();
  });
}

function enforceSessionLru(db: IDBDatabase): Promise<void> {
  return new Promise((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, "readwrite");
    } catch {
      resolve();
      return;
    }
    const store = tx.objectStore(STORE);
    const req = store.getAll();
    req.onsuccess = () => {
      const all = (req.result ?? []) as CachedSession[];
      if (all.length <= MAX_CACHED_SESSIONS) {
        resolve();
        return;
      }
      all.sort((a, b) => a.lastAccessed - b.lastAccessed);
      const toEvict = all.slice(0, all.length - MAX_CACHED_SESSIONS);
      for (const rec of toEvict) {
        store.delete(rec.sessionId);
      }
      resolve();
    };
    req.onerror = () => resolve();
  });
}

// Best-effort: flush whatever's buffered before the tab is backgrounded
// or torn down. pagehide covers iOS Safari (which doesn't reliably fire
// beforeunload); visibilitychange covers the general "tab hidden" case
// (switching apps, locking the phone) that isn't a full unload at all.
// Guarded — this module is reachable from acp.ts, which the server-side
// test suite imports under Node, where window/document don't exist.
if (typeof window !== "undefined" && typeof document !== "undefined") {
  window.addEventListener("pagehide", flushHistoryCacheNow);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushHistoryCacheNow();
  });
}

// Ask the browser not to evict this origin's storage under disk
// pressure — otherwise the whole point of this cache (surviving a cold
// relaunch) can get silently defeated. Best-effort: Safari doesn't
// implement the Storage API's persist() at all, and Chrome/Firefox may
// grant or deny based on their own heuristics (often auto-granted for
// an installed PWA) with no callback either way to react to — there's
// nothing to do differently on failure, since the cache already
// tolerates being empty.
if (typeof navigator !== "undefined" && navigator.storage?.persist) {
  void navigator.storage.persist();
}
