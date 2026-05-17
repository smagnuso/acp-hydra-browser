import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSecurityContext,
  checkHost,
  checkOrigin,
  checkSecFetchSite,
  checkStateChanging,
} from "../src/util/csrf.js";
import { DEFAULT_BROWSER_PORT } from "../src/config.js";

const ctx = buildSecurityContext("127.0.0.1", DEFAULT_BROWSER_PORT, "http", ["my-tailscale.ts"]);

test("checkHost allows loopback", () => {
  assert.equal(checkHost(ctx, { host: `127.0.0.1:${DEFAULT_BROWSER_PORT}` }), true);
  assert.equal(checkHost(ctx, { host: `localhost:${DEFAULT_BROWSER_PORT}` }), true);
});

test("checkHost rejects unknown host", () => {
  assert.equal(checkHost(ctx, { host: `evil.example.com:${DEFAULT_BROWSER_PORT}` }), false);
});

test("checkHost allows extra allowlisted host", () => {
  assert.equal(checkHost(ctx, { host: `my-tailscale.ts:${DEFAULT_BROWSER_PORT}` }), true);
});

test("checkOrigin allows loopback origin", () => {
  assert.equal(
    checkOrigin(ctx, { origin: `http://127.0.0.1:${DEFAULT_BROWSER_PORT}` }),
    true,
  );
});

test("checkOrigin rejects external origin", () => {
  assert.equal(
    checkOrigin(ctx, { origin: "https://evil.example.com" }),
    false,
  );
});

test("checkOrigin allows missing origin when sec-fetch-site is same-origin", () => {
  assert.equal(
    checkOrigin(ctx, { "sec-fetch-site": "same-origin" }),
    true,
  );
});

test("checkSecFetchSite allows same-origin/none/missing", () => {
  assert.equal(checkSecFetchSite({ "sec-fetch-site": "same-origin" }), true);
  assert.equal(checkSecFetchSite({ "sec-fetch-site": "none" }), true);
  assert.equal(checkSecFetchSite({}), true);
});

test("checkSecFetchSite rejects cross-site", () => {
  assert.equal(
    checkSecFetchSite({ "sec-fetch-site": "cross-site" }),
    false,
  );
});

test("checkStateChanging composite OK", () => {
  const r = checkStateChanging(ctx, {
    host: `127.0.0.1:${DEFAULT_BROWSER_PORT}`,
    origin: `http://127.0.0.1:${DEFAULT_BROWSER_PORT}`,
    "sec-fetch-site": "same-origin",
  });
  assert.equal(r.ok, true);
});

test("checkStateChanging rejects bad host", () => {
  const r = checkStateChanging(ctx, {
    host: "evil:80",
    origin: `http://127.0.0.1:${DEFAULT_BROWSER_PORT}`,
    "sec-fetch-site": "same-origin",
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.status, 421);
  }
});

test("checkStateChanging rejects cross-site fetch", () => {
  const r = checkStateChanging(ctx, {
    host: `127.0.0.1:${DEFAULT_BROWSER_PORT}`,
    origin: `http://127.0.0.1:${DEFAULT_BROWSER_PORT}`,
    "sec-fetch-site": "cross-site",
  });
  assert.equal(r.ok, false);
});
