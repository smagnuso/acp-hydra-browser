// ACP notification + agent-request handling. Owns the turn-lifecycle
// signal (inTurn) and tool-call/permission tracking. Stays free of WS
// plumbing — that lives in bridge.ts.

import { state } from "./state.js";
import { contentToText } from "./markdown.js";
import type { LogItem, PlanLogItem, ToolCallState } from "./types.js";

type AnyRecord = Record<string, unknown>;

export function pushLog(item: LogItem): void {
  if (!state.current) return;
  state.current.log.push(item);
}

// ---- inTurn signal ------------------------------------------------

export function markActive(): void {
  if (!state.current) return;
  state.current.inTurn = true;
}

export function markIdleAndDrain(): void {
  if (!state.current) return;
  state.current.inTurn = false;
  const listeners = state.current.idleListeners;
  state.current.idleListeners = [];
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* listener errors don't block other listeners */
    }
  }
}

// Wait for the next idle transition. Resolves immediately if already
// idle. (Used by the prompt queue chain — see queue.ts.)
export function waitForIdle(): Promise<void> {
  if (!state.current || !state.current.inTurn) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    state.current!.idleListeners.push(resolve);
  });
}

// ---- Streaming chunks --------------------------------------------

export function pushChunk(role: "user" | "agent" | "thought", content: unknown): void {
  if (!state.current) return;
  const text = contentToText(content);
  if (!text) return;
  // Find the most recent non-spinner log entry. The spinner is a
  // transient marker that sits between bubbles; it shouldn't break
  // streaming-chunk merging into the open bubble below it. Without
  // this skip, every chunk after the spinner created its own bubble
  // (which split words at arbitrary chunk boundaries when copied).
  let last: LogItem | undefined;
  for (let i = state.current.log.length - 1; i >= 0; i--) {
    const e = state.current.log[i]!;
    if (e.kind !== "spinner") {
      last = e;
      break;
    }
  }
  if (last && last.kind === "stream" && last.role === role && !last.closed) {
    last.text += text;
    return;
  }
  state.current.log.push({ kind: "stream", role, text });
}

// Mark the most recent stream entry as closed so a subsequent chunk
// of the same role starts a fresh bubble rather than appending. Called
// at every natural boundary: a tool call begins, a turn ends, etc. —
// the same places acp-hydra-slack calls closeAgentMessage().
export function closeOpenStream(): void {
  if (!state.current) return;
  for (let i = state.current.log.length - 1; i >= 0; i--) {
    const e = state.current.log[i]!;
    if (e.kind === "stream") {
      e.closed = true;
      return;
    }
  }
}

// Returns true if `content` matches (and consumes) a recently-sent own
// prompt. The echo from hydra arrives as user_message_chunk shaped like
// the original prompt; we strip it from the queue so a real third-party
// user message (sent from another attached client) still renders.
export function consumeOwnPromptEcho(content: unknown): boolean {
  if (!state.current) return false;
  const text = contentToText(content);
  if (!text) return false;
  const list = state.current.recentOwnPrompts;
  for (let i = 0; i < list.length; i++) {
    if (list[i]!.text === text) {
      list.splice(i, 1);
      return true;
    }
  }
  return false;
}

// ---- Tool calls & spinner ----------------------------------------

function extractToolContent(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(extractToolContent).join("");
  if (typeof content === "object") {
    const c = content as AnyRecord;
    if (c.text) return String(c.text);
    if (c.content) return extractToolContent(c.content);
    if (c.diff) return String(c.diff);
    try {
      return JSON.stringify(content, null, 2);
    } catch {
      return String(content);
    }
  }
  return "";
}

// Make sure a spinner item is present in the log. Doesn't move an
// existing spinner — it stays where it was first posted, matching
// slack's behavior of refreshing the same thread message in place.
// Moving it broke streaming because pushChunk then saw the spinner as
// the most recent entry and refused to merge new chunks into the
// open agent bubble below it. (pushChunk now skips spinners when
// looking for the merge target.)
export function ensureSpinner(): void {
  if (!state.current) return;
  const c = state.current;
  if (c.spinner) {
    // Defensive: if the spinner state object exists but no log entry
    // refers to it, re-push so renderLogItem can find it.
    if (!c.log.some((e) => e.kind === "spinner")) {
      c.log.push({ kind: "spinner", spinner: c.spinner });
    }
    return;
  }
  c.spinner = { toolCallIds: [], expanded: false };
  c.log.push({ kind: "spinner", spinner: c.spinner });
}

function onToolCall(update: AnyRecord): void {
  if (!state.current) return;
  // Close any streaming agent message before this tool so the next
  // agent chunk after the tool starts a fresh bubble — same pattern
  // acp-hydra-slack uses with closeAgentMessage.
  closeOpenStream();
  const tc: ToolCallState = {
    toolCallId: String(update.toolCallId),
    title: String(update.title ?? update.kind ?? "tool"),
    kind: String(update.kind ?? ""),
    status: String(update.status ?? "in_progress"),
    content: extractToolContent(update.content),
  };
  state.current.toolCalls.set(tc.toolCallId, tc);
  ensureSpinner();
  state.current.spinner!.toolCallIds.push(tc.toolCallId);
}

function onToolCallUpdate(update: AnyRecord): void {
  if (!state.current) return;
  const existing = state.current.toolCalls.get(String(update.toolCallId));
  if (!existing) return;
  if (typeof update.status === "string") existing.status = update.status;
  if (typeof update.title === "string") existing.title = update.title;
  if (update.content !== undefined) {
    existing.content =
      (existing.content || "") + extractToolContent(update.content);
  }
}

// ---- Turn boundaries ---------------------------------------------

export function finalizeTurn(): void {
  if (!state.current) return;
  // Drop the spinner entry; the tool call records remain in state but
  // are no longer rendered as a clutter list.
  state.current.spinner = null;
  state.current.log = state.current.log.filter((e) => e.kind !== "spinner");
  // Close the streaming agent message so the next turn starts a
  // fresh bubble even if the agent immediately resumes streaming.
  closeOpenStream();
  // Forget the active-turn plan card — the next plan update should
  // push a fresh card rather than mutating last turn's into oblivion.
  state.current.currentPlanEntry = null;
  // The agent is between turns now — wake any sendOurPrompt awaiting
  // a turn boundary, plus toggle the inTurn flag so the next
  // waitForIdle short-circuits if no turn comes back to life.
  markIdleAndDrain();
}

// ---- Sibling-driven user / plan / permission updates ------------

function onPromptReceived(update: AnyRecord): void {
  if (!state.current) return;
  const blocks = Array.isArray(update.prompt) ? update.prompt : [];
  const text = blocks.map((b) => contentToText(b)).join("");
  if (!text) return;
  if (consumeOwnPromptEcho({ text })) {
    return;
  }
  // Sibling prompt — push as a fresh closed bubble. closeOpenStream
  // first so any in-flight agent stream is broken.
  closeOpenStream();
  state.current.log.push({
    kind: "stream",
    role: "user",
    text,
    closed: true,
  });
}

function onPlanUpdate(update: AnyRecord): void {
  if (!state.current) return;
  const entries = (update.entries ?? update.plan ?? null) as unknown;
  state.current.plan = entries;
  // Track the active-turn plan card via a pointer so subsequent
  // updates mutate it in place instead of pushing duplicates. The
  // pointer is cleared at finalizeTurn so the next turn starts a
  // fresh card. Scanning the log for a plan entry doesn't work here
  // because the spinner moves around in the log and confuses the
  // search — see the comment in ensureSpinner.
  if (state.current.currentPlanEntry) {
    state.current.currentPlanEntry.entries = entries;
    return;
  }
  const item: PlanLogItem = { kind: "plan", entries };
  state.current.log.push(item);
  state.current.currentPlanEntry = item;
}

// Sibling client (slack, editor, …) answered a permission request
// first. Tear down our (now-stale) prompt card. Idempotent: if we
// don't have an entry for the requestId, no-op.
function onPermissionResolved(params: AnyRecord | undefined): void {
  if (!state.current) return;
  const requestId = params?.requestId;
  if (requestId === undefined) return;
  const idKey = String(requestId);
  state.current.pendingPermissions.delete(idKey);
  state.current.log = state.current.log.filter(
    (e) => !(e.kind === "perm" && String(e.requestId) === idKey),
  );
}

// ---- Notification dispatcher ------------------------------------

interface JsonRpcFrame {
  method?: string;
  params?: AnyRecord;
  id?: number | string;
  result?: unknown;
  error?: unknown;
}

export function handleNotification(frame: JsonRpcFrame): void {
  // Sibling-resolved permission tear-down. Lives outside the
  // session/update gate because it's a transient signal, not session
  // activity.
  if (frame.method === "session/permission_resolved") {
    onPermissionResolved(frame.params);
    return;
  }
  if (frame.method !== "session/update") return;
  const update = (frame.params?.update ?? null) as AnyRecord | null;
  if (!update || typeof update !== "object") return;
  const kind = String(update.sessionUpdate ?? "");
  // Most update kinds indicate the agent is mid-turn. Mode/model/usage
  // updates can fire outside of a turn (e.g. at attach), so we don't
  // flip inTurn for those.
  switch (kind) {
    case "prompt_received":
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "tool_call":
    case "tool_call_update":
    case "plan":
      markActive();
      break;
    default:
      break;
  }
  switch (kind) {
    case "user_message_chunk": {
      // Hydra emits a marked user_message_chunk alongside prompt_received
      // for backwards compat. We render the sibling-client path via
      // prompt_received, so drop the compat copy. (Same handling
      // acp-hydra-slack uses.)
      const meta = (update._meta ?? {}) as AnyRecord;
      const hydraMeta = (meta["acp-hydra"] ?? {}) as AnyRecord;
      if (hydraMeta.compatFor === "prompt_received") {
        break;
      }
      // Streaming user message from a sibling that *isn't* using
      // prompt_received yet. Suppress own-echo via recentOwnPrompts.
      if (!consumeOwnPromptEcho(update.content)) {
        pushChunk("user", update.content);
      }
      break;
    }
    case "agent_message_chunk":
      pushChunk("agent", update.content);
      break;
    case "agent_thought_chunk":
      pushChunk("thought", update.content);
      break;
    case "tool_call":
      onToolCall(update);
      break;
    case "tool_call_update":
      onToolCallUpdate(update);
      break;
    case "current_mode_update":
      if (state.current) {
        state.current.mode = (update.modeId ?? update.currentModeId ?? null) as string | null;
        if (Array.isArray(update.availableModes)) {
          state.current.modes = update.availableModes as never;
        }
      }
      break;
    case "current_model_update":
      if (state.current) {
        state.current.model = (update.modelId ?? update.currentModelId ?? null) as string | null;
        if (Array.isArray(update.availableModels)) {
          state.current.models = update.availableModels as never;
        }
      }
      break;
    case "usage_update":
      if (state.current) {
        // Wire shape (per acp-hydra-slack's session.ts:583): { used,
        // size, cost: { amount, currency } }. Accept the alternate
        // contextUsed/contextSize names too in case any agent uses
        // them.
        const used = (update.used ?? update.contextUsed) as unknown;
        const size = (update.size ?? update.contextSize) as unknown;
        if (typeof used === "number") state.current.contextUsed = used;
        if (typeof size === "number") state.current.contextSize = size;
        if (update.cost) state.current.cost = update.cost;
      }
      break;
    case "plan":
      onPlanUpdate(update);
      break;
    case "prompt_received":
      onPromptReceived(update);
      break;
    case "stop":
    case "turn_complete":
      finalizeTurn();
      break;
    default:
      // Unknown but harmless; ignore.
      break;
  }
  // After per-case dispatch, surface a "still working" spinner if the
  // turn is active. ensureSpinner pins it to the end of the log so it
  // sits beneath whatever bubble we just added (user prompt mirror,
  // agent stream, etc.). finalizeTurn drops it at the end of the turn.
  if (state.current?.inTurn) {
    ensureSpinner();
  }
}

// ---- Agent-initiated requests (permission asks, etc.) ----------

export function handleAgentRequest(req: JsonRpcFrame): void {
  if (!state.current) return;
  if (req.method === "session/request_permission") {
    const params = (req.params ?? {}) as AnyRecord;
    // Key by stringified id since hydra forwards permission_resolved
    // with requestId as a string (and our id may be a number). Storing
    // here under String() means the resolved-by-sibling cleanup matches
    // reliably.
    const idKey = String(req.id);
    state.current.pendingPermissions.set(idKey, {
      requestId: req.id as string | number,
      toolCall: (params.toolCall as never) ?? {},
      options: (params.options as never) ?? [],
    });
    pushLog({ kind: "perm", requestId: idKey });
    return;
  }
  // Unknown agent request — reply with method-not-found so we don't
  // hold the agent up.
  state.current.ws?.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32601, message: `method not handled: ${String(req.method)}` },
    }),
  );
}
