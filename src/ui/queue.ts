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

import { state } from "./state.js";
import { render } from "./renderer.js";
import { notify, send } from "./bridge.js";
import { ensureSpinner } from "./acp.js";
import type { ChatState, QueueEntry } from "./types.js";

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
  c.composerValue = "";
  render();
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
