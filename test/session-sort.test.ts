import { test } from "node:test";
import assert from "node:assert/strict";
import { compareSessions } from "../src/ui/session-sort.js";
import type { SessionInfo } from "../src/ui/types.js";

function sortIds(sessions: SessionInfo[]): string[] {
  return sessions
    .slice()
    .sort(compareSessions)
    .map((s) => s.sessionId);
}

test("compareSessions tiers busy+awaiting above plain busy above idle warm above cold", () => {
  const sessions: SessionInfo[] = [
    { sessionId: "cold", cwd: "/w", status: "cold" },
    { sessionId: "idle-warm", cwd: "/w", status: "warm" },
    { sessionId: "busy", cwd: "/w", status: "warm", busy: true },
    { sessionId: "busy-awaiting", cwd: "/w", status: "warm", busy: true, awaitingInput: true },
  ];
  assert.deepEqual(sortIds(sessions), ["busy-awaiting", "busy", "idle-warm", "cold"]);
});

test("compareSessions never lets a cold priority pin outrank real activity", () => {
  const sessions: SessionInfo[] = [
    { sessionId: "cold-pinned", cwd: "/w", status: "cold", priority: 5 },
    { sessionId: "warm-busy", cwd: "/w", status: "warm", busy: true },
  ];
  assert.deepEqual(sortIds(sessions), ["warm-busy", "cold-pinned"]);
});

test("compareSessions ties within a tier break on updatedAt, minute precision", () => {
  const sessions: SessionInfo[] = [
    { sessionId: "older", cwd: "/w", status: "cold", updatedAt: "2025-01-01T00:00:00Z" },
    { sessionId: "newer", cwd: "/w", status: "cold", updatedAt: "2025-01-02T00:00:00Z" },
  ];
  assert.deepEqual(sortIds(sessions), ["newer", "older"]);
});
