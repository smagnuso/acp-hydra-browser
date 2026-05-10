import { test } from "node:test";
import assert from "node:assert/strict";
import { _internal } from "../src/server/ws-bridge.js";

test("browser request whitelist matches plan", () => {
  const allowed = [
    "session/prompt",
    "session/cancel",
    "session/set_mode",
    "session/set_model",
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
