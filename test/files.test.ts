import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { PathScopeError, resolveScopedPath } from "../src/server/routes-files.js";

function makeRoot(): { cwd: string; cleanup: () => void } {
  // realpath, because resolveScopedPath does: it is a security boundary,
  // so it resolves before comparing. macOS hands out /var/folders/... for
  // tmpdir, which is a symlink to /private/var/folders/..., and an
  // unresolved fixture path would be asserting against a spelling the
  // production code deliberately does not use.
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "hydra-acp-browser-")));
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
    // join, not a /-spelled regex: the request arrives with forward
    // slashes (it is a URL path) but the resolved answer is a filesystem
    // path, which is backslash-separated on Windows.
    assert.equal(b, join(cwd, "sub", "b.txt"));
    const root = await resolveScopedPath(cwd, "");
    const trimSep = (v: string): string => (v.endsWith(sep) ? v.slice(0, -1) : v);
    assert.equal(trimSep(root), trimSep(cwd));
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

test("resolveScopedPath rejects symlink escape", async (t) => {
  const { cwd, cleanup } = makeRoot();
  let outside: string | undefined;
  try {
    // A real directory outside the root, holding a real file, built here
    // rather than borrowed from the OS. The original pointed at /etc,
    // which does not exist on Windows, and a symlink whose target is
    // absent cannot demonstrate an escape: there is nothing beyond the
    // scope for it to reach, so the rejection under test never fires.
    outside = realpathSync(mkdtempSync(join(tmpdir(), "hydra-acp-outside-")));
    writeFileSync(join(outside, "secret.txt"), "nope");
    try {
      symlinkSync(outside, join(cwd, "escape"), "dir");
    } catch (err) {
      // Creating a symlink on Windows needs Developer Mode or admin
      // rights. Skip rather than assert on a boundary we could not set up.
      t.skip(`cannot create symlink here: ${(err as Error).message}`);
      return;
    }
    await assert.rejects(
      () => resolveScopedPath(cwd, "escape"),
      PathScopeError,
    );
    await assert.rejects(
      () => resolveScopedPath(cwd, "escape/secret.txt"),
      PathScopeError,
    );
  } finally {
    cleanup();
    if (outside !== undefined) {
      rmSync(outside, { recursive: true, force: true });
    }
  }
});
