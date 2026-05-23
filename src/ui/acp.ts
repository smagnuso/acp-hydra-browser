// ACP notification + agent-request handling. Owns the turn-lifecycle
// signal (inTurn) and tool-call/permission tracking. Stays free of WS
// plumbing — that lives in bridge.ts.

import { state } from "./state.js";
import { render } from "./renderer.js";
import { contentToText } from "./markdown.js";
import type {
  ExitPlanLogItem,
  LogItem,
  PermissionEntry,
  PlanLogItem,
  QueueEntry,
  ToolCallState,
} from "./types.js";

type AnyRecord = Record<string, unknown>;

export function pushLog(item: LogItem): void {
  if (!state.current) return;
  state.current.log.push(item);
}

// True for bubbles representing a prompt still waiting in the queue.
// "pending" is intentionally NOT included — that's the brief
// "submitted, not yet bound to a daemon position" state for the head
// of the queue; the bubble is about to become the active turn, so
// active-turn content should NOT be inserted above it.
function isWaitingQueuedBubble(item: LogItem): boolean {
  if (item.kind !== "stream" || item.role !== "user" || !item.queueEntry) {
    return false;
  }
  const s = item.queueEntry.status;
  return s === "queued" || s === "editing";
}

// Index of the first waiting-queued bubble, or log.length if none.
// Active-turn content (agent chunks, spinner, plan card, peer
// prompt_received bubbles) splices in at this index so the previous
// turn's response stays attached to its prompt and queued prompts
// trail at the bottom.
function queuedBoundary(): number {
  if (!state.current) return 0;
  const log = state.current.log;
  for (let i = 0; i < log.length; i++) {
    if (isWaitingQueuedBubble(log[i]!)) return i;
  }
  return log.length;
}

function insertAboveQueued(item: LogItem): void {
  if (!state.current) return;
  state.current.log.splice(queuedBoundary(), 0, item);
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
  const log = state.current.log;
  // Active-turn content has to land above any waiting-queued bubbles
  // (so the previous turn's response stays attached to its prompt
  // instead of sliding below the queued ones). Scan backward from the
  // queued boundary, skipping spinners — the spinner is a transient
  // marker that shouldn't break streaming-chunk merging into the open
  // bubble below it.
  const boundary = queuedBoundary();
  let last: LogItem | undefined;
  for (let i = boundary - 1; i >= 0; i--) {
    const e = log[i]!;
    if (e.kind !== "spinner") {
      last = e;
      break;
    }
  }
  if (last && last.kind === "stream" && last.role === role && !last.closed) {
    last.text += text;
    return;
  }
  log.splice(boundary, 0, { kind: "stream", role, text });
}

// Mark the most recent OPEN stream entry as closed so a subsequent
// chunk of the same role starts a fresh bubble rather than appending.
// Called at every natural boundary: a tool call begins, a turn ends,
// etc. — same places hydra-acp-slack calls closeAgentMessage().
// Skipping already-closed streams matters now that queued user bubbles
// (always pushed with closed: true) can sit at the tail of the log: a
// naive "find last stream" would land on the queued bubble and leave
// any open agent stream above it untouched.
export function closeOpenStream(): void {
  if (!state.current) return;
  for (let i = state.current.log.length - 1; i >= 0; i--) {
    const e = state.current.log[i]!;
    if (e.kind === "stream" && !e.closed) {
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
    // refers to it, re-insert so renderLogItem can find it.
    if (!c.log.some((e) => e.kind === "spinner")) {
      insertAboveQueued({ kind: "spinner", spinner: c.spinner });
    }
    return;
  }
  c.spinner = { toolCallIds: [], expanded: false };
  insertAboveQueued({ kind: "spinner", spinner: c.spinner });
}

// Recognise Claude's ExitPlanMode across casing variants (camelCase from
// claude-acp today; snake_case left in for forward-compat). Case-insensitive
// so name/title carry-overs from arbitrary upstreams still match.
function isExitPlanModeTool(name: string | undefined): boolean {
  if (!name) return false;
  return name.toLowerCase().replace(/[_\s-]/g, "") === "exitplanmode";
}

function readExitPlanMarkdown(update: AnyRecord): string | null {
  const rawInput = update.rawInput;
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return null;
  }
  const plan = (rawInput as AnyRecord).plan;
  if (typeof plan !== "string" || plan.length === 0) return null;
  return plan;
}

function findExitPlanLogItem(
  toolCallId: string,
): { idx: number; item: ExitPlanLogItem } | null {
  if (!state.current) return null;
  const log = state.current.log;
  for (let i = 0; i < log.length; i++) {
    const entry = log[i]!;
    if (entry.kind === "exit-plan-mode" && entry.toolCallId === toolCallId) {
      return { idx: i, item: entry };
    }
  }
  return null;
}

// Push or update the ExitPlanMode log bubble for `toolCallId`. Returns true
// if the update was an ExitPlanMode payload and should not fall through to
// the generic tool-call handling.
function applyExitPlanModeUpdate(update: AnyRecord): boolean {
  if (!state.current) return false;
  const toolCallId = String(update.toolCallId ?? "");
  if (!toolCallId) return false;
  const name = (update.name ?? update.title) as string | undefined;
  const existing = findExitPlanLogItem(toolCallId);
  // For an update with no name, only special-case it when we already have
  // a bubble for this toolCallId (so subsequent tool_call_updates that
  // omit `name` still flow through here).
  if (!isExitPlanModeTool(name) && !existing) {
    return false;
  }
  const plan = readExitPlanMarkdown(update);
  const status =
    typeof update.status === "string" ? update.status : undefined;
  if (existing) {
    if (plan !== null) existing.item.plan = plan;
    if (status !== undefined) existing.item.status = status;
    return true;
  }
  if (plan === null) {
    // We've identified the tool by name but the plan body hasn't landed
    // yet — fall through to the generic handler so something is rendered.
    return false;
  }
  closeOpenStream();
  const item: ExitPlanLogItem = {
    kind: "exit-plan-mode",
    toolCallId,
    plan,
  };
  if (status !== undefined) item.status = status;
  insertAboveQueued(item);
  return true;
}

function onToolCall(update: AnyRecord): void {
  if (!state.current) return;
  // Close any streaming agent message before this tool so the next
  // agent chunk after the tool starts a fresh bubble — same pattern
  // hydra-acp-slack uses with closeAgentMessage.
  closeOpenStream();
  if (applyExitPlanModeUpdate(update)) {
    maybeResolvePermissionByToolCall(
      String(update.toolCallId),
      typeof update.status === "string" ? update.status : undefined,
    );
    return;
  }
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
  maybeResolvePermissionByToolCall(tc.toolCallId, tc.status);
}

function onToolCallUpdate(update: AnyRecord): void {
  if (!state.current) return;
  if (applyExitPlanModeUpdate(update)) {
    if (typeof update.status === "string") {
      maybeResolvePermissionByToolCall(
        String(update.toolCallId),
        update.status,
      );
    }
    return;
  }
  const existing = state.current.toolCalls.get(String(update.toolCallId));
  if (!existing) return;
  if (typeof update.status === "string") {
    existing.status = update.status;
    maybeResolvePermissionByToolCall(existing.toolCallId, update.status);
  }
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
  // Mark any own entry that was processing as done. The daemon doesn't
  // emit a prompt_queue_removed for natural turn completion (only for
  // started/cancelled/abandoned), so without this our promptQueue keeps
  // counting the just-finished prompt as "active" and ahead-of-queue
  // for the next prompt's chip math.
  for (const entry of state.current.promptQueue) {
    if (entry.status === "processing") {
      entry.status = "done";
    }
  }
  // Forget the active-turn plan card — the next plan update should
  // push a fresh card rather than mutating last turn's into oblivion.
  state.current.currentPlanEntry = null;
  // The head is no longer in flight; clear the amend target so a
  // post-turn Amend doesn't point at a finished prompt.
  state.current.currentHeadMessageId = undefined;
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
  // If we already rendered this peer prompt via prompt_queue_added
  // (browser shows peer-queued bubbles with chips), skip the second
  // render — the bubble is already in the log, and the chip's
  // queued→processing transition is driven by prompt_queue_removed.
  const messageId =
    typeof update.messageId === "string" ? update.messageId : undefined;
  if (messageId && state.current.queueByMessageId.has(messageId)) {
    return;
  }
  if (consumeOwnPromptEcho({ text })) {
    return;
  }
  // Sibling prompt — insert above any waiting-queued bubbles so it
  // joins the live conversation flow, not the trailing queue.
  // closeOpenStream first so any in-flight agent stream is broken.
  closeOpenStream();
  insertAboveQueued({
    kind: "stream",
    role: "user",
    text,
    closed: true,
  });
}

// ---- Server-driven prompt queue handlers -------------------------

// Apply the daemon's queue snapshot delivered via the attach-response
// _meta["hydra-acp"].queue. Each entry becomes a user bubble with a
// queueEntry whose status reflects position (0 = head/processing,
// >0 = waiting). Treated like peer-originated entries — the freshly-
// attached client has a new clientId, so even prompts our previous
// session originated read as foreign now (which is what we want; the
// originator's local FIFO is gone, can't bind anything to them).
export function hydrateQueueFromSnapshot(snapshot: unknown[]): void {
  if (!state.current) return;
  for (const raw of snapshot) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as AnyRecord;
    const messageId = typeof e.messageId === "string" ? e.messageId : "";
    if (!messageId) continue;
    if (state.current.queueByMessageId.has(messageId)) continue;
    const blocks = Array.isArray(e.prompt) ? e.prompt : [];
    let text = "";
    for (const block of blocks) {
      if (block && typeof block === "object") {
        const b = block as AnyRecord;
        if (b.type === "text" && typeof b.text === "string") {
          text += b.text;
        }
      }
    }
    if (!text) continue;
    const position = typeof e.position === "number" ? e.position : 0;
    const entry = {
      id: "snap_" + Math.random().toString(36).slice(2, 10),
      text,
      status: position === 0 ? ("processing" as const) : ("queued" as const),
      aheadAtEnqueue: Math.max(0, position),
      messageId,
    };
    state.current.queueByMessageId.set(messageId, entry);
    // Position 0 is the in-flight head. The live "started" notification
    // already fired before we attached, so we'd never otherwise learn
    // the head's messageId — without this the Amend button stays hidden
    // for the rest of the in-flight turn (see views.ts:974).
    if (position === 0) {
      state.current.currentHeadMessageId = messageId;
    }
    state.current.log.push({
      kind: "stream",
      role: "user",
      text,
      closed: true,
      queueEntry: entry,
    });
  }
}


// React to a new entry landing on hydra's per-session queue. For own
// prompts: bind hydra's server-assigned messageId to the FIFO head
// unbound local entry (hydra serializes session/prompt arrivals so
// FIFO order matches our submit order). For peer prompts: push a
// fresh user bubble with a queueEntry so we get the same chip
// treatment our own queued prompts get — that's how a second
// attached client (browser + TUI on the same session) sees what the
// other client typed *while* it's still queued. The peer's eventual
// prompt_received notification is de-duped against this bubble via
// messageId (see onPromptReceived).
function onPromptQueueAdded(params: AnyRecord): void {
  if (!state.current) return;
  const messageId = typeof params.messageId === "string" ? params.messageId : "";
  if (!messageId) return;
  // Daemon attaches _meta["hydra-acp"].amending = <M1 messageId> when
  // this entry is the M2 of an amend pair. Captured here so the
  // bubble can render a "+" marker even before the dedicated
  // hydra-acp/prompt_amended notification arrives (wire-ordering is
  // not strictly guaranteed between the two).
  const meta = (params._meta ?? {}) as AnyRecord;
  const hydraMeta = (meta["hydra-acp"] ?? {}) as AnyRecord;
  const amendingTarget =
    typeof hydraMeta.amending === "string" ? hydraMeta.amending : undefined;
  const originator = (params.originator ?? {}) as AnyRecord;
  const originatorClientId =
    typeof originator.clientId === "string" ? originator.clientId : "";
  const isOwn =
    !!state.current.ownClientId &&
    originatorClientId === state.current.ownClientId;
  if (isOwn) {
    const unbound = state.current.promptQueue.find(
      (e) => e.messageId === undefined && e.status !== "cancelled",
    );
    if (!unbound) {
      // Out-of-band added event we can't correlate (e.g. resumed after
      // a refresh, no local FIFO entry waiting). Drop on the floor —
      // there's no chip to update.
      return;
    }
    unbound.messageId = messageId;
    state.current.queueByMessageId.set(messageId, unbound);
    if (amendingTarget !== undefined) {
      unbound.amendsMessageId = amendingTarget;
      tagAmendedM1(amendingTarget, messageId);
    }
    // Adopt the daemon's authoritative position. Optimistic
    // aheadAtEnqueue at submit can undercount when peer entries we
    // weren't tracking are already queued — a one-shot correction on
    // bind is fine (it only goes up, never down, so it doesn't tick
    // distractingly).
    const position = typeof params.position === "number" ? params.position : 1;
    unbound.aheadAtEnqueue = Math.max(0, position);
    // Promote to "processing" if hydra says position 0 (we're at the
    // head and about to run). Otherwise leave as "queued".
    if (position === 0) {
      unbound.status = "processing";
    } else if (unbound.status === "pending") {
      unbound.status = "queued";
    }
    return;
  }
  // Peer-originated. Render a fresh user bubble for it now — same
  // chip-on-bubble treatment as own queued prompts, so the user sees
  // the peer's queued prompt instead of waiting for it to start.
  const blocks = Array.isArray(params.prompt) ? params.prompt : [];
  let text = "";
  for (const block of blocks) {
    if (block && typeof block === "object") {
      const b = block as AnyRecord;
      if (b.type === "text" && typeof b.text === "string") {
        text += b.text;
      }
    }
  }
  if (!text) return;
  const position = typeof params.position === "number" ? params.position : 0;
  const queueDepth =
    typeof params.queueDepth === "number" ? params.queueDepth : 1;
  const entry: QueueEntry = {
    id: "peer_" + Math.random().toString(36).slice(2, 10),
    text,
    // position 0 = head, already running; >0 = waiting in line. Mirror
    // own-prompt status semantics.
    status: position === 0 ? "processing" : "queued",
    aheadAtEnqueue: Math.max(0, position),
    messageId,
  };
  if (amendingTarget !== undefined) {
    entry.amendsMessageId = amendingTarget;
    tagAmendedM1(amendingTarget, messageId);
  }
  state.current.queueByMessageId.set(messageId, entry);
  // closeOpenStream so any in-flight agent stream above is broken.
  closeOpenStream();
  const peerBubble: LogItem = {
    kind: "stream",
    role: "user",
    text,
    closed: true,
    queueEntry: entry,
  };
  if (position === 0) {
    // Peer is the new active turn — slot above any waiting-queued
    // bubbles so it sits inline with the conversation.
    insertAboveQueued(peerBubble);
  } else {
    // Peer joins the trailing queue cluster.
    state.current.log.push(peerBubble);
  }
}

// Server says a queued entry's prompt content changed (someone called
// hydra-acp/update_prompt). Apply to our local entry so the bubble's
// text reflects the latest payload — works for both edits we made
// ourselves and edits other clients made to our queued prompt.
function onPromptQueueUpdated(params: AnyRecord): void {
  if (!state.current) return;
  const messageId = typeof params.messageId === "string" ? params.messageId : "";
  if (!messageId) return;
  const entry = state.current.queueByMessageId.get(messageId);
  if (!entry) return;
  const blocks = Array.isArray(params.prompt) ? params.prompt : [];
  let text = "";
  for (const block of blocks) {
    if (block && typeof block === "object") {
      const b = block as AnyRecord;
      if (b.type === "text" && typeof b.text === "string") {
        text += b.text;
      }
    }
  }
  if (!text) return;
  entry.text = text;
  // Also update the LogItem's text so the bubble re-renders with the
  // new content. Match by reference — the entry is the same object the
  // log item holds in queueEntry.
  for (const item of state.current.log) {
    if (
      item.kind === "stream" &&
      item.role === "user" &&
      item.queueEntry === entry
    ) {
      item.text = text;
      break;
    }
  }
}

// Server says the entry left the queue. reason: started → it's now
// running (chip transitions to processing then disappears once
// turn_complete arrives); cancelled → mark cancelled, the bubble
// stays with a struck-through body and a "cancelled" chip; abandoned
// → similar to cancelled but indicates session teardown rather than
// explicit user cancel.
function onPromptQueueRemoved(params: AnyRecord): void {
  if (!state.current) return;
  const messageId = typeof params.messageId === "string" ? params.messageId : "";
  if (!messageId) return;
  const reason = typeof params.reason === "string" ? params.reason : "";
  // reason === "started" → this messageId is now the in-flight head.
  // Universal signal that reaches the originator too, unlike
  // prompt_received which excludes them. Used as targetMessageId for
  // the Amend button.
  if (reason === "started") {
    state.current.currentHeadMessageId = messageId;
  }
  const entry = state.current.queueByMessageId.get(messageId);
  if (!entry) return;
  if (reason === "started") {
    entry.status = "processing";
  } else if (reason === "cancelled" || reason === "abandoned") {
    // If we already flagged this entry as amended (via prompt_amended
    // or the M2's _meta.amending hint) the bubble should render as
    // "merged forward" rather than user-cancelled. Otherwise it's a
    // plain cancel.
    if (entry.amendedByMessageId !== undefined) {
      entry.status = "amended";
    } else {
      entry.status = "cancelled";
    }
    state.current.queueByMessageId.delete(messageId);
  }
}

// hydra-acp/prompt_amended is the M1→M2 linkage event. We may have
// already tagged the pair via the amending _meta hint on M2's
// prompt_queue_added, but this notification is the authoritative
// signal and also catches the case where M2's added arrives later (or
// not at all, if the daemon couldn't enqueue it).
function onPromptAmended(params: AnyRecord): void {
  if (!state.current) return;
  const cancelledId =
    typeof params.cancelledMessageId === "string"
      ? params.cancelledMessageId
      : "";
  const newId =
    typeof params.newMessageId === "string" ? params.newMessageId : "";
  if (!cancelledId || !newId) return;
  tagAmendedM1(cancelledId, newId);
  const m2 = state.current.queueByMessageId.get(newId);
  if (m2 && m2.amendsMessageId === undefined) {
    m2.amendsMessageId = cancelledId;
  }
}

// Mark the M1 entry as "amended by <M2 messageId>" so the bubble can
// render an "amended" chip instead of a plain cancellation when the
// daemon's prompt_queue_removed{cancelled} arrives. If the removed
// event already arrived first we promote the status from "cancelled"
// to "amended" in place.
function tagAmendedM1(m1MessageId: string, m2MessageId: string): void {
  if (!state.current) return;
  const m1 =
    state.current.queueByMessageId.get(m1MessageId) ??
    state.current.promptQueue.find((e) => e.messageId === m1MessageId);
  if (!m1) return;
  m1.amendedByMessageId = m2MessageId;
  if (m1.status === "cancelled") {
    m1.status = "amended";
  }
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
  insertAboveQueued(item);
  state.current.currentPlanEntry = item;
}

// Sibling client (slack, editor, …) answered a permission request
// first. Tear down our (now-stale) prompt card. Keyed by toolCallId
// per RFD #533. Idempotent: if we don't have an entry, no-op.
function onPermissionResolved(update: AnyRecord | undefined): void {
  if (!state.current) return;
  const toolCallId =
    typeof update?.toolCallId === "string" ? update.toolCallId : undefined;
  if (!toolCallId) return;
  resolvePermissionByToolCallId(toolCallId);
}

function resolvePermissionByToolCallId(toolCallId: string): void {
  if (!state.current) return;
  state.current.pendingPermissions.delete(toolCallId);
  state.current.log = state.current.log.filter(
    (e) => !(e.kind === "perm" && e.toolCallId === toolCallId),
  );
}

// Fallback for when the daemon's permission_resolved didn't arrive:
// if the agent emits a tool_call_update for our pending permission's
// toolCallId in any non-pending state, the decision was clearly made
// elsewhere — clear our prompt card the same way.
function maybeResolvePermissionByToolCall(
  toolCallId: string | undefined,
  status: string | undefined,
): void {
  if (!state.current || !toolCallId || !status || status === "pending") {
    return;
  }
  if (state.current.pendingPermissions.has(toolCallId)) {
    resolvePermissionByToolCallId(toolCallId);
  }
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
  // Hydra-side prompt queue notifications. These don't fit the
  // session/update shape (they're top-level hydra-acp/* methods) so
  // they're dispatched separately, before the session/update guard.
  if (frame.method === "hydra-acp/prompt_queue_added") {
    onPromptQueueAdded((frame.params ?? {}) as AnyRecord);
    return;
  }
  if (frame.method === "hydra-acp/prompt_queue_updated") {
    onPromptQueueUpdated((frame.params ?? {}) as AnyRecord);
    return;
  }
  if (frame.method === "hydra-acp/prompt_queue_removed") {
    onPromptQueueRemoved((frame.params ?? {}) as AnyRecord);
    return;
  }
  if (frame.method === "hydra-acp/prompt_amended") {
    onPromptAmended((frame.params ?? {}) as AnyRecord);
    return;
  }
  if (frame.method !== "session/update") return;
  const update = (frame.params?.update ?? null) as AnyRecord | null;
  if (!update || typeof update !== "object") return;
  const kind = String(update.sessionUpdate ?? "");
  // Sibling-resolved permission tear-down. Doesn't flip inTurn or
  // route through the per-case switch — it's a transient correlation
  // signal, not session activity.
  if (kind === "permission_resolved") {
    onPermissionResolved(update);
    return;
  }
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
      // hydra-acp-slack uses.)
      const meta = (update._meta ?? {}) as AnyRecord;
      const hydraMeta = (meta["hydra-acp"] ?? {}) as AnyRecord;
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
        render();
      }
      break;
    case "available_modes_update":
      if (state.current && Array.isArray(update.availableModes)) {
        state.current.modes = update.availableModes as never;
        render();
      }
      break;
    case "current_model_update":
      if (state.current) {
        state.current.model = (update.modelId ?? update.currentModelId ?? null) as string | null;
        if (Array.isArray(update.availableModels)) {
          state.current.models = update.availableModels as never;
        }
        render();
      }
      break;
    case "usage_update":
      if (state.current) {
        // Wire shape (per hydra-acp-slack's session.ts:583): { used,
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
    case "turn_complete": {
      // Daemon attaches _meta["hydra-acp"].amended = { cancelledMessageId,
      // newMessageId } when the turn ended because an amend cancelled
      // it. Promote the M1 bubble from "cancelled" to "amended" before
      // finalizing so the chip + bubble styling reflect the merge —
      // hydra-acp/prompt_amended is the canonical signal but it isn't
      // strictly ordered relative to turn_complete, and the in-band
      // marker lets us avoid a one-frame red flash.
      const meta = (update._meta ?? {}) as AnyRecord;
      const hydraMeta = (meta["hydra-acp"] ?? {}) as AnyRecord;
      const amended = hydraMeta.amended as AnyRecord | undefined;
      if (amended) {
        const cancelledId =
          typeof amended.cancelledMessageId === "string"
            ? amended.cancelledMessageId
            : "";
        const newId =
          typeof amended.newMessageId === "string" ? amended.newMessageId : "";
        if (cancelledId && newId) {
          tagAmendedM1(cancelledId, newId);
        }
      }
      finalizeTurn();
      break;
    }
    case "session_info_update":
      // Hydra synthesizes this on the first prompt of a session and
      // forwards any agent-emitted update authoritatively. Either way,
      // adopt the new title in the chat header. The session list view
      // picks the same change up via /api/sessions polling, so list
      // and chat stay coherent without an extra request.
      if (state.current && typeof update.title === "string") {
        state.current.title = update.title;
      }
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
    // Key by toolCallId so RFD #533 sibling-resolved tear-down can find
    // the right entry without per-recipient JSON-RPC id correlation.
    const toolCall = (params.toolCall as AnyRecord | undefined) ?? {};
    const toolCallId =
      typeof toolCall.toolCallId === "string" ? toolCall.toolCallId : "";
    if (!toolCallId) {
      // Malformed request — refuse rather than pin orphaned UI state.
      state.current.ws?.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          error: { code: -32602, message: "missing toolCall.toolCallId" },
        }),
      );
      return;
    }
    state.current.pendingPermissions.set(toolCallId, {
      requestId: req.id as string | number,
      toolCallId,
      toolCall: toolCall as PermissionEntry["toolCall"],
      options: (params.options as never) ?? [],
    });
    pushLog({ kind: "perm", toolCallId });
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
