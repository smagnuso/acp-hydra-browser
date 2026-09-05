// ACP notification + agent-request handling. Owns the turn-lifecycle
// signal (inTurn) and tool-call/permission tracking. Stays free of WS
// plumbing — that lives in bridge.ts.

import { state, setState } from "./state.js";
import { render } from "./renderer.js";
import { contentToText } from "./markdown.js";
import { extractEditDiff } from "./edit-diff.js";
import { queueFrameForCache } from "./history-cache.js";
import type {
  ArmedTask,
  Attachment,
  ChatState,
  ConfigOption,
  EditDiffLogItem,
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

// session/update kinds that carry live/derived state rather than
// recordable history — the daemon doesn't persist them, so it can't use
// one as an after_message reconnect anchor. Mirrors cli's tui/app.ts
// STATE_UPDATE_KINDS.
const STATE_UPDATE_KINDS = new Set([
  "session_info_update",
  "_hydra_current_model_update",
  "current_mode_update",
  "available_commands_update",
  "_hydra_available_modes_update",
  "usage_update",
  "config_option_update",
  "_hydra_compaction",
  "_hydra_workspace",
  "clarifier_question_asked",
  "clarifier_question_answered",
  "clarifier_question_dismissed",
]);

// Reset the history-bearing slice of chat state for a full session/attach
// replay — either a session's first attach, or a reconnect where the
// daemon couldn't honor an after_message delta request (see bridge.ts's
// bridge/replay_policy handling). A successful delta reattach skips this
// entirely, which is what keeps the transcript and scroll position intact
// across a quiet reconnect instead of blanking and re-snapping to bottom.
export function resetChatHistoryState(c: ChatState): void {
  c.log = [];
  c.toolCalls = new Map();
  c.pendingPermissions = new Map();
  c.spinner = null;
  c.plan = null;
  c.mode = null;
  c.model = null;
  c.modes = [];
  c.models = [];
  c.contextUsed = null;
  c.contextSize = null;
  c.cost = null;
  c.busy = false;
  c.recentOwnPrompts = [];
  c.promptQueue = [];
  c.queueByMessageId = new Map();
  c.ownPromptIds = new Map();
  c.inTurn = false;
  c.unsolicitedTurnOpen = new Set();
  c.currentPlanEntry = null;
  c.daemonSupportsAmend = false;
  c.ownClientId = undefined;
  c.currentHeadMessageId = undefined;
  c.lastSeenMessageId = undefined;
  c.pendingCursorMessageId = undefined;
  c.lastSeenSeq = undefined;
  c.spinnerOwner = undefined;
}

// Daemon-stamped record time (PROTOCOL.md, params._meta["hydra-acp"]
// .recordedAt). Present on recorded kinds, live and replayed alike;
// absent on state kinds and pre-field daemons — callers fall back to
// Date.now(). This is what lets a replayed turn's stamp show its real
// duration instead of measuring the replay. Mirrors cli's
// extractRecordedAt.
// Read side of the daemon's per-frame replay cursor
// (PROTOCOL.md, params._meta["hydra-acp"].seq). Absent on state kinds and
// on daemons predating the field.
function extractFrameSeq(params: unknown): number | undefined {
  if (!params || typeof params !== "object") return undefined;
  const meta = (params as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const inner = (meta as Record<string, unknown>)["hydra-acp"];
  if (!inner || typeof inner !== "object") return undefined;
  const seq = (inner as { seq?: unknown }).seq;
  return typeof seq === "number" && Number.isFinite(seq) ? seq : undefined;
}

function extractRecordedAt(params: unknown): number | undefined {
  if (!params || typeof params !== "object") return undefined;
  const meta = (params as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const inner = (meta as Record<string, unknown>)["hydra-acp"];
  if (!inner || typeof inner !== "object") return undefined;
  const at = (inner as { recordedAt?: unknown }).recordedAt;
  return typeof at === "number" && Number.isFinite(at) ? at : undefined;
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

// Copy a just-bound entry's messageId onto its log bubble. Bubbles
// created at dispatch time (queue.ts) can't carry one — the daemon
// hasn't assigned it yet — but the replay-dedup guards (pushChunk,
// onPromptReceived) match by item.messageId, so an unstamped bubble is
// invisible to them: a reconnect delta redelivering prompt_received for
// an in-flight own prompt then re-renders it as a duplicate bubble at
// the bottom of the log (observed live, complete with a freeze-then-new
// spinner churn). Stamping at every bind site closes that hole.
function stampBubbleMessageId(entry: QueueEntry, sentAt?: number): void {
  if (!state.current || entry.messageId === undefined) return;
  for (const item of state.current.log) {
    if (item.kind === "stream" && item.queueEntry === entry) {
      item.messageId = entry.messageId;
      if (sentAt !== undefined) {
        item.sentAt = sentAt;
      }
      cacheOwnPromptFrame(entry);
      return;
    }
  }
}

// Our own prompts never arrive as frames, so nothing would otherwise
// cache them: the daemon excludes the originator from prompt_received
// (and turn_complete) fan-out — only prompt_queue/added comes back to
// the sender. The bubble is created locally at dispatch, lives only in
// memory, and is gone on reload. Worse, it can never be recovered: the
// agent's reply chunks DO arrive and push lastSeenMessageId past this
// prompt's messageId, so the delta reconnect only ever asks for what
// came after it. Measured on a real session as 55 cached prompts
// against 91 real ones, always missing the most recent — while the
// replies to those same prompts survived, because those weren't
// excluded.
//
// Synthesising the frame the daemon didn't send us closes the hole. It
// carries the real messageId, so a later full replay of the daemon's own
// copy renders once: onPromptReceived's messageId guard skips the second.
// (mergeAndTrim used to collapse them in the cache too; that dedup is
// gone, so the cache holds both copies — wasteful, not wrong.)
//
// Neither synthesiser advances the cache's replay cursor. This one can't:
// `${owner}:turn_complete` is an id we made up, absent from daemon
// history, so a cold load resuming from it misses and falls back to a
// full replay — defeating the cache at the end of every own turn, which
// is precisely when a cold load is most likely. The prompt frame's id is
// real but can arrive out of order (hydrateQueueFromSnapshot binds
// already-queued prompts at reattach), and a cursor that moves backwards
// mid-stream replays content we already have. The cursor belongs to the
// live frame path in handleNotification; these two only add content.
//
// Synthesises the turn_complete the daemon withheld from us (see
// finalizeTurn's `own` note). Keyed off the owning prompt's messageId so
// the id is deterministic: replaying this frame twice is harmless —
// freezeSpinner is a no-op once the spinner is already frozen — but a
// random id per call would accumulate a fresh copy in the cache on every
// merge.
function cacheOwnTurnCompleteFrame(stopReason?: string, endedAt?: number): void {
  const owner = state.current?.spinnerOwner;
  if (!state.current || owner === undefined) return;
  queueFrameForCache(
    state.current.sessionId,
    {
      method: "session/update",
      params: {
        sessionId: state.current.sessionId,
        update: {
          sessionUpdate: "turn_complete",
          messageId: `${owner}:turn_complete`,
          ...(stopReason !== undefined ? { stopReason } : {}),
        },
        _meta: { "hydra-acp": { recordedAt: endedAt ?? Date.now() } },
      },
    },
  );
}

function cacheOwnPromptFrame(entry: QueueEntry): void {
  if (!state.current || entry.messageId === undefined) return;
  queueFrameForCache(
    state.current.sessionId,
    {
      method: "session/update",
      params: {
        sessionId: state.current.sessionId,
        update: {
          sessionUpdate: "prompt_received",
          messageId: entry.messageId,
          // Image blocks too, not just the text: extractImageAttachments
          // reads them back off this frame on the next hydrate, so a
          // text-only synthesis dropped every pasted screenshot from your
          // own prompts while their text survived the reload.
          prompt: [
            { type: "text", text: entry.text },
            ...(entry.attachments ?? []).map((a) => ({
              type: "image",
              mimeType: a.mimeType,
              data: a.data,
            })),
          ],
        },
        _meta: { "hydra-acp": { recordedAt: Date.now() } },
      },
    },
  );
}

// The turn-layout model (mirrors cli's tui/app.ts startToolsBlock):
//
//   [history][prompt][spinner][this turn's content …][queued tail]
//
// A spinner is anchored once, directly under the prompt that opened its
// turn (startTurnSpinner), and NEVER moves afterwards — the turn's
// content streams in below it via insertAboveQueued. At turn end
// (finalizeTurn) it freezes in place into a "turn-stamp" recording how
// long the turn took, the TUI's frozen "thought · Xs" block. If a new
// turn opens while a spinner is still live (its end was never seen),
// the old one freezes where it stands and a fresh one anchors under
// the new prompt — freeze-then-new, no repositioning.
//
// Replay and live traffic take the SAME path: recorded frames carry
// the daemon's recordedAt (extractRecordedAt above), so replayed turns
// stamp their real durations, and a turn still in flight at replay end
// simply keeps its spinner live — which is exactly what makes the
// thinking block survive a mid-turn page reload.
//
// One residual repair: the queued boundary is computed from bubble
// STATUS, and status changes over time (pending → queued). Content
// spliced under one regime can strand when a later flip moves the
// boundary past it, so the pending→queued flip in onPromptQueueAdded
// moves the BUBBLE below the content that accumulated under it.

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

export function pushChunk(
  role: "user" | "agent" | "thought",
  content: unknown,
  synthetic = false,
  messageId?: string,
): void {
  if (!state.current) return;
  const text = contentToText(content);
  if (!text) return;
  const log = state.current.log;
  // Active-turn content lands above any waiting-queued bubbles (so the
  // turn's output stays attached to its prompt and queued prompts trail
  // at the bottom) and BELOW the spinner, which sits under the prompt
  // (see the turn-layout model above). Scan backward from the boundary
  // for the merge target, skipping spinners — right after a turn starts
  // the spinner is the only thing between the boundary and the prompt,
  // and it shouldn't break chunk merging.
  const boundary = queuedBoundary();
  let last: LogItem | undefined;
  for (let i = boundary - 1; i >= 0; i--) {
    const e = log[i]!;
    if (e.kind !== "spinner") {
      last = e;
      break;
    }
  }
  if (
    last &&
    last.kind === "stream" &&
    last.role === role &&
    !last.closed &&
    !!last.synthetic === synthetic &&
    // Never merge across a messageId boundary. Two agent messages can run
    // back to back with no tool call between them to close the first, and
    // folding them into one bubble makes that bubble span two groups —
    // which dropPendingCursorGroup then can't purge precisely, since only
    // the trailing group's text is about to be replayed back. Keeping one
    // bubble to one group is the invariant that makes the purge exact.
    (last.messageId === undefined ||
      messageId === undefined ||
      last.messageId === messageId)
  ) {
    last.text += text;
    // Each chunk is its own recordable frame with its own messageId
    // (cli's recordAndBroadcast stamps one per broadcast, not once per
    // logical message) — track the latest one, not just the first.
    // lastSeenMessageId (the reconnect cursor, set from this same
    // per-chunk id) always advances to the newest chunk seen; leaving
    // this bubble pinned to its first chunk's id would desync it from
    // that cursor and starve the dedup check below on a later chunk's
    // replay after a reconnect lands mid-message.
    if (messageId !== undefined) {
      last.messageId = messageId;
    }
    return;
  }
  // NO messageId dedup here. It reads like a natural key but isn't
  // unique per frame: agents stamp their own id (Claude's msg_01…) on
  // every chunk of one reply, and a reply routinely continues after a
  // tool call — text, tool_call (which closes the bubble), then more
  // text carrying that same id. Treating the repeat as redundant
  // delivery discarded every continuation, so the more tool-heavy the
  // turn, the more of the answer vanished; a heavily-tooled session
  // hydrated as little but turn-stamps.
  //
  // The duplicate this was written for — a reconnect delta redelivering
  // already-rendered content — is prevented at the source now, by
  // routing.ts ignoring frames from a superseded socket. Same lesson as
  // the identical dedup removed from history-cache's mergeAndTrim.
  log.splice(boundary, 0, {
    kind: "stream",
    role,
    text,
    synthetic: synthetic || undefined,
    messageId,
  });
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

// Called when a reattach came back as an after_message delta (bridge.ts).
// The cursor we sent names the last message group we saw the END of, so
// the delta necessarily restarts at the first frame of the group that was
// still streaming when the socket died — the daemon re-sends every chunk
// of it, including the ones we already rendered. Most replayed kinds
// absorb that idempotently (tool cards merge by toolCallId,
// prompt_received dedupes by messageId), but pushChunk deliberately does
// not dedupe: it appends verbatim, because agents reuse one id across a
// whole reply and treating a repeat as redundant used to discard every
// continuation. So the partial bubbles are dropped here and the replay
// rebuilds them whole.
//
// User bubbles are exempt. They're already messageId-deduped on the way
// in, and our OWN prompts are never re-delivered at all (hydra excludes
// the originator from prompt_received fan-out) — dropping one on the
// expectation that the replay restores it would delete it for good.
export function dropPendingCursorGroup(): void {
  if (!state.current) return;
  const c = state.current;
  const pending = c.pendingCursorMessageId;
  if (pending === undefined || pending === c.lastSeenMessageId) return;
  c.log = c.log.filter(
    (e) =>
      !(e.kind === "stream" && e.role !== "user" && e.messageId === pending),
  );
  c.pendingCursorMessageId = c.lastSeenMessageId;
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

// Fallback: make sure SOME spinner exists while activity is flowing.
// The canonical spinner is anchored by startTurnSpinner when a turn's
// opening prompt is seen; this covers activity with no observed opener
// (mid-turn delta reconnect that skipped the prompt frame, an
// agent-initiated turn) by anchoring at the current bottom. `startedAt`
// is the triggering frame's daemon recordedAt when the caller has one —
// load-bearing during replay: an anonymous spinner opened at
// Date.now() but frozen by a replayed turn_ended's recordedAt (in the
// past) computes a negative elapsed and stamps a bogus "thought · 0s";
// observed live as a wall of 0s stamps, one per replayed
// agent-initiated turn. bridge.ts's turnStartedAt handling further
// corrects the clock at attach when the daemon knows better.
export function ensureSpinner(startedAt?: number): void {
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
  c.spinner = {
    toolCallIds: [],
    expanded: false,
    startedAt: startedAt ?? Date.now(),
    sending: false,
  };
  c.spinnerOwner = undefined;
  insertAboveQueued({ kind: "spinner", spinner: c.spinner });
}

// Freeze the live spinner (if any) in place into a permanent
// turn-stamp — the TUI's "thought · Xs" analogue. Position is wherever
// the spinner was anchored: directly under the prompt whose turn it
// timed. Shared by finalizeTurn (normal turn end) and startTurnSpinner
// (a new turn opening implies the old one ended, at latest, now).
function freezeSpinner(endedAt?: number, stopReason?: string): void {
  if (!state.current) return;
  const c = state.current;
  const spinner = c.spinner;
  if (spinner) {
    const idx = c.log.findIndex((e) => e.kind === "spinner");
    if (idx >= 0) {
      const at = endedAt ?? Date.now();
      c.log[idx] = {
        kind: "turn-stamp",
        elapsedMs: Math.max(0, at - spinner.startedAt),
        toolCount: spinner.toolCallIds.length,
        stopReason,
        endedAt: at,
      };
    }
  }
  c.spinner = null;
  c.spinnerOwner = undefined;
  c.log = c.log.filter((e) => e.kind !== "spinner");
}

// A turn just opened: freeze any live predecessor where it stands (its
// end was never seen; it ended, at latest, when this turn began), then
// anchor a fresh spinner at the queued boundary — directly under the
// prompt bubble the caller just placed. `startedAt` is the opening
// frame's daemon recordedAt when known (replay gets real durations),
// else now. `owner` identifies the opening prompt so a later
// prompt_queue/removed{started} for the same prompt doesn't double-open.
// Mirrors cli's startToolsBlock. `sending` is true only for the
// optimistic client-side open at dispatch time (queue.ts) — every other
// caller here is reacting to a notification the daemon actually sent,
// so the turn is already confirmed under way.
export function startTurnSpinner(startedAt?: number, owner?: string, sending = false): void {
  if (!state.current) return;
  const c = state.current;
  freezeSpinner(startedAt);
  c.spinner = {
    toolCallIds: [],
    expanded: false,
    startedAt: startedAt ?? Date.now(),
    sending,
  };
  c.spinnerOwner = owner;
  insertAboveQueued({ kind: "spinner", spinner: c.spinner });
}

// Recognise Claude's ExitPlanMode across casing variants (camelCase from
// claude-acp today; snake_case left in for forward-compat). Case-insensitive
// so name/title carry-overs from arbitrary upstreams still match.
// Not always a string on the wire despite the type: the daemon
// externalises oversized values (a long Bash command, say) into
// `{ __hydraBlob, bytes }` reference objects, and `title` is one of the
// fields that can carry one. Calling .toLowerCase() on that threw a
// TypeError out of handleNotification — fatal during replay, since the
// cache-hydrate loop processes frames in a bare for-of and one throw
// abandons every remaining frame in the transcript.
function isExitPlanModeTool(name: unknown): boolean {
  if (typeof name !== "string" || !name) return false;
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

function findEditDiffLogItem(
  toolCallId: string,
): { idx: number; item: EditDiffLogItem } | null {
  if (!state.current) return null;
  const log = state.current.log;
  for (let i = 0; i < log.length; i++) {
    const entry = log[i]!;
    if (entry.kind === "edit-diff" && entry.toolCallId === toolCallId) {
      return { idx: i, item: entry };
    }
  }
  return null;
}

// Push or update the "Edited <path>" log bubble for `toolCallId`. Returns
// true if the update carried (or already had) an edit diff and should not
// fall through to the generic tool-call handling — this is what keeps the
// block visible and expandable after finalizeTurn() drops the spinner.
function applyEditDiffUpdate(update: AnyRecord): boolean {
  if (!state.current) return false;
  const toolCallId = String(update.toolCallId ?? "");
  if (!toolCallId) return false;
  const existing = findEditDiffLogItem(toolCallId);
  const diff = extractEditDiff(update);
  const status =
    typeof update.status === "string" ? update.status : undefined;
  if (existing) {
    if (diff !== null) existing.item.diff = diff;
    if (status !== undefined) existing.item.status = status;
    return true;
  }
  if (diff === null) return false;
  closeOpenStream();
  const item: EditDiffLogItem = {
    kind: "edit-diff",
    toolCallId,
    diff,
    expanded: false,
  };
  if (status !== undefined) item.status = status;
  insertAboveQueued(item);
  return true;
}

// Claude Code's `parentToolUseId` (raw `_meta.claudeCode`), set on a tool
// call issued by a subagent spawned via the `Task` tool rather than the
// foreground turn. Such calls are background noise multiplexed into this
// same session's update stream — closing the open agent-message bubble for
// one would freeze it mid-word the instant the subagent's next chunk
// lands, and split the foreground reply into two bubbles at whatever
// arbitrary point the subagent's tool call happened to interleave.
function getParentToolUseId(update: AnyRecord): string | undefined {
  const meta = update._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const claudeCode = (meta as AnyRecord).claudeCode;
  if (!claudeCode || typeof claudeCode !== "object") return undefined;
  const id = (claudeCode as AnyRecord).parentToolUseId;
  return typeof id === "string" ? id : undefined;
}

function onToolCall(update: AnyRecord): void {
  if (!state.current) return;
  // Close any streaming agent message before this tool so the next
  // agent chunk after the tool starts a fresh bubble — same pattern
  // hydra-acp-slack uses with closeAgentMessage. Skipped for a background
  // subagent's own tool call (see getParentToolUseId).
  if (getParentToolUseId(update) === undefined) {
    closeOpenStream();
  }
  if (applyExitPlanModeUpdate(update)) {
    maybeResolvePermissionByToolCall(
      String(update.toolCallId),
      typeof update.status === "string" ? update.status : undefined,
    );
    return;
  }
  if (applyEditDiffUpdate(update)) {
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
  // May still be null: ensureSpinner declines to create one during
  // replay (c.ready false), where historical tool calls shouldn't mint
  // a live marker. The toolCalls map above records the call either way.
  state.current.spinner?.toolCallIds.push(tc.toolCallId);
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
  if (applyEditDiffUpdate(update)) {
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

// stopReason comes from the session/prompt response (own turn) or the
// turn_complete/stop update's own `stopReason` field (peer-visible turn) —
// see bridge.ts and the "stop"/"turn_complete" case below. "cancelled"
// gets its own terminal status so the queue chip makes an interrupted
// turn visibly distinct from a normal finish, mirroring the same
// mid-flight-cancel case the TUI already flags loudly (app.ts's
// "stopped (<reason>)" treatment) — the browser previously had no
// equivalent, so a cancelled turn looked identical to a completed one.
// `own` marks the one caller that finalises a turn WE started, driven by
// the session/prompt response rather than a turn_complete notification —
// the daemon excludes the originator from turn_complete fan-out exactly
// as it does prompt_received, so no frame arrives and nothing would
// otherwise be cached. Left alone, a reload rebuilds these turns with no
// end: the spinner replays still-running and only gets closed out at
// bridge/ready against Date.now(), stamping a duration measured from the
// original turn's start to right now. That's the source of nonsense
// stamps like "thought · 30m 36s" on a turn that took seconds, and of
// the shortfall in cached turn-stamps (52) against real ones (80).
// Mirrors cacheOwnPromptFrame; see the exclusion note there.
export function finalizeTurn(
  stopReason?: string,
  endedAt?: number,
  own = false,
): void {
  if (!state.current) return;
  if (own) {
    cacheOwnTurnCompleteFrame(stopReason, endedAt);
  }
  // Freeze the live spinner in place into a permanent turn-stamp,
  // timing the turn with the daemon's recordedAt when the caller has
  // one (replayed turn_completes carry it — real durations even for
  // history). Tool-call records remain in state but are no longer
  // rendered as a clutter list.
  freezeSpinner(endedAt, stopReason);
  // Close the streaming agent message so the next turn starts a
  // fresh bubble even if the agent immediately resumes streaming.
  closeOpenStream();
  // Mark any own entry that was processing as done (or cancelled). The
  // daemon doesn't emit a prompt_queue_removed for natural turn
  // completion (only for started/cancelled/abandoned), so without this
  // our promptQueue keeps counting the just-finished prompt as "active"
  // and ahead-of-queue for the next prompt's chip math.
  for (const entry of state.current.promptQueue) {
    if (entry.status === "processing") {
      entry.status = stopReason === "cancelled" ? "cancelled" : "done";
    }
  }
  // A prompt held offline and flushed back while this turn was still
  // streaming: the turn is over now, its output is complete, and the
  // next turn's output hasn't started, so this is the one safe moment
  // to put the bubble in its final place below everything that came
  // before it. The "done"/"cancelled" guard keeps a stale flag from
  // firing on the prompt's own completion, which would drop it below
  // its own reply.
  for (const entry of state.current.promptQueue) {
    if (
      entry.reseatAfterCurrentTurn &&
      entry.status !== "done" &&
      entry.status !== "cancelled"
    ) {
      entry.reseatAfterCurrentTurn = undefined;
      reseatBubbleAtEnd(state.current, entry);
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

function onPromptReceived(update: AnyRecord, recordedAt?: number): void {
  if (!state.current) return;
  const blocks = Array.isArray(update.prompt) ? update.prompt : [];
  const text = blocks.map((b) => contentToText(b)).join("");
  if (!text) return;
  // If we already rendered this peer prompt via prompt_queue_added
  // (browser shows peer-queued bubbles with chips), skip the second
  // render — the bubble is already in the log, and the chip's
  // queued→processing transition is driven by prompt_queue_removed,
  // which also opens the turn's spinner.
  const messageId =
    typeof update.messageId === "string" ? update.messageId : undefined;
  if (messageId && state.current.queueByMessageId.has(messageId)) {
    return;
  }
  // Same replay-dedup as pushChunk's: a reconnect delta can redeliver a
  // prompt_received this tab already rendered — without this it would
  // duplicate the bubble AND churn the spinner (freeze-then-new against
  // a repeat of the same turn-open).
  if (
    messageId &&
    state.current.log.some(
      (e) => e.kind === "stream" && e.role === "user" && e.messageId === messageId,
    )
  ) {
    return;
  }
  if (consumeOwnPromptEcho({ text })) {
    return;
  }
  // Bind-agnostic own-echo guard for the window the two checks above
  // both miss: an own prompt whose prompt_queue_added never arrived
  // (socket died first — no messageId anywhere) and whose
  // recentOwnPrompts echo entry has aged out of its 60s window (long
  // turns easily outlive it across a reconnect). If an own in-flight
  // entry carries this exact text, this frame is its echo, not a new
  // prompt: adopt the messageId onto the entry + bubble instead of
  // rendering a duplicate at the bottom of the log.
  const inFlightTwin = state.current.promptQueue.find(
    (e) =>
      e.text === text &&
      (e.status === "pending" || e.status === "queued" || e.status === "processing"),
  );
  if (inFlightTwin) {
    if (messageId !== undefined && inFlightTwin.messageId === undefined) {
      inFlightTwin.messageId = messageId;
      state.current.queueByMessageId.set(messageId, inFlightTwin);
      stampBubbleMessageId(inFlightTwin);
      if (state.current.spinnerOwner === inFlightTwin.id) {
        state.current.spinnerOwner = messageId;
      }
    }
    return;
  }
  // Sibling or replayed prompt — insert above any waiting-queued
  // bubbles so it joins the live conversation flow, not the trailing
  // queue. closeOpenStream first so any in-flight agent stream is
  // broken.
  closeOpenStream();
  insertAboveQueued({
    kind: "stream",
    role: "user",
    text,
    closed: true,
    messageId,
    // Fallback for when prompt_queue_added's enqueuedAt was never seen
    // (an old daemon, or a replay that skipped straight to
    // prompt_received) — recordedAt here is turn-start time, not
    // accept time, but it's the best available stand-in.
    sentAt: recordedAt,
    attachments: extractImageAttachments(update.prompt),
  });
  // prompt_received IS the turn-open signal (cli's user-text handler
  // does exactly this): anchor the thinking block directly under the
  // prompt, live and replay alike. With the frame's recordedAt a
  // replayed turn stamps its real duration when its turn_complete
  // replays behind it — and the turn still in flight at replay end
  // keeps its spinner live, which is what makes the thinking block
  // survive a mid-turn page reload.
  startTurnSpinner(recordedAt, messageId);
  markActive();
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
    const position = typeof e.position === "number" ? e.position : 0;
    const existing = state.current.queueByMessageId.get(messageId);
    if (existing) {
      // Reconcile against the daemon's authoritative snapshot rather
      // than leaving whatever status we last knew locally untouched.
      // The live hydra-acp/prompt_queue/removed{started} notification
      // that would normally promote this entry can be lost to a
      // disconnect/server-restart race landing between the entry being
      // created and the next reattach — with nothing else left to
      // correct it, the chip was getting stuck on "queued" forever.
      // Mirrors onPromptQueueAdded's own promotion rule below.
      if (position === 0) {
        state.current.currentHeadMessageId = messageId;
        if (existing.status === "queued" || existing.status === "pending") {
          existing.status = "processing";
        }
      } else if (existing.status === "pending") {
        existing.status = "queued";
      }
      continue;
    }
    const text = promptBlocksToText(e.prompt);
    if (!text) continue;
    // Same rebind-not-duplicate logic as onPromptQueueAdded's revival
    // pass, for the same reason: cancelUnboundQueued can mark an entry
    // "cancelled" on a WS drop even though the daemon actually got it —
    // this snapshot is the proof. Text equality is required, same as
    // there: the snapshot also carries entries this client never
    // originated (peers, or our own pre-reconnect clientId's prompts on
    // a session another device also drives), and matching one of those
    // to an arbitrary unbound local entry revives the wrong bubble. The
    // matched entry's existing log bubble already points at this
    // QueueEntry object, so fixing it up in place is enough; no need to
    // touch c.log like the position-0 case below does for a bubble that
    // never had one.
    const revivable = state.current.promptQueue.find(
      (q) =>
        q.messageId === undefined &&
        q.text === text &&
        (q.status === "pending" || q.status === "queued" || q.status === "cancelled"),
    );
    if (revivable) {
      revivable.messageId = messageId;
      state.current.queueByMessageId.set(messageId, revivable);
      stampBubbleMessageId(revivable);
      revivable.aheadAtEnqueue = Math.max(0, position);
      revivable.status = position === 0 ? "processing" : "queued";
      if (position === 0) {
        state.current.currentHeadMessageId = messageId;
      }
      continue;
    }
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
      // The full-history replay that runs inside session/attach (before
      // bridge/ready, which is what triggers this function) already
      // rendered the head prompt via its prompt_received notification —
      // see onPromptReceived. Bind this entry to that existing bubble
      // instead of pushing a second one, or a busy session shows its
      // current prompt twice: once at its real spot in the transcript,
      // once again down here.
      const existing = findUnboundUserBubble(text);
      if (existing) {
        existing.queueEntry = entry;
        continue;
      }
    }
    state.current.log.push({
      kind: "stream",
      role: "user",
      text,
      closed: true,
      queueEntry: entry,
      attachments: extractImageAttachments(e.prompt),
    });
  }
}

// Last user stream bubble with the given text that isn't already bound
// to a queue entry. Scans backward since the head's bubble (if any) is
// the most recently replayed history item.
function findUnboundUserBubble(
  text: string,
): Extract<LogItem, { kind: "stream" }> | null {
  if (!state.current) return null;
  const log = state.current.log;
  for (let i = log.length - 1; i >= 0; i--) {
    const item = log[i]!;
    if (
      item.kind === "stream" &&
      item.role === "user" &&
      !item.queueEntry &&
      item.text === text
    ) {
      return item;
    }
  }
  return null;
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
function promptBlocksToText(prompt: unknown): string {
  const blocks = Array.isArray(prompt) ? prompt : [];
  let text = "";
  for (const block of blocks) {
    if (block && typeof block === "object") {
      const b = block as AnyRecord;
      if (b.type === "text" && typeof b.text === "string") {
        text += b.text;
      }
    }
  }
  return text;
}

// Mirrors promptBlocksToText for the image blocks buildContentBlocks
// (queue.ts) sends alongside the text one — {type: "image", data,
// mimeType}. The daemon persists and replays prompt content blocks
// verbatim (unlike large tool-call results, which it can blob-reference
// instead), so the actual image data is present on every path this
// feeds: prompt_received replay, a peer's live prompt, and the queue
// snapshot. sizeBytes is an estimate (base64 overhead, no way to
// recover the original byte count) — only used for display, never sent
// anywhere. Returns undefined rather than [] so a text-only bubble's
// LogItem stays clean (no attachments field at all) and its
// logItemSig/render path matches an ordinary bubble exactly.
function extractImageAttachments(prompt: unknown): Attachment[] | undefined {
  const blocks = Array.isArray(prompt) ? prompt : [];
  const attachments: Attachment[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const b = block as AnyRecord;
    if (b.type !== "image" || typeof b.data !== "string") continue;
    attachments.push({
      mimeType: typeof b.mimeType === "string" ? b.mimeType : "image/png",
      data: b.data,
      sizeBytes: Math.round((b.data.length * 3) / 4),
    });
  }
  return attachments.length > 0 ? attachments : undefined;
}

function onPromptQueueAdded(params: AnyRecord): void {
  if (!state.current) return;
  const messageId = typeof params.messageId === "string" ? params.messageId : "";
  if (!messageId) return;
  // Daemon attaches _meta["hydra-acp"].amending = <M1 messageId> when
  // this entry is the M2 of an amend pair. Captured here so the
  // bubble can render a "+" marker even before the dedicated
  // hydra-acp/prompt/amended notification arrives (wire-ordering is
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
  const eventText = promptBlocksToText(params.prompt);
  // Daemon accept-time timestamp (PROTOCOL.md's hydra-acp/prompt_queue/added
  // "enqueuedAt") — present for every originator, own included, unlike
  // prompt_received's recordedAt which excludes the sender. Same value
  // for every attached client and stable across a replay, so it's what
  // a "sent at" stamp on the bubble should show rather than the local
  // clock at optimistic-send time.
  const enqueuedAt =
    typeof params.enqueuedAt === "number" ? params.enqueuedAt : undefined;
  if (isOwn) {
    // Two-pass bind. Pass 1: FIFO among entries genuinely awaiting a
    // bind. This must win over revival: a cancelled straggler from an
    // earlier lost-ack episode sits ahead of the new entry in
    // promptQueue, and letting it match here steals the bind from the
    // entry this event was actually emitted for — the new entry then
    // sticks in "pending" forever, inflating every later send's ahead
    // count by one and compounding on each further mis-bind.
    //
    // Among those, prefer the one whose text matches this event's own
    // prompt, and only fall back to FIFO order when nothing matches.
    // Position alone is not enough: the added events for two prompts
    // sent in quick succession are not guaranteed to arrive in the
    // order they were sent, and binding purely by position then staples
    // the second prompt's messageId onto the first prompt's entry.
    // Everything keyed off that mapping goes to the wrong bubble --
    // queueByMessageId sends prompt_queue/updated's rewrite to the
    // earlier bubble (observed as editing a queued prompt overwriting
    // the in-flight one's text), while the entry that was actually
    // skipped never binds at all, so stampBubbleMessageId and with it
    // cacheOwnPromptFrame never run and that prompt is absent from the
    // transcript after a reload. Identical texts are indistinguishable,
    // but for those first-match IS FIFO, so the fallback is exact.
    const awaitingCandidates = state.current.promptQueue.filter(
      (e) =>
        e.messageId === undefined &&
        (e.status === "pending" || e.status === "queued" || e.status === "editing"),
    );
    const awaiting =
      (eventText.length > 0
        ? awaitingCandidates.find((e) => e.text === eventText)
        : undefined) ?? awaitingCandidates[0];
    // Pass 2 (revival): nothing is awaiting a bind, so this event
    // describes a prompt whose ack we lost — the send reached the
    // daemon just before the socket died, and cancelUnboundQueued
    // marked the entry cancelled on the (wrong, in that case) theory
    // that it never made it. The added event is proof it did; rebind
    // and let the real status win. Text equality is the guard against
    // reviving some unrelated straggler; in the lost-ack case the text
    // always matches. "offline" entries are never candidates in either
    // pass: those are deliberately unsent (see queue.ts's
    // flushOfflineQueue) and unrelated to whatever this describes.
    const unbound =
      awaiting ??
      state.current.promptQueue.find(
        (e) =>
          e.messageId === undefined &&
          e.status === "cancelled" &&
          e.text === eventText,
      );
    if (!unbound) {
      // Out-of-band added event we can't correlate (e.g. resumed after
      // a refresh, no local FIFO entry waiting). Drop on the floor —
      // there's no chip to update.
      return;
    }
    unbound.messageId = messageId;
    state.current.queueByMessageId.set(messageId, unbound);
    stampBubbleMessageId(unbound, enqueuedAt);
    // The spinner opened for this prompt at dispatch was owner-tagged
    // with the local entry id (no messageId existed yet). Upgrade the
    // tag now so the stale-completion guard in the turn_complete
    // handler can compare it against completing messageIds.
    if (state.current.spinnerOwner === unbound.id) {
      state.current.spinnerOwner = messageId;
    }
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
    // head and about to run). Otherwise leave as "queued" — including
    // recovering from a wrongly-applied "cancelled" (see above).
    if (position === 0) {
      unbound.status = "processing";
    } else if (unbound.status === "pending" || unbound.status === "cancelled") {
      unbound.status = "queued";
      // The prompt went out "pending" — optimistically the next head —
      // and dispatchPrompt opened a spinner for the turn it expected to
      // start. The daemon says it's actually waiting in line: no turn
      // of ours began, so that spinner marks nothing — discard it
      // outright (no stamp; freezing would fabricate a zero-length
      // turn). The genuinely-running turn re-establishes its own via
      // ensureSpinner on its next activity.
      if (
        state.current.spinnerOwner !== undefined &&
        state.current.spinnerOwner === unbound.id &&
        state.current.spinner
      ) {
        state.current.spinner = null;
        state.current.spinnerOwner = undefined;
        state.current.log = state.current.log.filter(
          (e) => e.kind !== "spinner",
        );
      }
      // While it was pending it didn't count as queued tail, so the
      // still-running turn's content kept splicing in below it. Re-seat
      // the bubble at the top of the queued tail (below everything
      // active; anything enqueued later already sits further down).
      // Leaving it would strand the active turn's remaining output
      // beneath a waiting prompt — the exact misordering observed
      // live. Remove first, then compute the boundary on the remaining
      // log: the bubble is "queued" now and would otherwise match
      // itself.
      const log = state.current.log;
      const bi = log.findIndex(
        (e) => e.kind === "stream" && e.queueEntry === unbound,
      );
      if (bi >= 0) {
        const [bubble] = log.splice(bi, 1);
        const target = queuedBoundary();
        if (target > bi) {
          log.splice(target, 0, bubble!);
        } else {
          // Nothing active below it — put it back where it was.
          log.splice(bi, 0, bubble!);
        }
      }
    }
    return;
  }
  // Peer-originated. Render a fresh user bubble for it now — same
  // chip-on-bubble treatment as own queued prompts, so the user sees
  // the peer's queued prompt instead of waiting for it to start.
  const text = eventText;
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
    messageId,
    sentAt: enqueuedAt,
    attachments: extractImageAttachments(params.prompt),
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
// hydra-acp/prompt/update). Apply to our local entry so the bubble's
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

// Move a prompt's bubble to the end of the transcript. Used for prompts
// that were held offline: the bubble was appended when the user hit
// send, which was the end of the log as the client knew it then, but
// being offline is exactly the case where the client is behind. Whatever
// the reconnect replays (or the in-flight turn goes on to stream) belongs
// above it, since the prompt is only genuinely submitted once the socket
// is back. Lives here rather than queue.ts to keep the queue.ts → acp.ts
// import direction one-way.
export function reseatBubbleAtEnd(c: ChatState, entry: QueueEntry): void {
  const idx = c.log.findIndex(
    (it) => it.kind === "stream" && it.queueEntry === entry,
  );
  if (idx < 0 || idx === c.log.length - 1) {
    return;
  }
  const [item] = c.log.splice(idx, 1);
  if (item) {
    c.log.push(item);
  }
}

// Move a prompt's bubble to just above any other still-queued bubbles.
// Used when amendQueuedPrompt promotes a queued prompt into a steer of
// the turn that's running right now — unlike reseatBubbleAtEnd, the
// true end of the log is the wrong target here: a sibling prompt that's
// still genuinely queued (hasn't started) belongs BELOW this one, since
// this one's effect lands in the running turn immediately while the
// sibling's turn hasn't opened yet. queuedBoundary() is the same
// boundary insertAboveQueued uses for freshly-arriving turn content, so
// the reseated bubble ends up exactly where that content would anchor.
export function reseatBubbleAboveQueued(c: ChatState, entry: QueueEntry): void {
  const idx = c.log.findIndex(
    (it) => it.kind === "stream" && it.queueEntry === entry,
  );
  if (idx < 0) return;
  const [item] = c.log.splice(idx, 1);
  if (!item) return;
  c.log.splice(queuedBoundary(), 0, item);
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
    // Its own turn is starting, so any deferred re-seat is moot. Clear
    // it rather than acting on it: this notification can arrive after
    // the agent has already begun replying, and re-seating at that
    // point drops the bubble below its own answer.
    entry.reseatAfterCurrentTurn = undefined;
    // This prompt's turn is now the live one — open its spinner
    // (freeze-then-new; see startTurnSpinner). Skip when this very
    // prompt already opened the live spinner at dispatch time
    // (immediate own sends go out "pending" and open it there), or
    // freeze-then-new would stamp a seconds-old block and mint a
    // duplicate. The status flip above moved the queued boundary past
    // this bubble, so the fresh spinner anchors directly under it.
    const owns =
      state.current.spinnerOwner !== undefined &&
      (state.current.spinnerOwner === entry.id ||
        state.current.spinnerOwner === messageId);
    if (!owns) {
      startTurnSpinner(undefined, messageId);
    } else {
      // Prefer the messageId form — the turn_complete stale-completion
      // guard compares owner against completing messageIds.
      state.current.spinnerOwner = messageId;
      // This is prompt_queue/removed{started} — a universal signal that
      // reaches the originator too (unlike prompt_received), so it's
      // the authoritative confirmation that our own optimistically-
      // opened spinner's turn is genuinely under way.
      if (state.current.spinner) {
        state.current.spinner.sending = false;
      }
    }
    markActive();
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

// hydra-acp/prompt_queue/held: the daemon is holding this entry at the
// head of the queue rather than dispatching it, because an
// agent-initiated turn is running (see turn_started/turn_ended above).
// The entry stays in the queue the whole time (cancel/amend still
// work); this only changes how the chip reads, via entry.held.
function onPromptQueueHeld(params: AnyRecord): void {
  if (!state.current) return;
  const messageId = typeof params.messageId === "string" ? params.messageId : "";
  if (!messageId) return;
  const entry = state.current.queueByMessageId.get(messageId);
  if (!entry) return;
  entry.held = true;
}

// hydra-acp/prompt_queue/released: the hold is over. Does NOT imply the
// entry started running: a separate prompt_queue/removed{started}
// still follows for that, handled by onPromptQueueRemoved above.
function onPromptQueueReleased(params: AnyRecord): void {
  if (!state.current) return;
  const messageId = typeof params.messageId === "string" ? params.messageId : "";
  if (!messageId) return;
  const entry = state.current.queueByMessageId.get(messageId);
  if (!entry) return;
  entry.held = false;
}

// hydra-acp/session/armed_tasks_updated: the complete live set of armed
// background tasks (Monitor, backgrounded Bash) after every membership
// change. REPLACE semantics, never merge. count: 0 is meaningful
// ("nothing armed now") and must actively clear any prior badge.
function onArmedTasksUpdated(params: AnyRecord): void {
  if (!state.current) return;
  if (typeof params.count !== "number") return;
  state.current.armedTasks = params.count;
  state.current.armedSince =
    params.count > 0 && typeof params.since === "number"
      ? params.since
      : undefined;
  state.current.armedTaskList = parseArmedTaskList(params.tasks);
}

// Validates each entry rather than a bare cast: this rides straight off the
// wire, and a malformed one (old/mismatched daemon) shouldn't paint garbage
// rows in the tasks block. Exported so bridge.ts can reuse it to seed from
// the attach/new response's armedTaskList snapshot.
export function parseArmedTaskList(raw: unknown): ArmedTask[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ArmedTask[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const r = t as AnyRecord;
    if (typeof r.label !== "string" || typeof r.since !== "number") continue;
    out.push({
      label: r.label,
      since: r.since,
      taskId: typeof r.taskId === "string" ? r.taskId : undefined,
      taskType: typeof r.taskType === "string" ? r.taskType : undefined,
      toolCallId: typeof r.toolCallId === "string" ? r.toolCallId : undefined,
    });
  }
  return out;
}

// session/update kind "_hydra_compaction": agent-side history summarization
// + generation swap, not tied to a turn (can fire while idle, or be
// deferred until the session quiesces). Mirrors the TUI's persistent
// compactionIndicator/transient notify() split (app.ts
// handleCompactionUpdate): a persistent phase while running, cleared on
// swapped/failed/rolled_back with a toast — deliberately not on converged,
// which can arrive before or after the terminal swap.
function onCompactionUpdate(update: AnyRecord): void {
  if (!state.current) return;
  const phase = typeof update.phase === "string" ? update.phase : "";
  switch (phase) {
    case "started":
    case "iteration":
      state.current.compactionPhase = "running";
      break;
    case "deferred":
      state.current.compactionPhase = "deferred";
      break;
    case "swapped":
      state.current.compactionPhase = undefined;
      setState({ banner: { kind: "good", text: "Context compacted." } });
      break;
    case "failed":
      state.current.compactionPhase = undefined;
      setState({ banner: { kind: "bad", text: "Context compaction failed." } });
      break;
    case "rolled_back":
      state.current.compactionPhase = undefined;
      setState({ banner: { kind: "warn", text: "Compaction rolled back." } });
      break;
    default:
      // "converged" and anything unrecognized: leave the persistent phase
      // as-is.
      break;
  }
}

// hydra-acp/prompt/amended is the M1→M2 linkage event. We may have
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

export interface JsonRpcFrame {
  method?: string;
  params?: AnyRecord;
  id?: number | string;
  result?: unknown;
  error?: unknown;
}

// `fromCache` marks frames being replayed OUT of the local history
// cache (routing.ts's hydrateFromCacheThenConnect) rather than arriving
// from the daemon. Everything about handling them is identical except
// that they must not be written back to the cache they just came from —
// see the queueFrameForCache call below.
export function handleNotification(frame: JsonRpcFrame, fromCache = false): void {
  // Any live notification is proof the session is attached and running,
  // regardless of how it got that way (this connection's own
  // session/prompt auto-resurrecting a killed session server-side, a
  // peer's activity, etc.) — bridge/ready is the only other place that
  // flips these, and that only fires on a fresh WS handshake, which a
  // resurrect-via-prompt on an already-open connection never triggers.
  // Without this, the chat header pill (views.ts) would keep reading
  // "cold" forever after a kill-then-resurrect that didn't also drop
  // the WS.
  if (state.current?.cold) {
    state.current.cold = false;
    state.current.ready = true;
  }
  // Hydra-side prompt queue notifications. These don't fit the
  // session/update shape (they're top-level hydra-acp/* methods) so
  // they're dispatched separately, before the session/update guard.
  if (frame.method === "hydra-acp/prompt_queue/added") {
    onPromptQueueAdded((frame.params ?? {}) as AnyRecord);
    return;
  }
  if (frame.method === "hydra-acp/prompt_queue/updated") {
    onPromptQueueUpdated((frame.params ?? {}) as AnyRecord);
    return;
  }
  if (frame.method === "hydra-acp/prompt_queue/removed") {
    onPromptQueueRemoved((frame.params ?? {}) as AnyRecord);
    return;
  }
  if (frame.method === "hydra-acp/prompt_queue/held") {
    onPromptQueueHeld((frame.params ?? {}) as AnyRecord);
    return;
  }
  if (frame.method === "hydra-acp/prompt_queue/released") {
    onPromptQueueReleased((frame.params ?? {}) as AnyRecord);
    return;
  }
  if (frame.method === "hydra-acp/session/armed_tasks_updated") {
    onArmedTasksUpdated((frame.params ?? {}) as AnyRecord);
    return;
  }
  if (frame.method === "hydra-acp/prompt/amended") {
    onPromptAmended((frame.params ?? {}) as AnyRecord);
    return;
  }
  if (frame.method !== "session/update") return;
  const update = (frame.params?.update ?? null) as AnyRecord | null;
  if (!update || typeof update !== "object") return;
  const kind = String(update.sessionUpdate ?? "");
  // Advance the delta-replay cursor so a future reconnect can ask the
  // daemon for a delta (afterMessageId) instead of a full replay.
  // State-kind updates are skipped — they aren't persisted, so the daemon
  // can't use one as a replay cutoff. Mirror the same frame to the local
  // history cache (history-cache.ts) so a cold page load gets the same
  // benefit, not just a live socket drop within one tab session.
  //
  // Two-stage, because messageId names a message and not a frame: the id
  // on the frame in hand is only ever *pending*, and is promoted to the
  // real cursor when a frame with a different id proves its group closed.
  // See ChatState.pendingCursorMessageId for what naming an open group
  // costs.
  //
  // Cached frames deliberately do NOT move it. The cursor decides what the
  // daemon is asked to send, so deriving it from the cache makes the cache
  // authoritative over content it does not actually own: any frame the
  // cache is missing — trimmed by the byte cap, lost to a failed flush,
  // never written because the tab was killed — is then never requested
  // either, and the gap is permanent. That is the whole bug class this
  // module kept producing (three DB_VERSION bumps, a mid-turn trim, and a
  // persisted cursor observed regressing 55 minutes past a position the
  // client demonstrably held). A cold open now paints from cache for
  // speed and asks the daemon for a FULL replay, which replaces that
  // paint wholesale; the cache can be arbitrarily wrong without the
  // transcript inheriting it. Live sockets still advance the cursor
  // normally, so an in-tab reconnect keeps its cheap delta — that path
  // never involved the cache, and never had these bugs.
  if (
    state.current &&
    !fromCache &&
    kind &&
    !STATE_UPDATE_KINDS.has(kind) &&
    typeof update.messageId === "string"
  ) {
    if (update.messageId !== state.current.pendingCursorMessageId) {
      if (state.current.pendingCursorMessageId !== undefined) {
        state.current.lastSeenMessageId = state.current.pendingCursorMessageId;
      }
      state.current.pendingCursorMessageId = update.messageId;
    }
    // The daemon's own per-frame cursor, when it stamps one. No promotion
    // step: it names this frame and nothing else.
    const seq = extractFrameSeq(frame.params);
    if (seq !== undefined) {
      state.current.lastSeenSeq = seq;
    }
    // Frames replayed out of the cache must not be written back into it.
    // hydrateFromCacheThenConnect feeds every cached frame through here,
    // so without this each session open re-queued that session's whole
    // cached transcript for caching — which, before the messageId dedup
    // in mergeAndTrim, appended a second copy of everything on every
    // open. The byte-cap trim then cut into the front of that doubled
    // array, leaving a partial first copy followed by a full second one:
    // a cache that replays out of order and with duplicates.
    // Frames replayed out of the cache never reach here (the fromCache
    // guard above), so this can't write a session's own cache back into
    // itself — which is what used to append a second copy of the
    // transcript on every open.
    queueFrameForCache(state.current.sessionId, frame);
  }
  // Sibling-resolved permission tear-down. Doesn't flip inTurn or
  // route through the per-case switch — it's a transient correlation
  // signal, not session activity.
  if (kind === "permission_resolved") {
    onPermissionResolved(update);
    return;
  }
  // Most update kinds indicate the agent is mid-turn. Mode/model/usage
  // updates can fire outside of a turn (e.g. at attach), so we don't
  // flip inTurn for those. A synthetic agent_message_chunk (e.g. the
  // "Compaction completed." notice session.ts broadcasts after an
  // upstream swap) is likewise not tied to any turn_started/turn_complete
  // pair — treating it as activity would set inTurn with nothing left to
  // ever clear it.
  const updateMeta = (update._meta ?? {}) as AnyRecord;
  const updateHydraMeta = (updateMeta["hydra-acp"] ?? {}) as AnyRecord;
  const isSyntheticChunk =
    kind === "agent_message_chunk" && updateHydraMeta.synthetic === true;
  // Fed to pushChunk's replay-dedup guard below.
  const updateMessageId =
    typeof update.messageId === "string" ? update.messageId : undefined;
  // Daemon record time for this frame (params-level _meta) — the clock
  // the turn-stamps run on, so replayed turns time themselves and not
  // the replay. Undefined on state kinds / live-only frames.
  const recordedAt = extractRecordedAt(frame.params);
  switch (kind) {
    case "prompt_received":
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "tool_call":
    case "tool_call_update":
    case "plan":
      if (!isSyntheticChunk) {
        markActive();
        // Any real update for this turn proves the daemon actually has
        // it, whatever the connection looked like at send time — clear
        // the optimistic "sending" flag so the spinner reads "thinking"
        // (or "working", once tool calls start landing) instead.
        if (state.current?.spinner) {
          state.current.spinner.sending = false;
        }
      }
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
      if (updateHydraMeta.compatFor === "prompt_received") {
        break;
      }
      // Streaming user message from a sibling that *isn't* using
      // prompt_received yet. Suppress own-echo via recentOwnPrompts.
      if (!consumeOwnPromptEcho(update.content)) {
        pushChunk("user", update.content, false, updateMessageId);
      }
      break;
    }
    case "agent_message_chunk":
      pushChunk("agent", update.content, isSyntheticChunk, updateMessageId);
      break;
    case "agent_thought_chunk":
      pushChunk("thought", update.content, false, updateMessageId);
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
    case "_hydra_available_modes_update":
      if (state.current && Array.isArray(update.availableModes)) {
        state.current.modes = update.availableModes as never;
        render();
      }
      break;
    case "_hydra_current_model_update":
      if (state.current) {
        state.current.model = (update.modelId ?? update.currentModelId ?? null) as string | null;
        if (Array.isArray(update.availableModels)) {
          state.current.models = update.availableModels as never;
        }
        render();
      }
      break;
    case "config_option_update":
      if (state.current && Array.isArray(update.configOptions)) {
        state.current.configOptions = update.configOptions as ConfigOption[];
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
      onPromptReceived(update, recordedAt);
      break;
    case "stop":
    case "turn_complete": {
      // Daemon attaches _meta["hydra-acp"].amended = { cancelledMessageId,
      // newMessageId } when the turn ended because an amend cancelled
      // it. Promote the M1 bubble from "cancelled" to "amended" before
      // finalizing so the chip + bubble styling reflect the merge —
      // hydra-acp/prompt/amended is the canonical signal but it isn't
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
      const stopReason =
        typeof update.stopReason === "string" ? update.stopReason : undefined;
      // REMOVED: a "stale completion" guard used to sit here, comparing
      // the live spinner's owner (a PROMPT's messageId) against this
      // update's own messageId and skipping finalizeTurn on a mismatch.
      // That comparison is meaningless — turn_complete.messageId is a
      // fresh id minted for the notification itself
      // (broadcastTurnComplete's own generateMessageId() call,
      // cli/src/core/session.ts), never the prompt's id, so the two are
      // NEVER equal by construction. The guard therefore rejected
      // essentially every legitimate own-turn completion whose spinner
      // had a verified owner — the normal case, not an edge one —
      // leaving the thinking block permanently stuck ("thought" never
      // shown, session list reads warm/idle while the block still
      // spins). Confirmed live on this exact session. If a genuine
      // late/stale turn_complete race needs guarding against later, it
      // needs a real correlation field, not this one.
      finalizeTurn(stopReason, recordedAt);
      break;
    }
    // Agent-initiated ("unsolicited") turn: the agent restarted itself
    // off a finished background task, not a session/prompt we sent.
    // Deliberately NOT turn_complete (see PROTOCOL.md's "Agent-initiated
    // turns"), so we track it via a dedicated flag rather than folding
    // it into the normal turn_complete pairing.
    case "_hydra_turn_started": {
      if (!state.current) break;
      const meta = (update._meta ?? {}) as AnyRecord;
      const hydraMeta = (meta["hydra-acp"] ?? {}) as AnyRecord;
      if (hydraMeta.unsolicited !== true) break;
      const messageId =
        typeof update.messageId === "string" ? update.messageId : undefined;
      if (!messageId) break;
      if (state.current.unsolicitedTurnOpen.has(messageId)) break;
      state.current.unsolicitedTurnOpen.add(messageId);
      markActive();
      const cause = (hydraMeta.cause ?? {}) as AnyRecord;
      const label = typeof cause.label === "string" ? cause.label : undefined;
      insertAboveQueued({
        kind: "system",
        text: label
          ? `agent resumed on its own: background task finished (${label})`
          : "agent resumed on its own",
      });
      break;
    }
    case "_hydra_turn_ended": {
      if (!state.current) break;
      const meta = (update._meta ?? {}) as AnyRecord;
      const hydraMeta = (meta["hydra-acp"] ?? {}) as AnyRecord;
      if (hydraMeta.unsolicited !== true) break;
      const startedMessageId =
        typeof update.startedMessageId === "string"
          ? update.startedMessageId
          : undefined;
      // Ignore a turn_ended that doesn't match any open id: a replay or
      // an unpaired close (e.g. after a daemon restart) must not
      // finalize a turn we never saw open, or double-close one already
      // closed by an earlier turn_ended for a different messageId.
      if (!startedMessageId) break;
      if (!state.current.unsolicitedTurnOpen.has(startedMessageId)) break;
      state.current.unsolicitedTurnOpen.delete(startedMessageId);
      // "superseded" means a prompt took over the still-running agent:
      // it isn't actually done, so don't finalize. The real end arrives
      // via that prompt's own turn_complete (or a later salvage).
      if (hydraMeta.reason === "superseded") break;
      // Other unsolicited turns may still be open (e.g. overlapping
      // onceIdle-swap retries); only finalize once none remain, since
      // finalizeTurn tears down the single shared inTurn/spinner state.
      if (state.current.unsolicitedTurnOpen.size > 0) break;
      finalizeTurn(undefined, recordedAt);
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
    case "_hydra_compaction":
      onCompactionUpdate(update);
      break;
    default:
      // Unknown but harmless; ignore.
      break;
  }
  // After per-case dispatch, surface a "still working" spinner if the
  // turn is active (see the turn-layout model above). Threading the
  // frame's recordedAt keeps a replay-minted fallback spinner on the
  // daemon's clock. finalizeTurn freezes it at the end of the turn.
  if (state.current?.inTurn) {
    ensureSpinner(recordedAt);
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
