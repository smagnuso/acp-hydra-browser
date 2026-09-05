import { test } from "node:test";
import assert from "node:assert/strict";

// See acp-edit-diff.test.ts for why this stub is needed before the static
// imports below run.
(globalThis as { document?: unknown }).document ??= {
  addEventListener() {},
  removeEventListener() {},
};

const { state } = await import("../src/ui/state.js");
const { handleNotification } = await import("../src/ui/acp.js");
import type { ChatState } from "../src/ui/types.js";

// Minimal valid ChatState, matching the shape routing.ts's openChat builds.
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

function frame(update: Record<string, unknown>) {
  return {
    method: "session/update",
    params: { sessionId: "s1", update },
  };
}

function agentChunk(text: string) {
  return frame({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  });
}

function streamBubbles() {
  return state.current!.log.filter((e) => e.kind === "stream");
}

test("a top-level tool_call still closes the open agent bubble", () => {
  state.current = makeChatState();
  handleNotification(agentChunk("first half"));
  handleNotification(
    frame({
      sessionUpdate: "tool_call",
      toolCallId: "tc1",
      title: "Run tests",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "npm test" },
    }),
  );
  handleNotification(agentChunk("second half"));
  const bubbles = streamBubbles();
  assert.equal(bubbles.length, 2, "top-level tool call should split the reply");
  assert.equal(bubbles[0]!.text, "first half");
  assert.equal(bubbles[1]!.text, "second half");
});

test("a background subagent's tool call does not split the reply", () => {
  state.current = makeChatState();
  handleNotification(agentChunk("budget-r"));
  handleNotification(
    frame({
      sessionUpdate: "tool_call",
      toolCallId: "tc2",
      title: "Find Milo-related files",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "find . -iname '*milo*'" },
      _meta: { claudeCode: { parentToolUseId: "toolu_parent1" } },
    }),
  );
  handleNotification(agentChunk("ejection path gap"));
  const bubbles = streamBubbles();
  assert.equal(
    bubbles.length,
    1,
    "a subagent's own tool call should not close the foreground bubble",
  );
  assert.equal(bubbles[0]!.text, "budget-rejection path gap");
  // The subagent's tool call still renders — it's just not treated as an
  // interruption of the foreground text.
  assert.equal(state.current!.toolCalls.has("tc2"), true);
});
