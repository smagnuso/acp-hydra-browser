import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDiffDisplayLines,
  countDiffChanges,
  extractEditDiff,
} from "../src/ui/edit-diff.js";

test("extractEditDiff reads the canonical content[] diff carrier", () => {
  const diff = extractEditDiff({
    content: [{ type: "diff", path: "src/a.ts", oldText: "a\n", newText: "b\n" }],
  });
  assert.deepEqual(diff, { path: "src/a.ts", oldText: "a\n", newText: "b\n" });
});

test("extractEditDiff falls back to Claude's Edit rawInput shape", () => {
  const diff = extractEditDiff({
    rawInput: { file_path: "src/a.ts", old_string: "foo", new_string: "bar" },
  });
  assert.deepEqual(diff, { path: "src/a.ts", oldText: "foo", newText: "bar" });
});

test("extractEditDiff falls back to Claude's Write rawInput shape", () => {
  const diff = extractEditDiff({
    rawInput: { path: "src/new.ts", content: "hello\n" },
  });
  assert.deepEqual(diff, { path: "src/new.ts", oldText: "", newText: "hello\n" });
});

test("extractEditDiff returns null for non-edit tool calls", () => {
  assert.equal(extractEditDiff({ rawInput: { command: "ls" } }), null);
  assert.equal(extractEditDiff({ content: [{ type: "text", text: "hi" }] }), null);
  assert.equal(extractEditDiff({}), null);
});

test("countDiffChanges counts added/removed lines via LCS, not raw line totals", () => {
  const counts = countDiffChanges({
    oldText: "one\ntwo\nthree\n",
    newText: "one\ntwo-edited\nthree\n",
  });
  assert.deepEqual(counts, { added: 1, removed: 1 });
});

test("countDiffChanges is zero for identical text", () => {
  const counts = countDiffChanges({ oldText: "same\n", newText: "same\n" });
  assert.deepEqual(counts, { added: 0, removed: 0 });
});

test("buildDiffDisplayLines collapses distant unchanged context into a gap line", () => {
  const oldLines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
  const newLines = [...oldLines];
  newLines[25] = "line 25 changed";
  const diff = { oldText: oldLines.join("\n") + "\n", newText: newLines.join("\n") + "\n" };

  const lines = buildDiffDisplayLines(diff, { contextLines: 3, maxLines: 100 });

  assert.ok(lines.length < oldLines.length, "hunk should be far smaller than the full file");
  const gaps = lines.filter((l) => l.op === "gap");
  assert.ok(gaps.length > 0, "expected at least one collapsed-context gap line");
  const changed = lines.filter((l) => l.op === "+" || l.op === "-");
  assert.ok(changed.length > 0, "expected the changed line to survive collapsing");
});

test("buildDiffDisplayLines truncates past maxLines with a trailer", () => {
  const oldLines = Array.from({ length: 20 }, (_, i) => `old ${i}`);
  const newLines = Array.from({ length: 20 }, (_, i) => `new ${i}`);
  const diff = { oldText: oldLines.join("\n") + "\n", newText: newLines.join("\n") + "\n" };

  const lines = buildDiffDisplayLines(diff, { contextLines: Infinity, maxLines: 5 });

  assert.equal(lines.length, 5);
  assert.equal(lines[4]!.op, "gap");
  assert.match(lines[4]!.text, /more line/);
});

test("buildDiffDisplayLines returns nothing for a no-op edit", () => {
  const lines = buildDiffDisplayLines({ oldText: "same\n", newText: "same\n" });
  assert.deepEqual(lines, []);
});
