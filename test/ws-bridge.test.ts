import { test } from "node:test";
import assert from "node:assert/strict";
import { _internal } from "../src/server/ws-bridge.js";

test("browser request whitelist matches plan", () => {
  const allowed = [
    "session/prompt",
    "session/cancel",
    "session/set_mode",
    "session/set_model",
    // Generic config-option setter (model/mode/agent, or whatever the
    // agent advertises on its own, e.g. effort).
    "session/set_config_option",
    // Hydra-side queue control: drop or rewrite a queued prompt by
    // messageId. Safe to allow — hydra structurally rejects invalid /
    // already-running ids with a typed result, never crashes.
    "hydra-acp/prompt/cancel",
    "hydra-acp/prompt/update",
    // Amend the in-flight head with a replacement prompt. Hydra
    // rejects unknown/closed/already-running targets with a typed
    // result, so it's safe to forward.
    "hydra-acp/prompt/amend",
    // Mid-turn steering (pre-standard extension) — always operates
    // against this connection's own sessionId (coerced by the
    // bridge), same as the amend/cancel/update trio above.
    "_session/steering",
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
