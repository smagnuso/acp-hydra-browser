import { test } from "node:test";
import assert from "node:assert/strict";

// renderer.ts registers real pointerdown/pointerup listeners at module load
// (to defer render() while a button is physically held down) so importing
// acp.ts transitively needs a `document`. tool_call/tool_call_update
// notifications never call render() themselves, so a no-op stub is enough —
// no jsdom required. Must be set up before the static imports below run.
(globalThis as { document?: unknown }).document ??= {
  addEventListener() {},
  removeEventListener() {},
};

const { state } = await import("../src/ui/state.js");
const { finalizeTurn, handleNotification } = await import("../src/ui/acp.js");
import type { ChatState, EditDiffLogItem } from "../src/ui/types.js";

// Minimal valid ChatState, matching the shape routing.ts's openChat builds.
// tool_call/tool_call_update notifications never call render() themselves,
// so this is safe to exercise without a full DOM.
function makeChatState(): ChatState {
  return {
    sessionId: "s1",
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
    savedFileView: null,
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
  };
}

function toolCallFrame(update: Record<string, unknown>) {
  return {
    method: "session/update",
    params: { sessionId: "s1", update },
  };
}

function editDiffItems(): EditDiffLogItem[] {
  return state.current!.log.filter(
    (e): e is EditDiffLogItem => e.kind === "edit-diff",
  );
}

test("a tool_call carrying a diff pushes a persistent edit-diff block", () => {
  state.current = makeChatState();
  handleNotification(
    toolCallFrame({
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Edit",
      status: "in_progress",
      rawInput: { file_path: "src/a.ts", old_string: "foo", new_string: "bar" },
    }),
  );
  const items = editDiffItems();
  assert.equal(items.length, 1);
  assert.equal(items[0]!.toolCallId, "tc1");
  assert.equal(items[0]!.diff.path, "src/a.ts");
  assert.equal(items[0]!.expanded, false);
  // Bypasses the generic tool-call/spinner tracking, same as ExitPlanMode.
  assert.equal(state.current!.toolCalls.has("tc1"), false);
});

test("a later tool_call_update amends the existing block instead of duplicating it", () => {
  state.current = makeChatState();
  handleNotification(
    toolCallFrame({
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      status: "in_progress",
      rawInput: { file_path: "src/a.ts", old_string: "foo", new_string: "bar" },
    }),
  );
  handleNotification(
    toolCallFrame({
      sessionUpdate: "tool_call_update",
      toolCallId: "tc1",
      status: "completed",
      rawInput: { file_path: "src/a.ts", old_string: "foo", new_string: "baz" },
    }),
  );
  const items = editDiffItems();
  assert.equal(items.length, 1, "should amend in place, not duplicate");
  assert.equal(items[0]!.diff.newText, "baz");
  assert.equal(items[0]!.status, "completed");
});

test("edit-diff blocks survive finalizeTurn, unlike the spinner", () => {
  state.current = makeChatState();
  handleNotification(
    toolCallFrame({
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      status: "completed",
      rawInput: { file_path: "src/a.ts", old_string: "foo", new_string: "bar" },
    }),
  );
  finalizeTurn();
  assert.equal(editDiffItems().length, 1);
  assert.ok(!state.current!.log.some((e) => e.kind === "spinner"));
});

test("a non-edit tool_call still goes through the generic spinner path", () => {
  state.current = makeChatState();
  handleNotification(
    toolCallFrame({
      sessionUpdate: "tool_call",
      toolCallId: "tc2",
      title: "Run tests",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "npm test" },
    }),
  );
  assert.equal(editDiffItems().length, 0);
  assert.equal(state.current!.toolCalls.has("tc2"), true);
});
