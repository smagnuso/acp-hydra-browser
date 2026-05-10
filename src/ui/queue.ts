// Client-side prompt queue. Mirrors what acp-hydra-slack does:
// serialize our own session/prompt requests so they don't all pile
// into hydra's per-session queue at once. Lets us cancel a queued
// prompt locally (without sending session/cancel) and show
// queued/cancelled chips on each user bubble.

import { state } from "./state.js";
import { render } from "./renderer.js";
import { send } from "./bridge.js";
import { ensureSpinner } from "./acp.js";
import type { ChatState, QueueEntry } from "./types.js";

export function sendPrompt(): void {
  const c = state.current;
  if (!c) return;
  const text = c.composerValue.trim();
  if (!text) return;
  // Build a queue entry. Status starts "queued" if anything is ahead
  // of us — either another local prompt still working through the
  // chain, or the agent is mid-turn from a sibling client. Otherwise
  // it'll flip to "processing" the moment its chain.then fires.
  const ahead = c.promptQueue.length;
  const aheadActive = c.inTurn ? 1 : 0;
  const totalAhead = ahead + aheadActive;
  const entry: QueueEntry = {
    id: "p_" + Math.random().toString(36).slice(2, 10),
    text,
    status: totalAhead > 0 ? "queued" : "pending",
    aheadAtEnqueue: totalAhead,
    cancelled: false,
    started: false,
    waitResolver: null,
  };
  c.promptQueue.push(entry);
  // Optimistic local rendering: push a fresh user bubble (no merging
  // with prior user bubble) so each prompt has its own queue chip.
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
  scheduleSendPrompt(entry);
  c.composerValue = "";
  render();
}

// Serialize own-prompt sends through state.current.promptChain so
// each one waits for the agent to be idle before its session/prompt
// fires. Cancellation is purely local while status is "queued"/
// "pending"; once the chain has actually sent the prompt, cancel
// falls through to the running turn (handled by the Stop button).
function scheduleSendPrompt(entry: QueueEntry): void {
  const c = state.current!;
  const previous = c.promptChain ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      if (entry.cancelled) {
        return;
      }
      try {
        // Wait for the WS bridge handshake before doing anything else
        // — this is what makes "click a cold session and start typing"
        // work (the prompt waits for resurrection to finish, then
        // proceeds normally).
        await waitForReadyOrCancel(entry);
        if (entry.cancelled) return;
        await waitForIdleOrCancel(entry);
        if (entry.cancelled) return;
        entry.started = true;
        entry.status = "processing";
        // Optimistic: mark inTurn so a subsequent prompt enqueued
        // before prompt_received arrives still sees us as busy and
        // queues correctly behind this one.
        c.inTurn = true;
        // Pull the queued user bubble down to the end of the log so
        // it anchors the new turn — regardless of what got appended
        // below it while it was waiting (e.g. the tail of the prior
        // turn's tool output or agent text). Without this, the bubble
        // can end up wedged in the middle of the prior turn's
        // content and look like it stayed where the user typed it.
        const idx = c.log.findIndex(
          (e) => e.kind === "stream" && e.role === "user" && e.queueEntry === entry,
        );
        if (idx >= 0 && idx < c.log.length - 1) {
          const item = c.log.splice(idx, 1)[0];
          if (item) c.log.push(item);
        }
        // Surface the "thinking…" spinner immediately — gives the user
        // visible feedback before any frame comes back from the agent.
        // Same intent as acp-hydra-slack's ensureSpinner-on-send.
        ensureSpinner();
        render();
        const promptId = send("session/prompt", {
          sessionId: c.sessionId,
          prompt: [{ type: "text", text: entry.text }],
        });
        // Hydra omits the originator from turn_complete fan-out, so
        // the JSON-RPC response to *this* request is our turn-end
        // signal. handleFrame's response branch sees the id, calls
        // finalizeTurn (which drains idle listeners), and the next
        // wait below resolves.
        if (promptId !== undefined) {
          c.ownPromptIds.add(String(promptId));
        }
        // Wait for the next idle transition. This keeps the chain
        // head reserved until our turn wraps so the next queued
        // entry doesn't overlap.
        await waitForIdleOrCancel(entry);
      } finally {
        const idx = c.promptQueue.indexOf(entry);
        if (idx >= 0) {
          c.promptQueue.splice(idx, 1);
        }
        if (entry.cancelled && !entry.started) {
          entry.status = "cancelled";
        } else {
          entry.status = "done";
        }
        render();
      }
    });
  c.promptChain = next;
}

// Wait for either the next idle transition OR for this entry to be
// cancelled. cancelQueuedPrompt invokes entry.waitResolver to wake
// the awaiter immediately, regardless of agent state.
function waitForIdleOrCancel(entry: QueueEntry): Promise<void> {
  return waitOnListOrCancel(entry, state.current!.idleListeners, () => state.current!.inTurn);
}

// Same shape, but waits for the WS bridge to finish its handshake
// (so session/prompt actually reaches hydra). Lets a user click a
// cold-session card and start typing immediately; the prompt sits
// in the chain until bridge/ready arrives.
function waitForReadyOrCancel(entry: QueueEntry): Promise<void> {
  return waitOnListOrCancel(entry, state.current!.readyListeners, () => !state.current!.ready);
}

function waitOnListOrCancel(
  entry: QueueEntry,
  list: Array<() => void>,
  shouldWait: () => boolean,
): Promise<void> {
  if (entry.cancelled) {
    return Promise.resolve();
  }
  if (!shouldWait()) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const listener = (): void => {
      entry.waitResolver = null;
      resolve();
    };
    list.push(listener);
    entry.waitResolver = (): void => {
      const idx = list.indexOf(listener);
      if (idx >= 0) list.splice(idx, 1);
      entry.waitResolver = null;
      resolve();
    };
  });
}

// Cancel a prompt that's still in our queue. If it hasn't started
// yet, the chain will see the cancelled flag and bail before sending
// to hydra. If it's already running, the caller should also send
// session/cancel via the Stop button.
export function cancelQueuedPrompt(entry: QueueEntry): void {
  entry.cancelled = true;
  if (entry.waitResolver) {
    entry.waitResolver();
  }
}

// Stop button: cancel anything still queued locally (those don't
// need a session/cancel since we never sent them to hydra) AND tell
// the agent to abort the running turn (if any).
export function sendCancel(): void {
  const c = state.current;
  if (!c) return;
  let cancelledLocal = 0;
  for (const entry of c.promptQueue) {
    if (!entry.started && !entry.cancelled) {
      entry.cancelled = true;
      if (entry.waitResolver) entry.waitResolver();
      cancelledLocal += 1;
    }
  }
  if (c.inTurn) {
    send("session/cancel", { sessionId: c.sessionId });
  }
  if (cancelledLocal > 0) {
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

// Cancel every still-pending entry in the queue. Used when the WS
// closes mid-flight — without this, the chain would hang waiting for
// ready/idle that won't arrive.
export function cancelAllQueued(c: ChatState): void {
  for (const entry of c.promptQueue) {
    if (!entry.cancelled) cancelQueuedPrompt(entry);
  }
}
