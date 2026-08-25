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
// Trimming is NOT free the way a plain LRU usually is, which is what
// makes MAX_BYTES_PER_SESSION's value load-bearing rather than a taste
// call. Evicted frames aren't re-fetched later: the delta-replay cursor
// (lastSeenMessageId) is the NEWEST frame cached, so on the next open
// the daemon is only asked for what came after that — everything the
// trim dropped is simply gone from this client's view until the user
// hits "Load full history". A cap tight enough to evict real
// conversation therefore permanently mangles the transcript, and does
// it worst exactly where the frames are biggest.
//
// That's not hypothetical: a pasted screenshot rides inline as base64
// on its prompt_received frame, measured at 470KB-1MB apiece in real
// sessions. Against the original 1MB cap, ONE screenshot could evict
// nearly the entire cached transcript, and did — observed live as
// prompts vanishing while their replies and orphaned turn-stamps
// stayed behind, surviving every reload. Size this to hold a working
// window of image-bearing turns, not just text.
//
// A cache miss (nothing stored, or IndexedDB unavailable/blocked, e.g.
// private browsing) is always safe — callers fall back to the existing
// full-replay attach path, same as before this module existed.

import type { JsonRpcFrame } from "./acp.js";

const DB_NAME = "hydra-acp-history-cache";
// Bumped to 2 to discard every cache written before the replay fixes
// landed. Those entries can hold a transcript that's missing most of
// its agent messages while keeping the prompts — measured on a real
// session as 73 agent bubbles against 70 prompts, where a fresh full
// replay of the same session yields 215 against 90. Nothing can repair
// such an entry in place (the missing frames were trimmed away and are
// not re-fetched: the delta cursor is the newest frame cached, so the
// daemon is only ever asked for what came after it), and every reload
// rehydrates the damage. Dropping the store is the only honest repair.
// Cost is one full replay per session on first load after upgrading.
const DB_VERSION = 2;
const STORE = "sessions";
// 6MB holds several screenshot-bearing turns plus a long text
// transcript; 10 sessions caps the whole store around 60MB, well inside
// a normal IndexedDB origin quota.
const MAX_BYTES_PER_SESSION = 6_000_000;
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
      // Drop and recreate rather than create-if-absent: an upgrade from
      // an older version must discard whatever it held (see DB_VERSION),
      // and createObjectStore throws if the store already exists.
      if (req.result.objectStoreNames.contains(STORE)) {
        req.result.deleteObjectStore(STORE);
      }
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

// Every recordable session/update frame carries a messageId (cli's
// recordAndBroadcast stamps one on all of them, not just prompts/turn
// boundaries) — the same field queueFrameForCache is keyed on. Used to
// dedupe merges below; only session/update frames are ever queued, so
// the other shapes here are defensive, not expected in practice.
function frameMessageId(frame: JsonRpcFrame): string | undefined {
  const update = (frame.params as { update?: { messageId?: unknown } } | undefined)?.update;
  return typeof update?.messageId === "string" ? update.messageId : undefined;
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
const pendingFrames = new Map<string, JsonRpcFrame[]>();
const pendingLastSeen = new Map<string, string>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

// Called from acp.ts's handleNotification for every recordable
// session/update — the same gate that already drives ChatState's own
// lastSeenMessageId, so the cache and the live delta-reconnect cursor
// never disagree about what's been "seen". That gate fires on every
// streamed agent_message_chunk during an active turn (the daemon stamps
// a messageId on every recordable update, not just turn boundaries —
// see cli's recordAndBroadcast), so this has to stay cheap: two Map
// writes, nothing else. An earlier version computed byteSize(frame)
// (JSON.stringify + TextEncoder) right here, on the same main thread as
// keystroke handling, and was measurably competing with typing
// responsiveness during a fast-streaming reply. Sizing is deferred to
// mergeAndTrim, which only runs once per debounce window.
export function queueFrameForCache(
  sessionId: string,
  frame: JsonRpcFrame,
  messageId: string,
): void {
  const list = pendingFrames.get(sessionId) ?? [];
  list.push(frame);
  pendingFrames.set(sessionId, list);
  pendingLastSeen.set(sessionId, messageId);
  if (flushTimer === undefined) {
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      enqueueFlush();
    }, FLUSH_DEBOUNCE_MS);
  }
}

// Flushes MUST NOT overlap. flushPending is a read-modify-write against
// one IndexedDB record (get → merge → put) with an await in the middle,
// and it has two independent triggers: the debounce timer above and
// flushHistoryCacheNow below (pagehide / visibilitychange). Two in
// flight at once both read the same record, both merge onto that same
// snapshot, and the second put overwrites the first — silently dropping
// a whole batch of frames. It's unrecoverable, too: flushPending clears
// the batch out of pendingFrames before awaiting the write, and the
// surviving put still advances lastSeenMessageId, so the daemon is
// never asked to resend what was lost.
//
// Measured on a real session: a cache-hydrated transcript held 56
// prompts / 79 agent bubbles where a full replay of the same session
// gave 91 / 215, with the newest prompt missing entirely — losses the
// oldest-first byte trim cannot explain. Chaining serialises every
// flush so each one merges onto the previous one's committed result.
let flushChain: Promise<void> = Promise.resolve();

function enqueueFlush(): void {
  flushChain = flushChain.then(flushPending).catch(() => undefined);
}

// Flushes synchronously-available pending writes right away — used when
// the tab is about to go away (pagehide/visibilitychange) so the last
// debounce window's worth of frames isn't lost.
export function flushHistoryCacheNow(): void {
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  enqueueFlush();
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
  newFrames: JsonRpcFrame[],
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
      // Two independent connections for the same session (a stale one
      // still draining its own attach replay while a fresh one opens
      // after a quick session-switch-and-back, or a forced-full replay
      // landing on top of an already-cached partial one) can each queue
      // the same historical frame for caching. mergeAndTrim used to
      // concatenate blindly, so a redelivered frame didn't just render
      // twice (acp.ts's own dedup guards catch that) — it also
      // permanently doubled up in here, taking up budget the trim step
      // below would then spend evicting genuinely older, still-needed
      // frames to make room for (observed live: a duplicated response
      // survived while the prompt that triggered it got trimmed out).
      // Rebuild `existing.frames` through the same seen-set first so a
      // record that already has a duplicate baked in from before this
      // fix self-heals on its next write, not just stays merely
      // non-worsening.
      const seen = new Set<string>();
      const keptExisting: CachedFrame[] = [];
      for (const f of existing?.frames ?? []) {
        const id = frameMessageId(f.frame);
        if (id !== undefined) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        keptExisting.push(f);
      }
      const fresh: JsonRpcFrame[] = [];
      for (const frame of newFrames) {
        const id = frameMessageId(frame);
        if (id !== undefined) {
          if (seen.has(id)) continue;
          seen.add(id);
        }
        fresh.push(frame);
      }
      // Sizing happens here, once per debounce window, instead of per
      // frame at queue time — see queueFrameForCache.
      const sized: CachedFrame[] = fresh.map((frame) => ({
        frame,
        bytes: byteSize(frame),
      }));
      const frames = [...keptExisting, ...sized];
      let totalBytes =
        keptExisting.reduce((sum, f) => sum + f.bytes, 0) +
        sized.reduce((sum, f) => sum + f.bytes, 0);
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
