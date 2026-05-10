import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PathScopeError, resolveScopedPath } from "../src/server/routes-files.js";

function makeRoot(): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "hydra-acp-browser-"));
  mkdirSync(join(cwd, "sub"), { recursive: true });
  writeFileSync(join(cwd, "a.txt"), "hi");
  writeFileSync(join(cwd, "sub/b.txt"), "ok");
  return {
    cwd,
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

test("resolveScopedPath allows files inside cwd", async () => {
  const { cwd, cleanup } = makeRoot();
  try {
    const a = await resolveScopedPath(cwd, "a.txt");
    assert.match(a, /a\.txt$/);
    const b = await resolveScopedPath(cwd, "sub/b.txt");
    assert.match(b, /sub\/b\.txt$/);
    const root = await resolveScopedPath(cwd, "");
    assert.equal(root.replace(/\/$/, ""), cwd.replace(/\/$/, ""));
  } finally {
    cleanup();
  }
});

test("resolveScopedPath rejects ..", async () => {
  const { cwd, cleanup } = makeRoot();
  try {
    await assert.rejects(
      () => resolveScopedPath(cwd, "../etc/passwd"),
      PathScopeError,
    );
    await assert.rejects(
      () => resolveScopedPath(cwd, "sub/../../etc/passwd"),
      PathScopeError,
    );
  } finally {
    cleanup();
  }
});

test("resolveScopedPath rejects absolute paths outside cwd", async () => {
  const { cwd, cleanup } = makeRoot();
  try {
    await assert.rejects(
      () => resolveScopedPath(cwd, "/etc/passwd"),
      PathScopeError,
    );
  } finally {
    cleanup();
  }
});

test("resolveScopedPath rejects symlink escape", async () => {
  const { cwd, cleanup } = makeRoot();
  try {
    symlinkSync("/etc", join(cwd, "escape"));
    await assert.rejects(
      () => resolveScopedPath(cwd, "escape"),
      PathScopeError,
    );
    await assert.rejects(
      () => resolveScopedPath(cwd, "escape/passwd"),
      PathScopeError,
    );
  } finally {
    cleanup();
  }
});
