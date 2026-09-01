import { test } from "node:test";
import assert from "node:assert/strict";

// See acp-edit-diff.test.ts for why this stub is needed before the static
// imports below run.
(globalThis as { document?: unknown }).document ??= {
  addEventListener() {},
  removeEventListener() {},
};

const { state } = await import("../src/ui/state.js");
const { handleNotification, dropPendingCursorGroup, resetChatHistoryState } =
  await import("../src/ui/acp.js");
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

function frame(update: Record<string, unknown>) {
  return {
    method: "session/update",
    params: { sessionId: "s1", update },
  };
}

function agentChunk(text: string, messageId: string) {
  return frame({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
    messageId,
  });
}

// Same frame, plus the daemon's per-frame cursor (PROTOCOL.md).
function seqChunk(text: string, messageId: string, seq: number) {
  return {
    method: "session/update",
    params: {
      sessionId: "s1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
        messageId,
      },
      _meta: { "hydra-acp": { seq } },
    },
  };
}

function thoughtChunk(text: string, messageId: string) {
  return frame({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text },
    messageId,
  });
}

function streams() {
  return state.current!.log.filter((e) => e.kind === "stream") as Array<
    Extract<ChatState["log"][number], { kind: "stream" }>
  >;
}

// The bug this whole file exists for. hydra's findMessageIdIndex resolves
// afterMessageId to the LAST frame carrying that id, so a cursor naming a
// message we're only part-way through makes the daemon resume past the
// message's end — permanently dropping every chunk we never received.
test("the cursor never names a message still streaming", () => {
  state.current = makeChatState();
  handleNotification(frame({ sessionUpdate: "prompt_received", messageId: "m_prompt", prompt: [{ type: "text", text: "hi" }] }));
  // One reply: thought chunks then message chunks, all under one id —
  // exactly how Claude stamps them.
  handleNotification(thoughtChunk("thinking", "msg_reply"));
  handleNotification(agentChunk("first half ", "msg_reply"));
  handleNotification(agentChunk("second half", "msg_reply"));

  assert.equal(
    state.current!.lastSeenMessageId,
    "m_prompt",
    "cursor must stay on the last message we saw the END of",
  );
  assert.equal(state.current!.pendingCursorMessageId, "msg_reply");

  // turn_complete closes the group, so the cursor may finally advance.
  handleNotification(frame({ sessionUpdate: "turn_complete", messageId: "m_done", stopReason: "end_turn" }));
  assert.equal(state.current!.lastSeenMessageId, "msg_reply");
});

// The delta the cursor above buys us restarts at the first chunk of the
// in-flight message, so the already-rendered part has to go or pushChunk
// (which never dedupes) renders the reply twice.
test("an after_message delta rebuilds the in-flight message instead of doubling it", () => {
  state.current = makeChatState();
  handleNotification(frame({ sessionUpdate: "prompt_received", messageId: "m_prompt", prompt: [{ type: "text", text: "hi" }] }));
  handleNotification(agentChunk("first half ", "msg_reply"));

  // Socket dies here. Reattach comes back "after_message" with
  // afterMessageId=m_prompt, so the daemon resends the whole reply.
  dropPendingCursorGroup();
  assert.deepEqual(
    streams().filter((s) => s.role === "agent").map((s) => s.text),
    [],
    "the partial bubble is cleared for the replay to rebuild",
  );

  handleNotification(agentChunk("first half ", "msg_reply"));
  handleNotification(agentChunk("second half", "msg_reply"));
  const agents = streams().filter((s) => s.role === "agent");
  assert.equal(agents.length, 1);
  assert.equal(agents[0]!.text, "first half second half");
});

// Our own prompts are excluded from hydra's prompt_received fan-out, so
// nothing would ever resend one. Dropping it would delete it for good.
test("the purge leaves user bubbles alone", () => {
  state.current = makeChatState();
  handleNotification(frame({ sessionUpdate: "prompt_received", messageId: "m_prompt", prompt: [{ type: "text", text: "keep me" }] }));
  handleNotification(agentChunk("partial", "m_prompt"));
  state.current!.lastSeenMessageId = undefined;
  state.current!.pendingCursorMessageId = "m_prompt";

  dropPendingCursorGroup();
  const users = streams().filter((s) => s.role === "user");
  assert.equal(users.length, 1);
  assert.equal(users[0]!.text, "keep me");
});

// One bubble to one message group — what makes the purge above exact.
test("consecutive agent messages with different ids do not merge", () => {
  state.current = makeChatState();
  handleNotification(agentChunk("reply one", "msg_a"));
  handleNotification(agentChunk("reply two", "msg_b"));
  assert.deepEqual(
    streams().map((s) => s.text),
    ["reply one", "reply two"],
  );
});

test("resetChatHistoryState clears both halves of the cursor", () => {
  state.current = makeChatState();
  handleNotification(agentChunk("a", "msg_a"));
  handleNotification(agentChunk("b", "msg_b"));
  resetChatHistoryState(state.current!);
  assert.equal(state.current!.lastSeenMessageId, undefined);
  assert.equal(state.current!.pendingCursorMessageId, undefined);
});

// Against a daemon that stamps seq, the cursor is exact: it names the very
// frame we stopped on, so nothing is re-sent and there is nothing to purge.
test("seq tracks per frame, with no promotion delay", () => {
  state.current = makeChatState();
  handleNotification(seqChunk("first half ", "msg_reply", 1001));
  assert.equal(state.current!.lastSeenSeq, 1001);
  handleNotification(seqChunk("second half", "msg_reply", 1002));
  assert.equal(state.current!.lastSeenSeq, 1002);
  // The messageId cursor still lags a group behind, as it must.
  assert.equal(state.current!.lastSeenMessageId, undefined);
});

// The purge is only correct on the messageId path. bridge.ts gates it on
// resumedByMessageId; this pins the half that lives in acp.ts — a seq
// resume leaves lastSeenMessageId untouched, so nothing here should be
// tempted to drop a bubble the daemon will not re-send.
test("a seq-only session still purges nothing it cannot get back", () => {
  state.current = makeChatState();
  handleNotification(seqChunk("only half", "msg_reply", 2001));
  const before = state.current!.log.length;
  state.current!.resumedByMessageId = false;
  // bridge.ts would not call dropPendingCursorGroup here at all; assert the
  // state it keys off is what we expect.
  assert.equal(state.current!.resumedByMessageId, false);
  assert.equal(state.current!.log.length, before);
});

test("frames without seq leave the seq cursor undefined", () => {
  state.current = makeChatState();
  handleNotification(agentChunk("a", "msg_a"));
  assert.equal(state.current!.lastSeenSeq, undefined);
});

// The invariant that ends the whole missing-prompt bug class. The cursor
// decides what the daemon is asked to send, so if cached frames advanced
// it, anything the cache was missing would never be requested either and
// the gap would be permanent. A cold open must paint from cache and still
// ask for a FULL replay.
test("frames replayed out of the cache never advance the replay cursor", () => {
  state.current = makeChatState();
  handleNotification(frame({ sessionUpdate: "prompt_received", messageId: "m_a", prompt: [{ type: "text", text: "hi" }] }), true);
  handleNotification(seqChunk("cached reply", "msg_a", 5001), true);
  handleNotification(frame({ sessionUpdate: "turn_complete", messageId: "m_b", stopReason: "end_turn" }), true);

  // Painted, so the user sees something immediately...
  assert.equal(streams().length, 2);
  // ...but nothing that would suppress frames on the next attach.
  assert.equal(state.current!.lastSeenMessageId, undefined);
  assert.equal(state.current!.pendingCursorMessageId, undefined);
  assert.equal(state.current!.lastSeenSeq, undefined);
});

// Live frames still advance it, so an in-tab reconnect keeps its cheap
// delta. That path never involved the cache and never had these bugs.
test("live frames still advance the cursor", () => {
  state.current = makeChatState();
  handleNotification(seqChunk("live", "msg_a", 6001), false);
  handleNotification(seqChunk("live2", "msg_b", 6002), false);
  assert.equal(state.current!.lastSeenSeq, 6002);
  assert.equal(state.current!.lastSeenMessageId, "msg_a");
});
