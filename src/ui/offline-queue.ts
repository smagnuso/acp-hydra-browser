// Persists prompts that couldn't be sent because the WS wasn't open at
// submit time (no network, daemon unreachable, app just launched cold),
// so they survive a reload or the app being fully closed and relaunched
// later — the point being to actually deliver them once connectivity
// comes back, not just to avoid losing the typed text. See queue.ts's
// "offline" QueueStatus for the in-memory/chip side of this.
//
// IndexedDB, not localStorage — an entry can carry image attachments
// (see composer-draft.ts's reasoning for the same tradeoff on drafts).
// No debouncing/batching (unlike history-cache.ts): a failed send is a
// rare event, not a hot path, so a write per occurrence is fine.

import type { Attachment } from "./types.js";

const DB_NAME = "hydra-acp-offline-queue";
const DB_VERSION = 1;
const STORE = "sessions";

export interface OfflineEntry {
  id: string;
  text: string;
  attachments?: Attachment[];
}

interface SessionRecord {
  sessionId: string;
  entries: OfflineEntry[];
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

// Read is uncached — called once per openChat(), not a hot path. Always
// safe to treat a failure the same as "nothing held".
export async function loadOfflineEntries(sessionId: string): Promise<OfflineEntry[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, "readonly");
    } catch {
      resolve([]);
      return;
    }
    const req = tx.objectStore(STORE).get(sessionId);
    req.onsuccess = () => {
      const rec = req.result as SessionRecord | undefined;
      resolve(rec?.entries ?? []);
    };
    req.onerror = () => resolve([]);
  });
}

export async function saveOfflineEntry(sessionId: string, entry: OfflineEntry): Promise<void> {
  const db = await openDb();
  if (!db) return;
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
      const rec = (getReq.result as SessionRecord | undefined) ?? { sessionId, entries: [] };
      // Upsert, so re-saving after an inline edit replaces the entry in
      // place (keeping its position in the send order) instead of
      // queueing a second copy of the same prompt.
      const idx = rec.entries.findIndex((e) => e.id === entry.id);
      if (idx >= 0) {
        rec.entries[idx] = entry;
      } else {
        rec.entries.push(entry);
      }
      store.put(rec);
      resolve();
    };
    getReq.onerror = () => resolve();
  });
}

// Called once an entry has either actually been handed to send() (see
// queue.ts's flushOfflineQueue) or the user explicitly discarded it —
// either way it no longer needs to survive a relaunch.
export async function removeOfflineEntry(sessionId: string, entryId: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
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
      const rec = getReq.result as SessionRecord | undefined;
      if (!rec) {
        resolve();
        return;
      }
      rec.entries = rec.entries.filter((e) => e.id !== entryId);
      if (rec.entries.length === 0) {
        store.delete(sessionId);
      } else {
        store.put(rec);
      }
      resolve();
    };
    getReq.onerror = () => resolve();
  });
}
