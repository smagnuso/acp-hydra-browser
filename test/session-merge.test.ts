import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSessionListPage } from "../src/ui/session-merge.js";
import type { SessionInfo } from "../src/ui/types.js";

const warm = (id: string): SessionInfo => ({
  sessionId: id,
  cwd: "/w",
  status: "warm",
});
const cold = (id: string, updatedAt = "2025-01-01T00:00:00Z"): SessionInfo => ({
  sessionId: id,
  cwd: "/w",
  updatedAt,
  status: "cold",
});

test("replaces wholesale for a non-incremental (first / full) page", () => {
  const current = [warm("stale"), cold("also-stale")];
  const page = { sessions: [cold("fresh")], removed: [], cursor: 1 };
  assert.deepEqual(mergeSessionListPage(current, page, false), [cold("fresh")]);
});

test("upserts changed cold rows and leaves untouched cold rows alone", () => {
  const current = [cold("unchanged"), cold("stale", "2025-01-01T00:00:00Z")];
  const page = {
    sessions: [cold("stale", "2025-01-02T00:00:00Z")],
    removed: [],
    cursor: 2,
  };
  const merged = mergeSessionListPage(current, page, true);
  assert.equal(merged.length, 2);
  assert.deepEqual(
    merged.find((s) => s.sessionId === "unchanged"),
    cold("unchanged"),
  );
  assert.deepEqual(
    merged.find((s) => s.sessionId === "stale"),
    cold("stale", "2025-01-02T00:00:00Z"),
  );
});

test("drops ids in removed", () => {
  const current = [cold("keep"), cold("drop")];
  const page = { sessions: [], removed: ["drop"], cursor: 3 };
  assert.deepEqual(
    mergeSessionListPage(current, page, true).map((s) => s.sessionId),
    ["keep"],
  );
});

test("replaces the ENTIRE warm set on every incremental page, even a warm row absent from it", () => {
  // The daemon always answers an incremental request with the complete
  // warm set. A warm row this merge doesn't see in page.sessions is
  // therefore gone (cooled, killed, resurrected under a new id) — never
  // carried forward as a stale warm entry.
  const current = [warm("was-warm-1"), warm("was-warm-2"), cold("cold-1")];
  const page = { sessions: [warm("was-warm-1")], removed: [], cursor: 4 };
  const merged = mergeSessionListPage(current, page, true);
  assert.deepEqual(
    merged.map((s) => s.sessionId).sort(),
    ["cold-1", "was-warm-1"],
  );
});

test("a session cooling down (present as a changed cold row) replaces its stale warm copy", () => {
  const current = [warm("s1")];
  const page = {
    sessions: [cold("s1", "2025-01-02T00:00:00Z")],
    removed: [],
    cursor: 5,
  };
  assert.deepEqual(mergeSessionListPage(current, page, true), [
    cold("s1", "2025-01-02T00:00:00Z"),
  ]);
});

test("picks up a field change on a row that stays warm (busy flipping mid-turn)", () => {
  // The daemon returns the full warm set on every incremental page, and
  // `busy` lives only in its memory (never in meta.json, so no mtime moves
  // when it flips). If the merge failed to take the incoming warm copy, a
  // mid-turn session would render as idle forever.
  const current = [{ ...warm("s1"), busy: false }];
  const page = {
    sessions: [{ ...warm("s1"), busy: true }],
    removed: [],
    cursor: 6,
  };
  assert.equal(mergeSessionListPage(current, page, true)[0]?.busy, true);
});

test("purges a local row with an unknown status instead of stranding it as a live-looking ghost", () => {
  // Regression: the purge used to key on `status === "warm"`, but
  // SessionInfo.status is optional — a status-less row survived AND had
  // nothing in page.sessions to overwrite it, so it rendered as a live
  // card forever, and session-cache.ts persisted it to IndexedDB so it
  // outlived reloads too.
  const ghost: SessionInfo = { sessionId: "ghost", cwd: "/w" };
  const merged = mergeSessionListPage(
    [ghost, cold("keep")],
    { sessions: [], removed: [], cursor: 7 },
    true,
  );
  assert.deepEqual(
    merged.map((s) => s.sessionId),
    ["keep"],
  );
});
