import { test } from "node:test";
import assert from "node:assert/strict";

// See acp-edit-diff.test.ts for why this stub is needed before the static
// imports below run.
(globalThis as { document?: unknown }).document ??= {
  addEventListener() {},
  removeEventListener() {},
};

const { cancelUnboundQueued } = await import("../src/ui/queue.js");
import type { ChatState, QueueEntry } from "../src/ui/types.js";

function chatWith(entries: QueueEntry[]): ChatState {
  return { promptQueue: entries } as unknown as ChatState;
}

function entry(status: QueueEntry["status"], messageId?: string): QueueEntry {
  return { id: "e_" + status, text: status, status, aheadAtEnqueue: 0, messageId };
}

// A steer answered `injected` runs inside the turn already in flight, so
// the daemon enqueues nothing for it and no prompt_queue_added ever binds
// it a messageId. Cancelling it on a WS drop struck it through as
// cancelled mid-turn while the agent was still visibly acting on it.
test("a confirmed steer survives a reconnect", () => {
  const injected = entry("processing");
  const c = chatWith([injected]);
  cancelUnboundQueued(c);
  assert.equal(injected.status, "processing");
});

// The case cancelUnboundQueued actually exists for: submitted, never
// acknowledged, so the drop may well have eaten it.
test("an unacknowledged send is still cancelled", () => {
  const pending = entry("pending");
  const queued = entry("queued");
  const c = chatWith([pending, queued]);
  cancelUnboundQueued(c);
  assert.equal(pending.status, "cancelled");
  assert.equal(queued.status, "cancelled");
});

test("bound, terminal and offline entries are left alone", () => {
  const bound = entry("queued", "m_1");
  const done = entry("done");
  const offline = entry("offline");
  const already = entry("cancelled");
  const c = chatWith([bound, done, offline, already]);
  cancelUnboundQueued(c);
  assert.equal(bound.status, "queued");
  assert.equal(done.status, "done");
  assert.equal(offline.status, "offline");
  assert.equal(already.status, "cancelled");
});
