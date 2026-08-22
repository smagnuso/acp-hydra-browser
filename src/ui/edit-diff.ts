// Edit-diff extraction and line-level diffing, ported from the Hydra CLI
// TUI (cli/src/core/render-update.ts's extractEditDiff, cli/src/tui/format.ts's
// diffLines/lcsDiff/buildUnifiedDiff) so the browser can render the same
// "Edited <path> (+N -M)" blocks the terminal client shows.
//
// Scoped out relative to the CLI: the deferred "blob ref" transport
// (oldRef/newRef placeholders for huge diffs, fetched later via RPC) is a
// CLI-local on-disk history optimization, not a documented live
// session/update wire contract, so it isn't handled here. A tool call that
// somehow carries blob refs instead of inline text simply yields an empty
// (0-line) diff rather than erroring.

import type { EditDiff } from "./types.js";

const DEFAULT_CONTEXT_LINES = 3;
const EDIT_DIFF_MAX_LINES = 40;

type AnyRecord = Record<string, unknown>;

// Pull an EditDiff out of a tool_call / tool_call_update payload. Looks in
// this order:
//   1. content[] entry with type:"diff" carrying { path, oldText, newText }
//      — canonical ACP carrier
//   2. rawInput.{file_path, old_string, new_string} — Claude's Edit tool
//   3. rawInput.{path, content} — Claude's Write tool (full-file write
//      treated as oldText:"")
// Returns null when none of those shapes are present.
export function extractEditDiff(update: AnyRecord): EditDiff | null {
  const content = update.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as AnyRecord;
      if (b.type !== "diff") continue;
      const oldText = typeof b.oldText === "string" ? b.oldText : undefined;
      const newText = typeof b.newText === "string" ? b.newText : undefined;
      if (oldText === undefined && newText === undefined) continue;
      const path = typeof b.path === "string" ? b.path : undefined;
      return {
        ...(path !== undefined ? { path } : {}),
        oldText: oldText ?? "",
        newText: newText ?? "",
      };
    }
  }
  const rawInput = update.rawInput;
  if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
    const r = rawInput as AnyRecord;
    const filePath =
      typeof r.file_path === "string"
        ? r.file_path
        : typeof r.path === "string"
          ? r.path
          : undefined;
    if (typeof r.old_string === "string" && typeof r.new_string === "string") {
      return {
        ...(filePath !== undefined ? { path: filePath } : {}),
        oldText: r.old_string,
        newText: r.new_string,
      };
    }
    if (typeof r.content === "string") {
      return {
        ...(filePath !== undefined ? { path: filePath } : {}),
        oldText: "",
        newText: r.content,
      };
    }
  }
  return null;
}

interface DiffOp {
  op: "=" | "-" | "+";
  text: string;
}

// Split an edit's old/new text into lines; a trailing empty line from a
// final newline is dropped so a 3-line edit doesn't count as 4.
function diffLinePair(diff: EditDiff): { oldLines: string[]; newLines: string[] } {
  const oldLines = diff.oldText.split("\n");
  const newLines = diff.newText.split("\n");
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === "") {
    oldLines.pop();
  }
  if (newLines.length > 0 && newLines[newLines.length - 1] === "") {
    newLines.pop();
  }
  return { oldLines, newLines };
}

// Quadratic LCS diff over the (already prefix/suffix-trimmed) slices.
function lcsDiff(a: string[], b: string[]): DiffOp[] {
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) {
    const out: DiffOp[] = [];
    for (const text of a) out.push({ op: "-", text });
    for (const text of b) out.push({ op: "+", text });
    return out;
  }
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0) as number[],
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i]![j] = dp[i + 1]![j + 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
  }
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ op: "=", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ op: "-", text: a[i]! });
      i++;
    } else {
      out.push({ op: "+", text: b[j]! });
      j++;
    }
  }
  while (i < m) {
    out.push({ op: "-", text: a[i]! });
    i++;
  }
  while (j < n) {
    out.push({ op: "+", text: b[j]! });
    j++;
  }
  return out;
}

// Strip common leading/trailing unchanged lines first (cheap, linear), then
// run the quadratic LCS only over the differing middle. Some agents emit
// full-file old/new text for a one-line edit, so without this a 1-line edit
// to a 5000-line file would build a 5000x5000 LCS matrix.
function diffLines(a: string[], b: string[]): DiffOp[] {
  let start = 0;
  const minLen = Math.min(a.length, b.length);
  while (start < minLen && a[start] === b[start]) {
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: DiffOp[] = [];
  for (let k = 0; k < start; k++) {
    out.push({ op: "=", text: a[k]! });
  }
  out.push(...lcsDiff(a.slice(start, endA), b.slice(start, endB)));
  for (let k = endA; k < a.length; k++) {
    out.push({ op: "=", text: a[k]! });
  }
  return out;
}

// Count added / removed lines via the same LCS op stream the rendered body
// uses, so the (+N -M) header summary always matches the hunk.
export function countDiffChanges(diff: EditDiff): {
  added: number;
  removed: number;
} {
  const { oldLines, newLines } = diffLinePair(diff);
  let added = 0;
  let removed = 0;
  for (const op of diffLines(oldLines, newLines)) {
    if (op.op === "+") added++;
    else if (op.op === "-") removed++;
  }
  return { added, removed };
}

export interface DiffDisplayLine {
  op: "=" | "-" | "+" | "gap";
  text: string;
}

export interface BuildDiffDisplayLinesOptions {
  // Unchanged context lines kept around each change. Finite values collapse
  // runs of unchanged lines between hunks into a single "gap" line, so a
  // 1-line edit in a big file (e.g. an ACP full-file diff) renders a small
  // hunk, not the whole file.
  contextLines?: number;
  // Cap rendered lines (including the truncation trailer).
  maxLines?: number;
}

// Build a display-ready line-level diff for the given edit. Computes an
// LCS-based diff so context lines flow between +/- chunks rather than
// painting every old line as removed and every new line as added, collapses
// far-from-change context into "gap" markers, and truncates past the
// configured cap.
export function buildDiffDisplayLines(
  diff: EditDiff,
  opts: BuildDiffDisplayLinesOptions = {},
): DiffDisplayLine[] {
  const maxLines = opts.maxLines ?? EDIT_DIFF_MAX_LINES;
  const ctx = opts.contextLines ?? DEFAULT_CONTEXT_LINES;
  const { oldLines, newLines } = diffLinePair(diff);
  const ops = diffLines(oldLines, newLines);

  const display: DiffDisplayLine[] = [];
  if (!Number.isFinite(ctx)) {
    for (const op of ops) {
      display.push({ op: op.op, text: op.text });
    }
  } else {
    const hasChange = ops.some((o) => o.op !== "=");
    if (!hasChange) return [];
    const keep = new Array<boolean>(ops.length).fill(false);
    for (let i = 0; i < ops.length; i++) {
      if (ops[i]!.op !== "=") {
        const lo = Math.max(0, i - ctx);
        const hi = Math.min(ops.length - 1, i + ctx);
        for (let k = lo; k <= hi; k++) keep[k] = true;
      }
    }
    let i = 0;
    while (i < ops.length) {
      if (keep[i]) {
        display.push({ op: ops[i]!.op, text: ops[i]!.text });
        i++;
        continue;
      }
      let j = i;
      while (j < ops.length && !keep[j]) j++;
      const skipped = j - i;
      display.push({
        op: "gap",
        text: `⋯ ${skipped} unchanged line${skipped === 1 ? "" : "s"}`,
      });
      i = j;
    }
  }

  const rendered: DiffDisplayLine[] = [];
  for (let idx = 0; idx < display.length; idx++) {
    const wouldTruncate =
      rendered.length >= maxLines - 1 && idx < display.length - 1;
    if (wouldTruncate) {
      const remaining = display.length - idx;
      rendered.push({
        op: "gap",
        text: `… ${remaining} more line${remaining === 1 ? "" : "s"}`,
      });
      break;
    }
    rendered.push(display[idx]!);
  }
  return rendered;
}
