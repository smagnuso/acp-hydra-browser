// Server-driven prompt queue. Hydra owns the per-session FIFO; the
// browser fires session/prompt eagerly and reacts to
// hydra-acp/prompt_queue/added / _updated / _removed notifications
// (handled in acp.ts) to drive each bubble's queue chip state.
//
// What stays browser-side:
//   - The optimistic user bubble + chip rendering (each prompt gets its
//     own LogItem with a QueueEntry; the chip shows queued / processing
//     / cancelled based on entry.status).
//   - A FIFO over unbound entries so we can bind hydra's messageId to
//     the right local entry when prompt_queue_added arrives — hydra
//     serializes session/prompt arrivals so the Nth added-with-our-
//     originator event corresponds to the Nth still-unbound entry.

import { state, setState } from "./state.js";
import { render } from "./renderer.js";
import { notify, send } from "./bridge.js";
import {
  ensureSpinner,
  markActive,
  reseatBubbleAtEnd,
  startTurnSpinner,
} from "./acp.js";
import { jumpToBottom } from "./views.js";
import { clearDraft, queueDraftWrite } from "./composer-draft.js";
import { removeOfflineEntry, saveOfflineEntry } from "./offline-queue.js";
import type { Attachment, ChatState, QueueEntry } from "./types.js";

// Build an ACP ContentBlock[] for session/prompt et al. Text block is
// omitted when empty so an image-only send doesn't ship a stray blank
// text block.
function buildContentBlocks(
  text: string,
  attachments: Attachment[],
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  if (text) {
    blocks.push({ type: "text", text });
  }
  for (const a of attachments) {
    blocks.push({ type: "image", data: a.data, mimeType: a.mimeType });
  }
  return blocks;
}

interface AmendPromptResult {
  amended: boolean;
  reason: "ok" | "target_completed" | "target_cancelled" | "target_not_found";
  messageId?: string;
}

export function sendPrompt(): void {
  const c = state.current;
  if (!c) return;
  const text = c.composerValue.trim();
  const attachments = c.attachments;
  if (!text && attachments.length === 0) return;
  if (dispatchPrompt(c, text, { attachments })) {
    c.composerValue = "";
    c.attachments = [];
    clearDraft(c.sessionId);
  }
  render();
}

// Fire a fixed slash command (e.g. a `/hydra workspace <verb>` action
// button) through the same eager-send path as a typed prompt, without
// touching the composer's draft text or recall history.
export function sendWorkspaceCommand(
  verb: "start" | "sync" | "stop" | "apply",
): void {
  const c = state.current;
  if (!c) return;
  dispatchPrompt(c, `/hydra workspace ${verb}`, { addToHistory: false });
  render();
}

// Fire /hydra compact, same eager-send path. The confirm prompt and the
// compactionPhase no-op guard live in views.ts alongside the pill's click
// handler; this is just the dispatch.
export function sendCompactCommand(): void {
  const c = state.current;
  if (!c) return;
  dispatchPrompt(c, "/hydra compact", { addToHistory: false });
  render();
}

function dispatchPrompt(
  c: ChatState,
  text: string,
  opts: { addToHistory?: boolean; attachments?: Attachment[] } = {},
): boolean {
  const attachments = opts.attachments ?? [];
  // No connection right now (offline, bad network, or the app just
  // launched cold before the WS came up) — hold it locally instead of
  // failing outright. The entry still gets a bubble + chip, just with
  // "offline" status; flushOfflineQueue sends it for real once the
  // socket comes up, whether that's a live reconnect or the next time
  // the app runs. See offline-queue.ts for the persistence side.
  //
  // connectionHealthy (bridge.ts's heartbeat) is the primary signal —
  // readyState and navigator.onLine can both keep saying "fine" well
  // after the connection is actually dead (navigator.onLine in
  // particular is known-unreliable on iOS Safari, especially in
  // standalone PWA mode, and didn't catch this in practice). All three
  // are checked anyway since any one of them being bad is reason enough
  // to hold rather than risk a send into a dead pipe.
  const offline =
    !c.connectionHealthy || !navigator.onLine || !c.ws || c.ws.readyState !== WebSocket.OPEN;
  // aheadAtEnqueue is an UX hint — number of entries the user has to
  // wait through before theirs runs. Captured at submit time so the
  // chip doesn't tick down distractingly. The in-flight own entry, if
  // any, is already in c.promptQueue with status "processing", so we
  // only add 1 for inTurn when the active turn is a peer's (nothing in
  // our own queue is processing yet — otherwise we'd double-count).
  // onPromptQueueAdded corrects this against the daemon's authoritative
  // position once the entry is bound. Meaningless while offline — there's
  // no server-side queue to be ahead in — so it's just 0 there.
  const ownActive = c.promptQueue.filter(
    (e) => e.status === "queued" || e.status === "pending" || e.status === "processing",
  ).length;
  const peerInFlight =
    c.inTurn && !c.promptQueue.some((e) => e.status === "processing");
  const ahead = offline ? 0 : ownActive + (peerInFlight ? 1 : 0);
  const entry: QueueEntry = {
    id: "p_" + Math.random().toString(36).slice(2, 10),
    text,
    // Optimistic status — overwritten by prompt_queue_added (queued or
    // processing depending on position). If hydra rejects the prompt
    // outright the entry stays "pending" and we'll surface the error
    // from the session/prompt response.
    status: offline ? "offline" : ahead > 0 ? "queued" : "pending",
    aheadAtEnqueue: ahead,
    attachments: attachments.length > 0 ? attachments : undefined,
  };
  c.promptQueue.push(entry);
  c.log.push({
    kind: "stream",
    role: "user",
    text,
    closed: true,
    queueEntry: entry,
    attachments: entry.attachments,
  });
  c.recentOwnPrompts.push({ text, at: Date.now() });
  const cutoff = Date.now() - 60_000;
  c.recentOwnPrompts = c.recentOwnPrompts.filter((p) => p.at >= cutoff).slice(-16);
  if (offline) {
    void saveOfflineEntry(c.sessionId, { id: entry.id, text, attachments: entry.attachments });
    jumpToBottom(c);
    if (opts.addToHistory ?? true) {
      pushHistory(c, text);
    }
    return true;
  }
  // Fire eagerly. Hydra serializes upstream — if there's an in-flight
  // turn this prompt sits at the daemon-side queue until it advances,
  // and prompt_queue_added arrives back with our messageId. We don't
  // need a local chain.
  const promptId = send("session/prompt", {
    sessionId: c.sessionId,
    prompt: buildContentBlocks(text, attachments),
  });
  if (promptId !== undefined) {
    c.ownPromptIds.add(String(promptId));
  }
  // "pending" means we believe nothing runs ahead of this prompt — its
  // turn is opening right now, so anchor its thinking block under the
  // bubble just pushed (startTurnSpinner freezes any stale predecessor
  // in place first). Owner-tagged so the eventual
  // prompt_queue/removed{started} for this same prompt doesn't
  // double-open; if the daemon instead demotes it to queued (a turn
  // was really still running), the pending→queued flip discards this
  // spinner as a false start. A "queued" send changes nothing about
  // the running turn, so it just keeps whatever marker is live.
  if (entry.status === "pending") {
    startTurnSpinner(undefined, entry.id);
  } else {
    ensureSpinner();
  }
  markActive();
  jumpToBottom(c);
  if (opts.addToHistory ?? true) {
    pushHistory(c, text);
  }
  return true;
}

// Dispatches every locally-held "offline" entry for real, in submission
// order, now that the socket is up — called from bridge.ts's bridge/ready
// handler, which covers both a live reconnect (entries already in
// c.promptQueue) and a fresh app launch (routing.ts's
// hydrateFromCacheThenConnect rehydrates persisted entries into
// c.promptQueue before the first connect). Mutates each entry in place
// rather than re-running dispatchPrompt so no duplicate bubble/log
// entry gets created for what the user already sees on screen.
export function flushOfflineQueue(c: ChatState): void {
  let flushed = false;
  // First flushed entry that went out believing it's next up — the one
  // whose turn is opening; later ones queue behind it.
  let opener: QueueEntry | null = null;
  for (const entry of c.promptQueue) {
    if (entry.status !== "offline") continue;
    if (!c.ws || c.ws.readyState !== WebSocket.OPEN) break;
    flushed = true;
    const ownActive = c.promptQueue.filter(
      (e) => e.status === "queued" || e.status === "pending" || e.status === "processing",
    ).length;
    const peerInFlight =
      c.inTurn && !c.promptQueue.some((e) => e.status === "processing");
    const ahead = ownActive + (peerInFlight ? 1 : 0);
    entry.aheadAtEnqueue = ahead;
    entry.status = ahead > 0 ? "queued" : "pending";
    if (!opener && entry.status === "pending") {
      opener = entry;
    }
    const promptId = send("session/prompt", {
      sessionId: c.sessionId,
      prompt: buildContentBlocks(entry.text, entry.attachments ?? []),
    });
    if (promptId !== undefined) {
      c.ownPromptIds.add(String(promptId));
    }
    void removeOfflineEntry(c.sessionId, entry.id);
    // Re-seat now, which is correct and immediate whenever nothing was
    // mid-turn at reconnect. Entries flush in promptQueue order, so
    // relative order among several held prompts is preserved.
    reseatBubbleAtEnd(c, entry);
    // Reconnecting mid-turn is the harder case: that turn can still
    // append new log items (tool calls, a fresh bubble after one) below
    // the bubble just re-seated. Arm a second re-seat for when that turn
    // finishes. Only when a turn is actually in flight, or the flag
    // would sit unused and later fire against an unrelated turn.
    if (c.inTurn) {
      entry.reseatAfterCurrentTurn = true;
    }
  }
  if (flushed) {
    // Same open/keep split as dispatchPrompt: a pending head opens its
    // turn's thinking block under its bubble; queued-behind flushes
    // leave the running turn's marker alone.
    if (opener) {
      startTurnSpinner(undefined, opener.id);
    } else {
      ensureSpinner();
    }
    markActive();
  }
}

// Append a submitted prompt to the up/down recall history. Most-recent
// first; dedup consecutive duplicates so spamming the same prompt
// doesn't fill the buffer with copies. Resets the nav cursor — sending
// always implies "I'm done browsing history."
const HISTORY_MAX = 100;
function pushHistory(c: ChatState, text: string): void {
  if (c.history[0] !== text) {
    c.history.unshift(text);
    if (c.history.length > HISTORY_MAX) {
      c.history.length = HISTORY_MAX;
    }
  }
  c.historyIndex = null;
  c.historyDraft = null;
}

// Drop a queued prompt. If the entry has been bound to a server
// messageId (the common case once prompt_queue_added has arrived), fire
// hydra-acp/prompt/cancel and let the daemon's prompt_queue_removed
// echo drive the local state transition. If the entry isn't bound yet
// (sub-millisecond race between submit and prompt_queue_added),
// optimistically mark cancelled so the chip reflects the user's intent
// immediately — the eventual prompt_queue_added will still bind, and
// the entry will pick up the daemon's authoritative status from
// prompt_queue_removed shortly after.
export function cancelQueuedPrompt(entry: QueueEntry): void {
  const c = state.current;
  if (!c) return;
  if (entry.messageId !== undefined) {
    send("hydra-acp/prompt/cancel", {
      sessionId: c.sessionId,
      messageId: entry.messageId,
    });
    return;
  }
  // Offline-held entries were never sent, so there's nothing server-side
  // to cancel — just drop the local hold so it doesn't get flushed on
  // the next reconnect.
  if (entry.status === "offline") {
    void removeOfflineEntry(c.sessionId, entry.id);
  }
  entry.status = "cancelled";
  render();
}

// Promote an accidentally-queued prompt into an amendment of the
// running turn: steer the live turn with its content now instead of
// waiting out the queue. The entry itself is repurposed as the
// optimistic amend entry — same bubble, moved to the bottom (an
// amendment is the newest user input), re-tagged with the "+" amend
// marker — and its old queue slot is cancelled server-side. From there
// it rides the exact composer-Amend plumbing (sendSteerRequest):
// "injected" folds it into the live turn, "startedNewTurn" binds it to
// the daemon's replacement entry via prompt_queue_added's
// awaiting-FIFO pass, and a failure lands the text in the composer via
// the shared rollback so nothing is lost.
export function amendQueuedPrompt(entry: QueueEntry): void {
  const c = state.current;
  if (!c) return;
  if (!c.daemonSupportsAmend || c.currentHeadMessageId === undefined) return;
  if (entry.messageId === undefined || entry.status !== "queued") return;
  // Same no-hold reasoning as amendPrompt: an amend targets a specific
  // in-flight turn, so "retry when connectivity returns" has no
  // sensible meaning. Leave the entry queued instead — that state is
  // still valid — and let the user retry.
  if (!c.connectionHealthy || !navigator.onLine || !c.ws || c.ws.readyState !== WebSocket.OPEN) {
    setState({
      banner: { kind: "warn", text: "Not connected — still queued, try again in a moment." },
    });
    return;
  }
  const target = c.currentHeadMessageId;
  const oldMessageId = entry.messageId;
  // Unmap before cancelling so the prompt_queue_removed{cancelled} echo
  // for the old slot finds nothing and no-ops — the repurposed entry
  // must never render as a struck-through cancelled bubble.
  c.queueByMessageId.delete(oldMessageId);
  entry.messageId = undefined;
  entry.status = "pending";
  entry.amendsMessageId = target;
  entry.aheadAtEnqueue = 0;
  reseatBubbleAtEnd(c, entry);
  send("hydra-acp/prompt/cancel", {
    sessionId: c.sessionId,
    messageId: oldMessageId,
  });
  sendSteerRequest(entry, entry.text, target, entry.text);
  jumpToBottom(c);
  render();
}

// Rewrite a queued prompt's text. Same binding gate as cancel — only
// possible once the entry has a messageId. If hydra returns
// already_running, the entry is past the head and the edit won't take;
// the eventual prompt_queue_updated echo (which won't fire in the
// rejected case) is what locks in the change.
export function updateQueuedPrompt(entry: QueueEntry, text: string): void {
  const c = state.current;
  if (!c) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  // Held offline: there's no server-side entry to update, but the
  // persisted copy has to track the edit too, or relaunching the app
  // would flush the original pre-edit text.
  if (entry.status === "offline") {
    entry.text = trimmed;
    void saveOfflineEntry(c.sessionId, {
      id: entry.id,
      text: trimmed,
      attachments: entry.attachments,
    });
    render();
    return;
  }
  if (entry.messageId === undefined) {
    // Not bound yet — apply locally and let the eventual bound state
    // pick up the new text. The user already sees the edit immediately.
    entry.text = trimmed;
    render();
    return;
  }
  send("hydra-acp/prompt/update", {
    sessionId: c.sessionId,
    messageId: entry.messageId,
    prompt: buildContentBlocks(trimmed, entry.attachments ?? []),
  });
}

// Amend the in-flight turn. Falls back to a regular sendPrompt when:
//   1. The daemon doesn't advertise prompt.amending (older daemon —
//      neither hydra-acp/prompt/amend nor _session/steering exist to
//      route this onto).
//   2. No in-flight head (currentHeadMessageId undefined) → there's
//      nothing to amend; enqueue as a regular prompt.
//
// Otherwise this tries _session/steering first — a pre-standard
// extension that injects the replacement into the SAME running turn
// (preserving the agent's partial progress) when the live agent
// supports it natively; hydra itself decides whether to forward
// natively or fall back to cancel-and-resubmit, so we don't need to
// know which happened. Only a live MethodNotFound (an old daemon that
// predates _session/steering) drops back to the legacy
// hydra-acp/prompt/amend cancel-and-resubmit call. A rejection that
// isn't MethodNotFound (target_completed etc.) surfaces a banner and
// restores the user's text into the composer so they can retry.
//
// Mirrors the TUI's steerPrompt flow (see cli/src/tui/app.ts:6653).
export function amendPrompt(): void {
  const c = state.current;
  if (!c) return;
  const text = c.composerValue.trim();
  const attachments = c.attachments;
  if (!text && attachments.length === 0) return;
  // Same connectionHealthy/navigator.onLine reasoning as dispatchPrompt
  // — a WebSocket can sit in "OPEN" for a while after the connection's
  // actually gone. Amend targets a specific in-flight messageId rather
  // than just enqueueing, so unlike a regular send there's no sensible
  // "hold and retry later" for it — the target may not even still be
  // the head by the time connectivity returns. Surface the failure
  // instead.
  if (!c.connectionHealthy || !navigator.onLine || !c.ws || c.ws.readyState !== WebSocket.OPEN) {
    c.log.push({
      kind: "error",
      text: "Not connected to session — prompt not sent.",
    });
    c.composerValue = "";
    c.attachments = [];
    clearDraft(c.sessionId);
    render();
    return;
  }
  if (!c.daemonSupportsAmend || c.currentHeadMessageId === undefined) {
    sendPrompt();
    return;
  }
  const target = c.currentHeadMessageId;
  // Stash the typed text up front so we can restore it on rejection.
  const draft = c.composerValue;
  c.composerValue = "";
  c.attachments = [];
  clearDraft(c.sessionId);
  pushHistory(c, text);
  // Add an optimistic local entry mirroring sendPrompt's behavior, but
  // pre-tagged with amendsMessageId so the bubble paints the "+"
  // chip the moment the user clicks Amend instead of waiting for the
  // round-trip. The messageId binding still happens on
  // prompt_queue_added — and the daemon will set the same
  // amendsMessageId via _meta.amending, which we leave idempotent.
  const entry: QueueEntry = {
    id: "p_" + Math.random().toString(36).slice(2, 10),
    text,
    status: "pending",
    aheadAtEnqueue: 0,
    amendsMessageId: target,
    attachments: attachments.length > 0 ? attachments : undefined,
  };
  c.promptQueue.push(entry);
  c.log.push({
    kind: "stream",
    role: "user",
    text,
    closed: true,
    queueEntry: entry,
    attachments: entry.attachments,
  });
  c.recentOwnPrompts.push({ text, at: Date.now() });
  const cutoff = Date.now() - 60_000;
  c.recentOwnPrompts = c.recentOwnPrompts.filter((p) => p.at >= cutoff).slice(-16);
  ensureSpinner();
  markActive();
  jumpToBottom(c);
  sendSteerRequest(entry, draft, target, text);
  render();
}

interface SteerResult {
  outcome?: "injected" | "startedNewTurn" | "promptRequired" | "failed";
  reason?: string;
}

function sendSteerRequest(
  entry: QueueEntry,
  draftText: string,
  target: string,
  text: string,
): void {
  const c = state.current;
  if (!c) return;
  const id = send("_session/steering", {
    sessionId: c.sessionId,
    prompt: buildContentBlocks(text, entry.attachments ?? []),
  });
  if (id !== undefined) {
    c.responseHandlers.set(String(id), (frame) => {
      onSteerResponse(entry, draftText, target, text, frame);
    });
  }
}

// Handler for _session/steering's JSON-RPC response.
function onSteerResponse(
  entry: QueueEntry,
  draftText: string,
  target: string,
  text: string,
  frame: { result?: unknown; error?: unknown },
): void {
  const c = state.current;
  if (!c) return;
  if (frame.error) {
    const code = (frame.error as { code?: number } | undefined)?.code;
    if (code === -32601) {
      // Stale daemon that predates _session/steering — fall back to
      // the legacy cancel-and-resubmit amend, reusing the same
      // optimistic entry so the bubble doesn't flicker.
      sendLegacyAmend(entry, draftText, target, text);
      return;
    }
    rollbackAmend(c, entry, draftText);
    setState({
      banner: {
        kind: "bad",
        text: `steering failed: ${tryGetErrorMessage(frame.error)}`,
      },
    });
    return;
  }
  const res = (frame.result ?? {}) as SteerResult;
  if (res.outcome === "injected") {
    // Nothing was enqueued server-side — no prompt_queue_added/removed
    // pair will ever arrive to bind this entry. It's already part of
    // the running turn; finalizeTurn flips any "processing" entry to
    // "done" when that turn ends, same as a normally-bound entry.
    entry.status = "processing";
    render();
    return;
  }
  if (res.outcome === "startedNewTurn") {
    // Either native forward's own cancel-resubmit or hydra's
    // synthesized fallback ran server-side — both genuinely create a
    // new queue entry, so leave this one as-is; prompt_queue_added
    // will bind it exactly like a normal amend success.
    return;
  }
  // "failed" (native forward errored — resolved, not thrown, per
  // codex-acp's own convention), "promptRequired", or an unrecognized
  // outcome.
  rollbackAmend(c, entry, draftText);
  setState({
    banner: { kind: "warn", text: "steering failed" },
  });
}

function sendLegacyAmend(
  entry: QueueEntry,
  draftText: string,
  target: string,
  text: string,
): void {
  const c = state.current;
  if (!c) return;
  const id = send("hydra-acp/prompt/amend", {
    sessionId: c.sessionId,
    targetMessageId: target,
    prompt: buildContentBlocks(text, entry.attachments ?? []),
  });
  if (id !== undefined) {
    c.responseHandlers.set(String(id), (frame) => {
      onAmendResponse(entry, draftText, frame);
    });
  }
}

// Handler for hydra-acp/prompt/amend's JSON-RPC response. On success
// we let the prompt_queue_added / turn_complete plumbing do its job —
// the binding into messageId happens through the regular FIFO. On
// rejection we drop the optimistic entry, restore the draft text, and
// surface a banner. Mirrors the TUI's amendPrompt(...).then(...) arm.
function onAmendResponse(
  entry: QueueEntry,
  draftText: string,
  frame: { result?: unknown; error?: unknown },
): void {
  const c = state.current;
  if (!c) return;
  if (frame.error) {
    rollbackAmend(c, entry, draftText);
    setState({
      banner: {
        kind: "bad",
        text: `amend failed: ${tryGetErrorMessage(frame.error)}`,
      },
    });
    return;
  }
  const res = (frame.result ?? {}) as Partial<AmendPromptResult>;
  if (res.amended && res.reason === "ok") {
    // success — wait for prompt_queue_added to bind messageId and
    // adopt the amending hint from _meta. No further action here.
    return;
  }
  rollbackAmend(c, entry, draftText);
  let msg = "amend rejected";
  if (res.reason === "target_completed") {
    msg = "previous response finished — press Send to send as a new turn";
  } else if (res.reason === "target_cancelled") {
    msg = "amend skipped — previous turn was cancelled";
  } else if (res.reason === "target_not_found") {
    msg = "amend skipped — no matching prompt";
  }
  setState({ banner: { kind: "warn", text: msg } });
}

function rollbackAmend(
  c: ChatState,
  entry: QueueEntry,
  draftText: string,
): void {
  // Drop the optimistic bubble and matching queue entry, and put the
  // draft text back so the user can retry / send-as-new.
  const idx = c.promptQueue.indexOf(entry);
  if (idx >= 0) {
    c.promptQueue.splice(idx, 1);
  }
  c.log = c.log.filter(
    (e) =>
      !(
        e.kind === "stream" &&
        e.role === "user" &&
        e.queueEntry === entry
      ),
  );
  c.composerValue = draftText;
  c.attachments = entry.attachments ?? [];
  queueDraftWrite(c.sessionId, draftText);
  render();
}

function tryGetErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "unknown error";
}

// Cancel just the in-flight turn without touching the queue. The
// daemon's drainQueue will resume with the next queued entry once the
// agent acknowledges the cancel.
export function cancelProcessingPrompt(): void {
  const c = state.current;
  if (!c || !c.inTurn) return;
  notify("session/cancel", { sessionId: c.sessionId });
}

// Stop button: drop everything queued AND tell the agent to abort the
// running turn. Cancels go through hydra-acp/prompt/cancel for bound
// entries (so peers see the right prompt_queue_removed events) and
// fall back to a local mark for unbound ones.
export function sendCancel(): void {
  const c = state.current;
  if (!c) return;
  let touched = false;
  for (const entry of c.promptQueue) {
    if (entry.status === "queued" || entry.status === "pending") {
      cancelQueuedPrompt(entry);
      touched = true;
    }
  }
  if (c.inTurn) {
    notify("session/cancel", { sessionId: c.sessionId });
  }
  if (touched) {
    render();
  }
}

export function sendSetMode(modeId: string): void {
  if (!state.current) return;
  send("session/set_mode", { sessionId: state.current.sessionId, modeId });
}

export function sendSetModel(modelId: string): void {
  if (!state.current) return;
  send("session/set_model", { sessionId: state.current.sessionId, modelId });
}

// Generic config-option setter (model/mode/agent, or whatever the agent
// advertises on its own, e.g. effort). The reply carries the full
// rebuilt configOptions snapshot, but no config_option_update follows
// it (see PROTOCOL.md's "A setter reply is state, not news about the
// id you set"), so we apply the reply here rather than waiting on a
// notification.
export function sendSetConfigOption(configId: string, value: string): void {
  const c = state.current;
  if (!c) return;
  const id = send("session/set_config_option", {
    sessionId: c.sessionId,
    configId,
    value,
  });
  if (id === undefined) return;
  c.responseHandlers.set(String(id), (frame) => {
    const list = (frame.result as { configOptions?: unknown } | undefined)
      ?.configOptions;
    if (Array.isArray(list) && state.current === c) {
      c.configOptions = list as ChatState["configOptions"];
      render();
    }
  });
}

// Drop any locally-tracked own entries on WS close. The daemon's
// prompt_queue_removed(abandoned) would normally arrive for these, but
// if the WS is gone we'll never see it — clear the chips locally so
// they don't stay pinned as "queued" forever.
export function cancelAllQueued(c: ChatState): void {
  for (const entry of c.promptQueue) {
    if (entry.status !== "done" && entry.status !== "cancelled") {
      if (entry.status === "offline") {
        void removeOfflineEntry(c.sessionId, entry.id);
      }
      entry.status = "cancelled";
      if (entry.messageId !== undefined) {
        c.queueByMessageId.delete(entry.messageId);
      }
    }
  }
}

// Same idea, but only for entries the daemon never acknowledged (no
// messageId bound yet) — used on a WS drop where the client is about to
// attempt a delta (afterMessageId) reconnect and keeps its transcript,
// including these bubbles' queueEntry references, intact. Marking a
// *bound* entry cancelled here would be a guess: the daemon may still be
// processing it, and the eventual after_message replay (or the attach
// response's queue snapshot, see hydrateQueueFromSnapshot) will report
// its true status — cancelling it locally first would show a false
// strikethrough on a prompt that's actually still running. "offline"
// entries are deliberately excluded too — unlike a prompt that was
// actually transmitted and lost, these were never sent at all, which is
// exactly the case they exist to survive; flushOfflineQueue re-dispatches
// them once the reconnect succeeds instead.
export function cancelUnboundQueued(c: ChatState): void {
  for (const entry of c.promptQueue) {
    if (
      entry.messageId === undefined &&
      entry.status !== "done" &&
      entry.status !== "cancelled" &&
      entry.status !== "offline"
    ) {
      entry.status = "cancelled";
    }
  }
}
