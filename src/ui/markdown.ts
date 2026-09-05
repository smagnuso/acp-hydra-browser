// Tiny XSS-safe markdown renderer. Caller passes the result to
// `element.innerHTML`; the rendering escapes all input text up-front so
// only this file's own tags reach the DOM.

import { highlightFenced } from "./hljs.js";

export function escapeHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Bare URLs. Agents emit them constantly without markdown link syntax,
// and unlinked they're useless on a phone — you can't even select them
// cleanly. Input here is already escaped, so `&` reads as `&amp;`; that
// is also what an href wants, so it passes through untouched.
function linkifyPlain(s: string): string {
  return s.replace(/\bhttps?:\/\/[^\s<]+/g, (raw) => {
    let url = raw;
    let trail = "";
    // Trailing punctuation is nearly always the sentence's, not the
    // URL's. The entities are what escapeHtml made of quotes.
    for (;;) {
      const m = url.match(/(&quot;|&#39;|&gt;|[.,;:!?'\]}"])$/);
      if (!m) break;
      trail = m[0] + trail;
      url = url.slice(0, -m[0].length);
    }
    // A closing paren only belongs to the sentence if it has no opener
    // inside the URL — wikipedia-style paths legitimately end in one.
    while (url.endsWith(")")) {
      const opens = (url.match(/\(/g) ?? []).length;
      const closes = (url.match(/\)/g) ?? []).length;
      if (opens >= closes) break;
      trail = ")" + trail;
      url = url.slice(0, -1);
    }
    if (!url) return raw;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${trail}`;
  });
}

// Linkify only the stretches that aren't already inside a tag this
// renderer produced: never rewrite the innards of a markdown link, and
// leave <code> alone EXCEPT when the span is nothing but a URL. Agents
// habitually wrap a bare link in backticks, and treating that as
// literal makes the common case unclickable, while a code span holding
// a command (`curl https://…`) still stays verbatim.
function autolink(s: string): string {
  const protectedSpan = /<code>([\s\S]*?)<\/code>|<a\b[^>]*>[\s\S]*?<\/a>/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = protectedSpan.exec(s)) !== null) {
    out += linkifyPlain(s.slice(last, m.index));
    const codeInner = m[1];
    if (codeInner !== undefined && /^https?:\/\/[^\s<]+$/.test(codeInner.trim())) {
      out += `<code>${linkifyPlain(codeInner)}</code>`;
    } else {
      out += m[0];
    }
    last = m.index + m[0].length;
  }
  return out + linkifyPlain(s.slice(last));
}

// Apply inline markdown to a chunk of *already-escaped* HTML.
function inlineMd(s: string): string {
  // Code spans first so their content isn't further transformed.
  s = s.replace(/`([^`\n]+)`/g, (_m, c: string) => `<code>${c}</code>`);
  // Bold + italic.
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  // Markdown links [text](url) — accepts http(s)://, relative paths,
  // and hydra://sessions/<id> (rewritten to in-app SPA navigation).
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
    // Hydra session link: rewrite to same-page hash route so clicking
    // navigates the SPA to that session instead of opening a new tab.
    // Accepts the permissive shape hydra://[<host>:<port>/]sessions/<id>[#turn-<n>]
    // to match the TUI parser; host and turn fragment are dropped in v1.
    const hydraMatch = url.match(/^hydra:\/\/(?:[^/\s]+\/)?sessions\/([A-Za-z0-9_-]+)(?:#turn-\d+)?$/);
    if (hydraMatch) {
      const sid = hydraMatch[1]!;
      return `<a href="#/session/${escapeHtml(sid)}">${text}</a>`;
    }
    if (!/^(https?:\/\/|\/|\.)/i.test(url)) {
      return `[${text}](${url})`;
    }
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
  // Last: everything above has already produced its anchors, so this
  // can skip them rather than nesting one inside another.
  return autolink(s);
}

// Parse a `| a | b | c |` row into trimmed cell strings, or null if
// the line doesn't look like a table row. Leading/trailing pipes are
// optional. Escaped pipes (`\|`) aren't supported — none of the
// agents we drive emit them in tables.
function parseTableRow(s: string): string[] | null {
  const trimmed = s.trim();
  if (!trimmed.includes("|")) return null;
  let stripped = trimmed;
  if (stripped.startsWith("|")) stripped = stripped.slice(1);
  if (stripped.endsWith("|")) stripped = stripped.slice(0, -1);
  return stripped.split("|").map((c) => c.trim());
}

// Returns alignment array (one per cell) if `s` is a table separator
// like `|---|:---:|---:|`, else null. Also asserts at least one cell
// has hyphens — protects against false-positives on lines like `|||`.
function parseTableSeparator(s: string): Array<"left" | "center" | "right" | null> | null {
  const cells = parseTableRow(s);
  if (!cells || cells.length === 0) return null;
  const aligns: Array<"left" | "center" | "right" | null> = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) aligns.push("center");
    else if (right) aligns.push("right");
    else if (left) aligns.push("left");
    else aligns.push(null);
  }
  return aligns;
}

function renderCodeBlock(code: string, lang: string): string {
  const highlighted = highlightFenced(code, lang);
  const langAttr = escapeHtml(lang);
  const codeAttrs = highlighted !== null ? ` class="hljs" data-lang="${langAttr}"` : ` data-lang="${langAttr}"`;
  const body = highlighted ?? escapeHtml(code);
  return `<pre><code${codeAttrs}>${body}</code></pre>`;
}

function renderTableRow(
  cells: string[],
  aligns: Array<"left" | "center" | "right" | null>,
  tag: "th" | "td",
): string {
  let out = "<tr>";
  for (let i = 0; i < cells.length; i++) {
    const align = aligns[i] ?? null;
    const styleAttr = align ? ` style="text-align:${align}"` : "";
    out += `<${tag}${styleAttr}>${inlineMd(escapeHtml(cells[i]!))}</${tag}>`;
  }
  out += "</tr>";
  return out;
}

export function renderMarkdown(src: unknown): string {
  if (typeof src !== "string") {
    src = String(src ?? "");
  }
  const lines = (src as string).split("\n");
  let out = "";
  let inCode = false;
  let codeLang = "";
  let codeBuf: string[] = [];
  let listType: "ul" | "ol" | null = null;
  // Buffered rather than emitted immediately: a hard-wrapped source line
  // (an item's text continuing on the next line, indented under the
  // marker) doesn't itself look like a new list item, so it needs to
  // append to the item still being built rather than force it closed.
  let listItemLines: string[] = [];
  let para: string[] = [];

  function flushPara(): void {
    if (para.length === 0) return;
    out += `<p>${inlineMd(para.join(" "))}</p>`;
    para = [];
  }
  function flushListItem(): void {
    if (listItemLines.length === 0) return;
    out += `<li>${inlineMd(listItemLines.join(" "))}</li>`;
    listItemLines = [];
  }
  function closeList(): void {
    if (listType) {
      flushListItem();
      out += `</${listType}>`;
      listType = null;
    }
  }

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i]!;
    if (inCode) {
      if (/^```/.test(raw)) {
        out += renderCodeBlock(codeBuf.join("\n"), codeLang);
        inCode = false;
        codeBuf = [];
        codeLang = "";
        i++;
        continue;
      }
      codeBuf.push(raw);
      i++;
      continue;
    }
    if (/^```/.test(raw)) {
      flushPara();
      closeList();
      inCode = true;
      codeLang = raw.slice(3).trim();
      i++;
      continue;
    }
    // GFM table: header row followed by a separator row, then any
    // number of body rows. Detected by looking ahead at the next line.
    if (i + 1 < lines.length && raw.includes("|")) {
      const headerCells = parseTableRow(raw);
      const aligns = parseTableSeparator(lines[i + 1]!);
      if (
        headerCells &&
        aligns &&
        headerCells.length > 0 &&
        // Most agents emit equal-cell-count tables; pad/truncate
        // gracefully if the separator's count differs.
        aligns.length > 0
      ) {
        flushPara();
        closeList();
        const cols = Math.max(headerCells.length, aligns.length);
        const paddedAligns: Array<"left" | "center" | "right" | null> = [];
        for (let c = 0; c < cols; c++) paddedAligns.push(aligns[c] ?? null);
        out += "<table><thead>";
        out += renderTableRow(headerCells, paddedAligns, "th");
        out += "</thead><tbody>";
        let j = i + 2;
        while (j < lines.length) {
          const rowCells = parseTableRow(lines[j]!);
          if (!rowCells) break;
          out += renderTableRow(rowCells, paddedAligns, "td");
          j++;
        }
        out += "</tbody></table>";
        i = j;
        continue;
      }
    }
    if (/^\s*$/.test(raw)) {
      flushPara();
      closeList();
      i++;
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = raw.match(/^(#{1,3})\s+(.+)$/))) {
      flushPara();
      closeList();
      const level = m[1]!.length;
      out += `<h${level}>${inlineMd(escapeHtml(m[2]!))}</h${level}>`;
      i++;
      continue;
    }
    if ((m = raw.match(/^\s*[-*]\s+(.*)$/))) {
      flushPara();
      if (listType !== "ul") {
        closeList();
        out += "<ul>";
        listType = "ul";
      } else {
        flushListItem();
      }
      listItemLines.push(escapeHtml(m[1]!));
      i++;
      continue;
    }
    if ((m = raw.match(/^\s*\d+\.\s+(.*)$/))) {
      flushPara();
      if (listType !== "ol") {
        closeList();
        out += "<ol>";
        listType = "ol";
      } else {
        flushListItem();
      }
      listItemLines.push(escapeHtml(m[1]!));
      i++;
      continue;
    }
    if ((m = raw.match(/^\s*>\s?(.*)$/))) {
      flushPara();
      closeList();
      out += `<blockquote>${inlineMd(escapeHtml(m[1]!))}</blockquote>`;
      i++;
      continue;
    }
    // A non-blank line that doesn't start any other block: inside a
    // list this is a wrapped continuation of the item in progress
    // (CommonMark's "lazy continuation"), not a new paragraph.
    if (listType !== null) {
      listItemLines.push(escapeHtml(raw.trim()));
      i++;
      continue;
    }
    para.push(escapeHtml(raw));
    i++;
  }
  if (inCode) {
    out += renderCodeBlock(codeBuf.join("\n"), codeLang);
  }
  flushPara();
  closeList();
  return out;
}

// Best-effort flatten of an ACP content blob (string | array | object)
// into a string. Lives here because it's used in multiple places that
// also lean on markdown.
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(contentToText).join("");
  }
  if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (typeof c.text === "string") return c.text;
    if (typeof c.content === "string") return c.content;
  }
  return "";
}
