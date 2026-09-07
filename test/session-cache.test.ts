import { test } from "node:test";
import assert from "node:assert/strict";
import { trimForCache } from "../src/ui/session-cache.js";
import type { SessionInfo } from "../src/ui/types.js";

test("trimForCache downgrades warm sessions to cold rather than dropping them", () => {
  const sessions: SessionInfo[] = [
    { sessionId: "warm-1", cwd: "/w", status: "warm", busy: true },
    { sessionId: "cold-1", cwd: "/w", status: "cold" },
  ];
  const out = trimForCache(sessions);
  assert.deepEqual(
    out.map((s) => s.sessionId),
    ["warm-1", "cold-1"],
  );
  assert.equal(out[0]!.status, "cold");
  assert.equal(out[0]!.busy, false);
});

test("trimForCache keeps only the fields the session-list card renders", () => {
  const sessions: SessionInfo[] = [
    {
      sessionId: "s1",
      cwd: "/w",
      agentId: "claude-acp",
      currentModel: "sonnet",
      title: "fix flaky test",
      status: "cold",
      busy: false,
      awaitingInput: false,
      priority: 1,
      importedFromMachine: "broom",
      upstreamSessionId: "u1",
      armedTasks: 0,
      updatedAt: "2025-01-01T00:00:00Z",
      // Not rendered by the session-list card — must not survive the trim.
      attachedClients: 3,
      workspace: {
        path: "/ws",
        sourceCwd: "/w",
        label: "feature",
        provider: "git",
      },
      workspaceError: "fell back to source tree",
    },
  ];
  assert.deepEqual(trimForCache(sessions), [
    {
      sessionId: "s1",
      cwd: "/w",
      agentId: "claude-acp",
      currentModel: "sonnet",
      title: "fix flaky test",
      status: "cold",
      busy: false,
      awaitingInput: false,
      priority: 1,
      importedFromMachine: "broom",
      upstreamSessionId: "u1",
      armedTasks: 0,
      updatedAt: "2025-01-01T00:00:00Z",
    },
  ]);
});

test("trimForCache drops federated (remote-set) sessions even when cold", () => {
  const sessions: SessionInfo[] = [
    { sessionId: "peerb:abc", cwd: "/w", status: "cold", remote: "peerb" },
    { sessionId: "local-1", cwd: "/w", status: "cold" },
  ];
  assert.deepEqual(
    trimForCache(sessions).map((s) => s.sessionId),
    ["local-1"],
  );
});

test("trimForCache tolerates an all-warm or empty list", () => {
  assert.deepEqual(trimForCache([]), []);
  const out = trimForCache([{ sessionId: "w", cwd: "/w", status: "warm" }]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.status, "cold");
});
