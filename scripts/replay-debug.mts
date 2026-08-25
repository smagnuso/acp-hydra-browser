// Offline replay harness for the transcript-corruption investigation.
//
// Feeds a daemon session's REAL recorded history (~/.hydra-acp/sessions/
// <id>/history.jsonl) through the actual client-side handleNotification,
// then prints the resulting log structure. Same code path a browser runs
// on a full replay, minus the browser — so a hypothesis can be tested in
// milliseconds against real frames instead of by reloading a phone and
// reading a console.
//
// Usage:
//   npx tsx scripts/replay-debug.mts <sessionId> [fromLine] [toLine]

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// renderer.ts registers pointer listeners at module load, so importing
// acp.ts transitively needs a document. Same no-op stub the existing
// acp-edit-diff test uses. Must run before the dynamic imports below.
(globalThis as { document?: unknown }).document ??= {
  addEventListener() {},
  removeEventListener() {},
};
// history-cache.ts registers pagehide/visibilitychange listeners at
// module load, so window needs the same no-op treatment as document.
(globalThis as { window?: unknown }).window ??= {
  addEventListener() {},
  removeEventListener() {},
};
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame ??= (
  fn: () => void,
) => setTimeout(fn, 0);
(globalThis as { indexedDB?: unknown }).indexedDB ??= undefined;

const { state } = await import("../src/ui/state.js");
const { handleNotification, replayDebugReport } = await import("../src/ui/acp.js");
import type { ChatState } from "../src/ui/types.js";

function makeChatState(sessionId: string): ChatState {
  return {
    sessionId,
    title: "",
    cwd: "",
    agentId: "",
    ws: null,
    ready: false,
    log: [],
    toolCalls: new Map(),
    pendingPermissions: new Map(),
    pendingRequestById: new Map(),
    responseHandlers: new Map(),
    spinner: null,
    plan: null,
    mode: null,
    model: null,
    modes: [],
    models: [],
    contextUsed: null,
    contextSize: null,
    cost: null,
    fileOverlay: null,
    composerValue: "",
    busy: false,
    recentOwnPrompts: [],
    history: [],
    historyIndex: null,
    historyDraft: null,
    _lastMetaFp: "",
    promptQueue: [],
    queueByMessageId: new Map(),
    ownPromptIds: new Set(),
    inTurn: false,
    idleListeners: [],
    readyListeners: [],
    currentPlanEntry: null,
    daemonSupportsAmend: false,
    headerExpanded: false,
    unsolicitedTurnOpen: false,
  } as unknown as ChatState;
}

const sessionId = process.argv[2];
if (!sessionId) {
  console.error("usage: replay-debug.mts <sessionId> [fromLine] [toLine]");
  process.exit(1);
}
const from = process.argv[3] ? Number(process.argv[3]) : 1;
const to = process.argv[4] ? Number(process.argv[4]) : Infinity;

const path = join(homedir(), ".hydra-acp", "sessions", sessionId, "history.jsonl");
const all = readFileSync(path, "utf8").split("\n").filter(Boolean);
const slice = all.slice(from - 1, to === Infinity ? undefined : to);

console.log(`replaying ${slice.length} frames from ${path} (lines ${from}..${to})`);

state.current = makeChatState(sessionId);

let throwCount = 0;
const throwKinds = new Map<string, number>();
const throwSamples: { line: number; frame: Record<string, unknown> }[] = [];

// The daemon stores each entry as {method, params, recordedAt} and moves
// recordedAt onto params._meta["hydra-acp"] for the wire — mirror that
// here so turn durations replay against the recorded clock, exactly as
// they would over a real socket.
for (const line of slice) {
  let entry: { method?: string; params?: Record<string, unknown>; recordedAt?: number };
  try {
    entry = JSON.parse(line);
  } catch {
    continue;
  }
  if (!entry.method || !entry.params) continue;
  const params = { ...entry.params } as Record<string, unknown>;
  if (typeof entry.recordedAt === "number") {
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    const hydra = (meta["hydra-acp"] ?? {}) as Record<string, unknown>;
    params._meta = {
      ...meta,
      "hydra-acp": { ...hydra, recordedAt: entry.recordedAt },
    };
  }
  try {
    handleNotification({ method: entry.method, params });
  } catch (err) {
    const u = (params.update ?? {}) as { sessionUpdate?: unknown };
    const kind = typeof u.sessionUpdate === "string" ? u.sessionUpdate : "(none)";
    const msg = (err as Error).message;
    throwCount += 1;
    const key = `${kind}: ${msg}`;
    throwKinds.set(key, (throwKinds.get(key) ?? 0) + 1);
    if (throwSamples.length < 3) {
      throwSamples.push({ line: from + slice.indexOf(line), frame: params });
    }
  }
}

console.log(`\n=== handleNotification threw on ${throwCount} frame(s) ===`);
for (const [k, n] of throwKinds) {
  console.log(`  ${n}x  ${k}`);
}
if (throwSamples.length > 0) {
  console.log("\nfirst offending frame:");
  console.log(JSON.stringify(throwSamples[0]!.frame, null, 2).slice(0, 1200));
}

console.log("\n=== frame accounting ===");
console.log(JSON.stringify(replayDebugReport(), null, 2));

console.log("\n=== resulting transcript structure ===");
const log = state.current!.log;
log.forEach((item, i) => {
  let desc: string;
  if (item.kind === "stream") {
    const text = (item as { text: string }).text.replace(/\s+/g, " ").slice(0, 70);
    desc = `stream/${(item as { role: string }).role}: ${text}`;
  } else if (item.kind === "turn-stamp") {
    const t = item as { elapsedMs: number; toolCount: number };
    desc = `TURN-STAMP elapsed=${t.elapsedMs}ms tools=${t.toolCount}`;
  } else if (item.kind === "spinner") {
    desc = "SPINNER (still live)";
  } else if (item.kind === "edit-diff") {
    desc = `edit-diff ${(item as { diff: { path: string } }).diff.path}`;
  } else {
    desc = item.kind;
  }
  console.log(`${String(i).padStart(4)} ${desc}`);
});
