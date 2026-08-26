// Reproduces the history-cache round-trip offline: take a session's real
// recorded frames, put them through the same byte-cap trim the cache
// applies, then replay only the survivors through the real
// handleNotification. Answers "what does a cache-hydrated transcript
// actually look like" without a phone or a reload.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

(globalThis as { document?: unknown }).document ??= {
  addEventListener() {}, removeEventListener() {},
};
(globalThis as { window?: unknown }).window ??= {
  addEventListener() {}, removeEventListener() {},
};
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame ??= (f: () => void) => setTimeout(f, 0);

const { state } = await import("../src/ui/state.js");
const { handleNotification } = await import("../src/ui/acp.js");
import type { ChatState } from "../src/ui/types.js";

const MAX_BYTES = 6_000_000;
const STATE_KINDS = new Set([
  "session_info_update", "current_model_update", "current_mode_update",
  "available_commands_update", "available_modes_update", "usage_update",
]);

function blank(sessionId: string): ChatState {
  return {
    sessionId, title: "", cwd: "", agentId: "", ws: null, ready: false, log: [],
    toolCalls: new Map(), pendingPermissions: new Map(), pendingRequestById: new Map(),
    responseHandlers: new Map(), spinner: null, plan: null, mode: null, model: null,
    modes: [], models: [], contextUsed: null, contextSize: null, cost: null,
    fileOverlay: null, composerValue: "", busy: false, recentOwnPrompts: [],
    history: [], historyIndex: null, historyDraft: null, _lastMetaFp: "",
    promptQueue: [], queueByMessageId: new Map(), ownPromptIds: new Map(),
    inTurn: false, idleListeners: [], readyListeners: [], currentPlanEntry: null,
    daemonSupportsAmend: false, headerExpanded: false, unsolicitedTurnOpen: new Set(),
  } as unknown as ChatState;
}

const sessionId = process.argv[2]!;
const path = join(homedir(), ".hydra-acp", "sessions", sessionId, "history.jsonl");
const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);

// Build wire frames exactly as the bridge would deliver them.
const frames: { frame: unknown; bytes: number; kind: string }[] = [];
for (const line of lines) {
  let e: { method?: string; params?: Record<string, unknown>; recordedAt?: number };
  try { e = JSON.parse(line); } catch { continue; }
  if (!e.method || !e.params) continue;
  const params = { ...e.params } as Record<string, unknown>;
  if (typeof e.recordedAt === "number") {
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    const hy = (meta["hydra-acp"] ?? {}) as Record<string, unknown>;
    params._meta = { ...meta, "hydra-acp": { ...hy, recordedAt: e.recordedAt } };
  }
  const u = (params.update ?? {}) as { sessionUpdate?: string; messageId?: unknown };
  const kind = u.sessionUpdate ?? "";
  const frame = { method: e.method, params };
  // Same gate as acp.ts: only recordable updates with a messageId cache.
  if (!kind || STATE_KINDS.has(kind) || typeof u.messageId !== "string") continue;
  frames.push({ frame, bytes: Buffer.byteLength(JSON.stringify(frame)), kind });
}

const total = frames.reduce((n, f) => n + f.bytes, 0);
console.log(`cacheable frames: ${frames.length}, total ${(total / 1e6).toFixed(1)}MB, cap ${(MAX_BYTES / 1e6)}MB`);

// The trim, verbatim from mergeAndTrim.
const kept = [...frames];
let bytes = total;
while (kept.length > 1 && bytes > MAX_BYTES) {
  const d = kept.shift()!;
  bytes -= d.bytes;
}
const dropped = frames.length - kept.length;
console.log(`trim kept ${kept.length} frames (${(bytes / 1e6).toFixed(1)}MB), dropped ${dropped} oldest`);
const byKind = new Map<string, number>();
for (const f of kept) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
console.log("surviving frames by kind:", JSON.stringify(Object.fromEntries(byKind)));

state.current = blank(sessionId);
for (const f of kept) {
  try { handleNotification(f.frame as never); } catch { /* counted elsewhere */ }
}
const items = new Map<string, number>();
for (const it of state.current!.log) {
  const k = it.kind === "stream" ? `stream:${(it as { role: string }).role}` : it.kind;
  items.set(k, (items.get(k) ?? 0) + 1);
}
console.log("hydrated log:", JSON.stringify(Object.fromEntries(items)), "len", state.current!.log.length);

// Only the last CHAT_LOG_RENDER_WINDOW items are rendered, and thought
// bubbles are dropped at render time when hideThoughts is on -- but they
// still consume slots in that window. Show what actually reaches screen.
const WINDOW = 200;
const log = state.current!.log;
const win = log.length > WINDOW ? log.slice(log.length - WINDOW) : log;
const visible = win.filter((it) => !(it.kind === "stream" && (it as { role: string }).role === "thought"));
const vis = new Map<string, number>();
for (const it of visible) {
  const k = it.kind === "stream" ? `stream:${(it as { role: string }).role}` : it.kind;
  vis.set(k, (vis.get(k) ?? 0) + 1);
}
console.log(`\nrender window = last ${win.length} items; with thoughts hidden ${visible.length} reach screen`);
console.log("what the user sees:", JSON.stringify(Object.fromEntries(vis)));
