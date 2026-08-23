import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mergeConf, readExisting, writeConf } from "../../src/setup/conf-writer.js";

test("mergeConf: fresh file gets header + updated keys", () => {
  const out = mergeConf("", {
    BROWSER_TLS_CERT: "/tmp/cert.pem",
    BROWSER_TLS_KEY: "/tmp/key.pem",
  });
  assert.match(out, /hydra-acp-browser tailscale setup/);
  assert.match(out, /^BROWSER_TLS_CERT=\/tmp\/cert\.pem$/m);
  assert.match(out, /^BROWSER_TLS_KEY=\/tmp\/key\.pem$/m);
});

test("mergeConf: existing keys are replaced in place", () => {
  const existing = [
    "# user comment",
    "BROWSER_HOST=127.0.0.1",
    "BROWSER_PORT=5514",
    "DEBUG=true",
    "",
  ].join("\n");
  const out = mergeConf(existing, { BROWSER_HOST: "100.64.1.5" });
  assert.match(out, /^# user comment$/m);
  assert.match(out, /^BROWSER_HOST=100\.64\.1\.5$/m);
  assert.match(out, /^BROWSER_PORT=5514$/m);
  assert.match(out, /^DEBUG=true$/m);
  assert.doesNotMatch(out, /127\.0\.0\.1/);
});

test("mergeConf: unknown keys are preserved", () => {
  const existing = ["# comment", "HYDRA_TOKEN=secret123", "WEIRD_CUSTOM_KEY=hello", ""].join("\n");
  const out = mergeConf(existing, { BROWSER_HOST: "100.64.1.5" });
  assert.match(out, /^HYDRA_TOKEN=secret123$/m);
  assert.match(out, /^WEIRD_CUSTOM_KEY=hello$/m);
  assert.match(out, /^BROWSER_HOST=100\.64\.1\.5$/m);
});

test("mergeConf: undefined values are skipped (no rewrite)", () => {
  const existing = "BROWSER_ALLOWED_HOSTS=mybox\n";
  const out = mergeConf(existing, { BROWSER_ALLOWED_HOSTS: undefined });
  assert.match(out, /^BROWSER_ALLOWED_HOSTS=mybox$/m);
});

test("mergeConf: new keys append at end with blank-line separator", () => {
  const existing = "BROWSER_HOST=127.0.0.1\n";
  const out = mergeConf(existing, { BROWSER_ALLOWED_HOSTS: "mybox.tailnet.ts.net" });
  assert.match(out, /^BROWSER_HOST=127\.0\.0\.1$/m);
  assert.match(out, /^BROWSER_ALLOWED_HOSTS=mybox\.tailnet\.ts\.net$/m);
});

test("mergeConf: values with whitespace get quoted", () => {
  const out = mergeConf("", { BROWSER_TLS_CERT: "value with space" });
  assert.match(out, /^BROWSER_TLS_CERT="value with space"$/m);
});

test("readExisting: returns empty map for missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "conf-test-"));
  const path = join(dir, "nope.conf");
  const { text, map } = readExisting(path);
  assert.equal(text, "");
  assert.equal(map.size, 0);
});

test("readExisting: parses quoted and unquoted values", () => {
  const dir = mkdtempSync(join(tmpdir(), "conf-test-"));
  const path = join(dir, "browser.conf");
  writeConf(path, {
    BROWSER_HOST: "100.64.1.5",
    BROWSER_ALLOWED_HOSTS: "mybox, mybox.tailnet.ts.net",
  });
  const { map } = readExisting(path);
  assert.equal(map.get("BROWSER_HOST"), "100.64.1.5");
  assert.equal(map.get("BROWSER_ALLOWED_HOSTS"), "mybox, mybox.tailnet.ts.net");
});

test("writeConf: writes file with 0600 permissions on POSIX", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "conf-test-"));
  const path = join(dir, "browser.conf");
  writeConf(path, { BROWSER_HOST: "100.64.1.5" });
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600);
  const text = readFileSync(path, "utf8");
  assert.match(text, /^BROWSER_HOST=100\.64\.1\.5$/m);
});

test("writeConf: round-trips preserving comments across multiple writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "conf-test-"));
  const path = join(dir, "browser.conf");
  writeConf(path, { BROWSER_HOST: "100.64.1.5", BROWSER_PORT: "5514", HYDRA_TOKEN: "secret" });
  writeConf(path, { BROWSER_HOST: "100.64.1.6" });
  const text = readFileSync(path, "utf8");
  assert.match(text, /^BROWSER_HOST=100\.64\.1\.6$/m);
  assert.match(text, /^BROWSER_PORT=5514$/m);
  assert.match(text, /^HYDRA_TOKEN=secret$/m);
});
