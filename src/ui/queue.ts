// Server-driven prompt queue. Hydra owns the per-session FIFO; the
// browser fires session/prompt eagerly and reacts to
// hydra-acp/prompt_queue_added / _updated / _removed notifications
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
import { ensureSpinner } from "./acp.js";
import type { ChatState, QueueEntry } from "./types.js";

interface AmendPromptResult {
  amended: boolean;
  reason: "ok" | "target_completed" | "target_cancelled" | "target_not_found";
  messageId?: string;
}

export function sendPrompt(): void {
  const c = state.current;
  if (!c) return;
  const text = c.composerValue.trim();
  if (!text) return;
  if (!c.ws || c.ws.readyState !== WebSocket.OPEN) {
    c.log.push({
      kind: "error",
      text: "Not connected to session — prompt not sent.",
    });
    c.composerValue = "";
    render();
    return;
  }
  // aheadAtEnqueue is an UX hint — number of entries the user has to
  // wait through before theirs runs. Captured at submit time so the
  // chip doesn't tick down distractingly. The in-flight own entry, if
  // any, is already in c.promptQueue with status "processing", so we
  // only add 1 for inTurn when the active turn is a peer's (nothing in
  // our own queue is processing yet — otherwise we'd double-count).
  // onPromptQueueAdded corrects this against the daemon's authoritative
  // position once the entry is bound.
  const ownActive = c.promptQueue.filter(
    (e) => e.status === "queued" || e.status === "pending" || e.status === "processing",
  ).length;
  const peerInFlight =
    c.inTurn && !c.promptQueue.some((e) => e.status === "processing");
  const ahead = ownActive + (peerInFlight ? 1 : 0);
  const entry: QueueEntry = {
    id: "p_" + Math.random().toString(36).slice(2, 10),
    text,
    // Optimistic status — overwritten by prompt_queue_added (queued or
    // processing depending on position). If hydra rejects the prompt
    // outright the entry stays "pending" and we'll surface the error
    // from the session/prompt response.
    status: ahead > 0 ? "queued" : "pending",
    aheadAtEnqueue: ahead,
  };
  c.promptQueue.push(entry);
  c.log.push({
    kind: "stream",
    role: "user",
    text,
    closed: true,
    queueEntry: entry,
  });
  c.recentOwnPrompts.push({ text, at: Date.now() });
  const cutoff = Date.now() - 60_000;
  c.recentOwnPrompts = c.recentOwnPrompts.filter((p) => p.at >= cutoff).slice(-16);
  // Fire eagerly. Hydra serializes upstream — if there's an in-flight
  // turn this prompt sits at the daemon-side queue until it advances,
  // and prompt_queue_added arrives back with our messageId. We don't
  // need a local chain.
  const promptId = send("session/prompt", {
    sessionId: c.sessionId,
    prompt: [{ type: "text", text }],
  });
  if (promptId !== undefined) {
    c.ownPromptIds.add(String(promptId));
  }
  ensureSpinner();
  pushHistory(c, text);
  c.composerValue = "";
  render();
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
// hydra-acp/cancel_prompt and let the daemon's prompt_queue_removed
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
    send("hydra-acp/cancel_prompt", {
      sessionId: c.sessionId,
      messageId: entry.messageId,
    });
    return;
  }
  entry.status = "cancelled";
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
  if (entry.messageId === undefined) {
    // Not bound yet — apply locally and let the eventual bound state
    // pick up the new text. The user already sees the edit immediately.
    entry.text = trimmed;
    render();
    return;
  }
  send("hydra-acp/update_prompt", {
    sessionId: c.sessionId,
    messageId: entry.messageId,
    prompt: [{ type: "text", text: trimmed }],
  });
}

// Amend the in-flight turn: cancel the head prompt and submit a
// replacement in its place. Falls back to a regular sendPrompt when:
//   1. The daemon doesn't advertise promptAmending (older daemon →
//      hydra-acp/amend_prompt isn't routed at all).
//   2. No in-flight head (currentHeadMessageId undefined) → there's
//      nothing to amend; enqueue as a regular prompt.
//   3. The daemon rejects the amend (target_completed,
//      target_cancelled, target_not_found) — we surface a banner and
//      restore the user's text into the composer so they can retry.
//
// Mirrors the TUI's amendPrompt flow (see cli/src/tui/app.ts:1873).
export function amendPrompt(): void {
  const c = state.current;
  if (!c) return;
  const text = c.composerValue.trim();
  if (!text) return;
  if (!c.ws || c.ws.readyState !== WebSocket.OPEN) {
    c.log.push({
      kind: "error",
      text: "Not connected to session — prompt not sent.",
    });
    c.composerValue = "";
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
  };
  c.promptQueue.push(entry);
  c.log.push({
    kind: "stream",
    role: "user",
    text,
    closed: true,
    queueEntry: entry,
  });
  c.recentOwnPrompts.push({ text, at: Date.now() });
  const cutoff = Date.now() - 60_000;
  c.recentOwnPrompts = c.recentOwnPrompts.filter((p) => p.at >= cutoff).slice(-16);
  const id = send("hydra-acp/amend_prompt", {
    sessionId: c.sessionId,
    targetMessageId: target,
    prompt: [{ type: "text", text }],
  });
  if (id !== undefined) {
    c.responseHandlers.set(String(id), (frame) => {
      onAmendResponse(entry, draft, frame);
    });
  }
  ensureSpinner();
  render();
}

// Handler for hydra-acp/amend_prompt's JSON-RPC response. On success
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
// running turn. Cancels go through hydra-acp/cancel_prompt for bound
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

// Drop any locally-tracked own entries on WS close. The daemon's
// prompt_queue_removed(abandoned) would normally arrive for these, but
// if the WS is gone we'll never see it — clear the chips locally so
// they don't stay pinned as "queued" forever.
export function cancelAllQueued(c: ChatState): void {
  for (const entry of c.promptQueue) {
    if (entry.status !== "done" && entry.status !== "cancelled") {
      entry.status = "cancelled";
      if (entry.messageId !== undefined) {
        c.queueByMessageId.delete(entry.messageId);
      }
    }
  }
}
