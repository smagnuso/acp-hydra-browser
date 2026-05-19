import { test } from "node:test";
import assert from "node:assert/strict";
import { _internal } from "../src/server/ws-bridge.js";

test("browser request whitelist matches plan", () => {
  const allowed = [
    "session/prompt",
    "session/cancel",
    "session/set_mode",
    "session/set_model",
    // Hydra-side queue control: drop or rewrite a queued prompt by
    // messageId. Safe to allow — hydra structurally rejects invalid /
    // already-running ids with a typed result, never crashes.
    "hydra-acp/cancel_prompt",
    "hydra-acp/update_prompt",
  ];
  for (const m of allowed) {
    assert.equal(
      _internal.ALLOWED_BROWSER_REQUEST_METHODS.has(m),
      true,
      `allowed: ${m}`,
    );
  }
  // Sanity: dangerous methods are blocked.
  for (const m of [
    "session/new",
    "session/load",
    "session/attach",
    "initialize",
    "extension/install",
  ]) {
    assert.equal(
      _internal.ALLOWED_BROWSER_REQUEST_METHODS.has(m),
      false,
      `blocked: ${m}`,
    );
  }
});

test("agent reverse-call short-circuit list", () => {
  for (const m of ["fs/read_text_file", "fs/write_text_file"]) {
    assert.equal(_internal.SHORT_CIRCUIT_AGENT_REQUEST_METHODS.has(m), true);
  }
});

test("browser notification whitelist allows session/cancel only", () => {
  // session/cancel is a notification per the ACP spec — the bridge must
  // forward the notification form upstream so hydra's onNotification
  // handler routes it correctly.
  assert.equal(
    _internal.ALLOWED_BROWSER_NOTIFICATION_METHODS.has("session/cancel"),
    true,
  );
  // Nothing else is allowed as a browser-originated notification.
  for (const m of [
    "session/prompt",
    "session/new",
    "session/attach",
    "session/load",
    "initialize",
  ]) {
    assert.equal(
      _internal.ALLOWED_BROWSER_NOTIFICATION_METHODS.has(m),
      false,
      `blocked notification: ${m}`,
    );
  }
});
