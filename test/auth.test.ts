import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AuthRateLimiter,
  buildClearCookie,
  buildSetCookie,
  constantTimeKeyMatch,
  parseCookies,
} from "../src/server/auth.js";

test("constantTimeKeyMatch true on equal strings", () => {
  assert.equal(constantTimeKeyMatch("abc", "abc"), true);
});

test("constantTimeKeyMatch false on different strings", () => {
  assert.equal(constantTimeKeyMatch("abc", "abd"), false);
});

test("constantTimeKeyMatch false on different lengths", () => {
  assert.equal(constantTimeKeyMatch("abc", "abcd"), false);
});

test("constantTimeKeyMatch false on non-strings", () => {
  // @ts-expect-error testing runtime guard
  assert.equal(constantTimeKeyMatch(undefined, "abc"), false);
});

test("rate limiter blocks after 10 failures", () => {
  const r = new AuthRateLimiter();
  assert.equal(r.isBlocked("1.1.1.1"), false);
  for (let i = 0; i < 9; i++) {
    r.recordFailure("1.1.1.1");
  }
  assert.equal(r.isBlocked("1.1.1.1"), false);
  r.recordFailure("1.1.1.1");
  assert.equal(r.isBlocked("1.1.1.1"), true);
});

test("rate limiter clears on success", () => {
  const r = new AuthRateLimiter();
  for (let i = 0; i < 10; i++) {
    r.recordFailure("2.2.2.2");
  }
  assert.equal(r.isBlocked("2.2.2.2"), true);
  r.recordSuccess("2.2.2.2");
  assert.equal(r.isBlocked("2.2.2.2"), false);
});

test("buildSetCookie produces HttpOnly+SameSite", () => {
  const c = buildSetCookie("xyz", { secure: false, maxAgeSeconds: 60 });
  assert.match(c, /^hb_authkey=xyz/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
  assert.match(c, /Max-Age=60/);
  assert.doesNotMatch(c, /Secure/);
});

test("buildSetCookie adds Secure for https", () => {
  const c = buildSetCookie("xyz", { secure: true, maxAgeSeconds: 60 });
  assert.match(c, /Secure/);
});

test("buildClearCookie zeros Max-Age", () => {
  assert.match(buildClearCookie(), /Max-Age=0/);
});

test("parseCookies extracts pairs", () => {
  const m = parseCookies("hb_authkey=abc; foo=bar");
  assert.equal(m.get("hb_authkey"), "abc");
  assert.equal(m.get("foo"), "bar");
});

test("parseCookies handles undefined", () => {
  const m = parseCookies(undefined);
  assert.equal(m.size, 0);
});
