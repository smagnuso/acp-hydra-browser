// Local persistence for chat history, so a cold page load (app relaunch,
// hard refresh, iOS killing a backgrounded PWA) can paint a session's
// recent transcript immediately instead of showing an empty pane while
// the daemon replays.
//
// THAT IS ALL IT DOES. It is a picture, not a source of truth. A cold
// open paints from here and then asks the daemon for a FULL replay,
// which replaces the painted log wholesale (routing.ts's
// hydrateFromCacheThenConnect, acp.ts's fromCache handling). Nothing
// downstream trusts this data, and the cache being stale, short, holed
// or entirely absent costs nothing but a slower first paint.
//
// It was not always so, and the difference is the entire bug history of
// this file. The cache used to also supply the delta-replay cursor: the
// newest frame it held was sent as afterMessageId, so the daemon skipped
// everything up to it. That made the cache authoritative over content it
// did not own — any frame missing from it (trimmed by the byte cap, lost
// to a failed flush, never written because the tab was killed) was never
// requested either, and the gap became permanent, surviving every reload.
// It produced three DB_VERSION bumps' worth of unrepairable transcripts,
// a byte trim that cut mid-turn and orphaned prompts from their replies,
// and finally a persisted cursor observed regressing 55 minutes past a
// position the client demonstrably held. Every one of those was a
// missing-prompt report from a real user. The TUI, which keeps no such
// cache and simply replays from the daemon, had none of them.
//
// So: do not reintroduce a cursor here, and do not let any caller treat
// a cache hit as "I already have this history".
//
// IndexedDB, not localStorage — a single chatty session's cache can run
// into the hundreds of KB, and localStorage's ~5-10MB per-origin quota is
// shared with every other session plus the rest of the app.
//
// Two caps keep it bounded: MAX_BYTES_PER_SESSION per session (sized in
// bytes, not frames, since one tool-output frame can dwarf a thousand
// chat chunks) and MAX_CACHED_SESSIONS as an LRU across sessions. Both
// are now free to evict whatever they like — the daemon refills it.

import type { JsonRpcFrame } from "./acp.js";
import { timed } from "./perf.js";

const DB_NAME = "hydra-acp-history-cache";
// Frozen at 4. Earlier bumps existed to discard caches holding transcripts
// that could never repair themselves, which was only possible while the
// cache drove the replay cursor. It no longer does, so a bad entry is
// self-healing on the next open and there is nothing left for a bump to
// fix.
const DB_VERSION = 4;
const STORE = "sessions";
// 6MB holds several screenshot-bearing turns plus a long text
// transcript; 10 sessions caps the whole store around 60MB, well inside
// a normal IndexedDB origin quota.
//
// Briefly cut to 1.5MB on a theory that the flush's structured clone was
// blocking the main thread on mobile. On-device timing disproved it --
// no cache-* operation registered above 120ms -- so the cap is back
// where it belongs.
const MAX_BYTES_PER_SESSION = 6_000_000;
const MAX_CACHED_SESSIONS = 10;
const FLUSH_DEBOUNCE_MS = 2000;

interface CachedFrame {
  frame: JsonRpcFrame;
  bytes: number;
}

interface CachedSession {
  sessionId: string;
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

// Read a session's cached transcript and bump its LRU timestamp. Returns
// null on a cache miss or any storage failure — always safe to treat the
// same as "nothing cached".
export async function loadCachedSession(
  sessionId: string,
): Promise<{ frames: JsonRpcFrame[] } | null> {
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
      // A throw here (e.g. Safari's synchronous QuotaExceededError) must
      // not skip resolve() below — see mergeAndTrim's identical guard for
      // why an unresolved promise here is far worse than a stale LRU
      // timestamp.
      try {
        store.put(rec);
      } catch (err) {
        console.error("[hydra] history-cache LRU bump failed", err);
      }
      resolve({
        frames: timed("cache-read-map", () => rec.frames.map((f) => f.frame)),
      });
    };
    req.onerror = () => resolve(null);
  });
}

// Local copy of acp.ts's extractRecordedAt — importing it here would be
// circular (acp.ts already imports queueFrameForCache from this file).
function extractRecordedAt(frame: JsonRpcFrame): number | undefined {
  const meta = (frame.params as { _meta?: unknown } | undefined)?._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const inner = (meta as Record<string, unknown>)["hydra-acp"];
  if (!inner || typeof inner !== "object") return undefined;
  const at = (inner as { recordedAt?: unknown }).recordedAt;
  return typeof at === "number" && Number.isFinite(at) ? at : undefined;
}

function formatAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

// Diagnostic: what does this client's cache ACTUALLY hold for a session?
// The whole transcript-corruption hunt kept stalling on the difference
// between what the cache was assumed to contain and what it did, which
// is invisible on a phone with no inspector. The newest-frame age is the
// single most direct way to tell "cache is stale" from "cache is fine,
// something else is wrong" without an inspector.
export async function describeCachedSession(sessionId: string): Promise<string> {
  const db = await openDb();
  if (!db) return "unavailable";
  return new Promise((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, "readonly");
    } catch {
      resolve("unreadable");
      return;
    }
    const req = tx.objectStore(STORE).get(sessionId);
    req.onsuccess = () => {
      const rec = req.result as CachedSession | undefined;
      if (!rec) {
        resolve("empty");
        return;
      }
      const kinds = new Map<string, number>();
      for (const f of rec.frames) {
        const u = (f.frame.params as { update?: { sessionUpdate?: unknown } } | undefined)?.update;
        const k = typeof u?.sessionUpdate === "string" ? u.sessionUpdate : "?";
        kinds.set(k, (kinds.get(k) ?? 0) + 1);
      }
      const top = [...kinds.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k.replace(/_chunk$/, "")}:${n}`)
        .join(" ");
      let newest: number | undefined;
      for (const f of rec.frames) {
        const at = extractRecordedAt(f.frame);
        if (at !== undefined && (newest === undefined || at > newest)) newest = at;
      }
      const age = newest !== undefined ? formatAge(Date.now() - newest) : "unknown";
      resolve(`${rec.frames.length}f ${(rec.totalBytes / 1e6).toFixed(1)}MB newest:${age} — ${top}`);
    };
    req.onerror = () => resolve("unreadable");
  });
}

// In-memory buffer of not-yet-flushed frames per session, so a burst of
// chunks during an active turn costs one debounced write instead of one
// IndexedDB round trip per frame.
const pendingFrames = new Map<string, JsonRpcFrame[]>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

// Sessions whose next flush must REPLACE the stored record instead of
// appending to it. See resetCachedSession.
const replaceOnNextFlush = new Set<string>();

// Called when a full session/attach replay is about to rebuild the
// transcript from scratch (bridge.ts's bridge/replay_policy, alongside
// acp.ts's resetChatHistoryState). The cache exists to repaint that
// transcript on the next cold open, so it has to follow the same
// lifecycle the transcript does.
//
// Without this the cache is append-only, and every cold open appends a
// fresh replay of the same recent turns onto everything already stored.
// It never converges on "what you last saw": it accumulates overlapping
// copies of the same turns, and since prompts dedupe by messageId on
// replay but streamed chunks cannot, the repeats land as extra text on
// existing bubbles rather than as clean duplicates. The paint that
// results is a pile of every replay this client has ever seen, with the
// newest turns merely appended to the end of it.
//
// Deliberately a flag rather than an eager delete: the replay's own
// frames start arriving immediately after this is called, and an async
// delete racing the flush that stores them would drop the very content
// it was meant to make room for. Consumed by mergeAndTrim on the first
// flush after the reset, which is exactly the batch carrying the replay.
export function resetCachedSession(sessionId: string): void {
  pendingFrames.delete(sessionId);
  replaceOnNextFlush.add(sessionId);
}

// Called from acp.ts's handleNotification for every recordable
// session/update arriving from the daemon (never for one replayed out of
// this cache). It fires on every streamed agent_message_chunk during an
// active turn, so it has to stay cheap: one Map write, nothing else. An earlier version computed byteSize(frame)
// (JSON.stringify + TextEncoder) right here, on the same main thread as
// keystroke handling, and was measurably competing with typing
// responsiveness during a fast-streaming reply. Sizing is deferred to
// mergeAndTrim, which only runs once per debounce window.
export function queueFrameForCache(
  sessionId: string,
  frame: JsonRpcFrame,
): void {
  const list = pendingFrames.get(sessionId) ?? [];
  list.push(frame);
  pendingFrames.set(sessionId, list);
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
// a whole batch of frames — flushPending clears the batch out of
// pendingFrames before awaiting the write, so it is not retried.
//
// Measured on a real session: a cache-hydrated transcript held 56
// prompts / 79 agent bubbles where a full replay of the same session
// gave 91 / 215, with the newest prompt missing entirely — losses the
// oldest-first byte trim cannot explain. That is merely a stale picture
// now rather than a corrupt transcript, since the full replay behind it
// corrects whatever was lost, but chaining serialises every
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
    return;
  }
  for (const sessionId of sessionIds) {
    const newFrames = pendingFrames.get(sessionId);
    pendingFrames.delete(sessionId);
    if (!newFrames) continue;
    await mergeAndTrim(db, sessionId, newFrames);
  }
  await enforceSessionLru(db);
}

function mergeAndTrim(
  db: IDBDatabase,
  sessionId: string,
  newFrames: JsonRpcFrame[],
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
      // A full replay just rebuilt the transcript, so this batch is the
      // authoritative picture of it — start from nothing rather than
      // layering it onto the previous one (see resetCachedSession).
      const replacing = replaceOnNextFlush.delete(sessionId);
      const existing = replacing
        ? undefined
        : (getReq.result as CachedSession | undefined);
      // Do NOT dedupe these by update.messageId. It reads like a
      // natural key but isn't unique per frame: some agents stamp their
      // own message id (Claude's msg_01…) on every chunk of one reply,
      // so all of that reply's chunks share it, and dropping repeats
      // keeps only the first chunk. That truncated every agent bubble
      // to a few characters on the next hydrate. Duplicate frames are
      // prevented at the source instead — handleNotification skips
      // caching anything replayed out of the cache (its fromCache
      // argument), which is what was appending a second copy of the
      // transcript on every session open.
      // Sizing happens here, once per debounce window, instead of per
      // frame at queue time — see queueFrameForCache.
      const sized: CachedFrame[] = timed("cache-size", () =>
        newFrames.map((frame) => ({ frame, bytes: byteSize(frame) })),
      );
      const frames = [...(existing?.frames ?? []), ...sized];
      let totalBytes =
        (existing?.totalBytes ?? 0) + sized.reduce((sum, f) => sum + f.bytes, 0);
      // Trim oldest-first until back under budget. A single oversized
      // frame (e.g. a huge tool-output blob) can still exceed the cap on
      // its own — that's fine, it just means this session temporarily
      // caches only itself rather than nothing.
      while (frames.length > 1 && totalBytes > MAX_BYTES_PER_SESSION) {
        const dropped = frames.shift();
        if (dropped) totalBytes -= dropped.bytes;
      }
      // Then keep dropping until the cache opens on a turn boundary. A
      // byte cut lands mid-turn nearly every time, and a hydrate that
      // starts there paints agent output whose prompt_received was
      // trimmed away: a turn with no prompt above it, which reads as a
      // prompt having gone missing. Same cut the daemon's replay makes
      // (cli's snapToTurnBoundary) and the same one views.ts already
      // snaps for its render window. Bounded by the byte cap that just
      // ran, and abandoned if no opener is found rather than emptying
      // the cache over it.
      const openerAt = frames.findIndex(
        (f) =>
          (f.frame.params as { update?: { sessionUpdate?: unknown } } | undefined)
            ?.update?.sessionUpdate === "prompt_received",
      );
      if (openerAt > 0) {
        for (const dropped of frames.splice(0, openerAt)) {
          totalBytes -= dropped.bytes;
        }
      }
      const rec: CachedSession = {
        sessionId,
        frames,
        totalBytes,
        lastAccessed: Date.now(),
      };
      // A synchronous throw out of store.put (Safari raises
      // QuotaExceededError this way, not as an async error event) must
      // still reach resolve(). Without this try/catch, that throw skips
      // resolve() and leaves this promise pending forever — flushPending
      // awaits it in a loop, and enqueueFlush chains every future flush
      // onto this one via flushChain, so one bad write permanently wedges
      // the entire cache (every session, until a page reload) with
      // nothing ever rejecting to surface an error.
      try {
        timed("cache-put", () => store.put(rec));
      } catch (err) {
        console.error("[hydra] history-cache write failed", err, { sessionId });
      }
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
      try {
        for (const rec of toEvict) {
          store.delete(rec.sessionId);
        }
      } catch (err) {
        console.error("[hydra] history-cache LRU eviction failed", err);
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
