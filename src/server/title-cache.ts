// Per-session title fallback cache. Hydra only stores the title that
// was passed at session/new (typically the editor's frame name, or
// nothing for sessions spawned through the browser). When a tab sends
// its first session/prompt frame, we seed an entry here from the prompt
// text — the routes-sessions handler folds this into /api/sessions
// responses for any session whose hydra-side title is empty, so the
// list view and chat topbar show something more informative than the
// raw sessionId. Mirrors what acp-hydra-slack does in the slack thread
// header.
//
// Lives in process memory only. A daemon restart loses it; the next
// prompt re-seeds.

const seededTitles = new Map<string, string>();

export function seedSessionTitle(sessionId: string, text: string): void {
  if (seededTitles.has(sessionId)) {
    return;
  }
  const seed = firstLine(text, 100);
  if (!seed) {
    return;
  }
  seededTitles.set(sessionId, seed);
}

export function getSeededTitle(sessionId: string): string | undefined {
  return seededTitles.get(sessionId);
}

// First non-empty line of `text`, truncated to `max` chars with a
// trailing ellipsis if needed. Returns undefined if `text` is all
// whitespace.
function firstLine(text: string, max: number): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    return line.length > max ? `${line.slice(0, max)}…` : line;
  }
  return undefined;
}

// Pull text out of an ACP session/prompt request's `prompt` field, which
// is an array of content blocks like `{type: "text", text: "..."}`.
// Concatenates all text blocks; ignores image/other blocks.
export function extractPromptText(params: unknown): string {
  if (!params || typeof params !== "object") {
    return "";
  }
  const blocks = (params as { prompt?: unknown }).prompt;
  if (!Array.isArray(blocks)) {
    return typeof blocks === "string" ? blocks : "";
  }
  let out = "";
  for (const b of blocks) {
    if (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string") {
      out += (b as { text: string }).text;
    }
  }
  return out;
}
