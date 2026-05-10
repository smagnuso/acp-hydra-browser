// Tiny XSS-safe markdown renderer. Caller passes the result to
// `element.innerHTML`; the rendering escapes all input text up-front so
// only this file's own tags reach the DOM.

export function escapeHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Apply inline markdown to a chunk of *already-escaped* HTML.
function inlineMd(s: string): string {
  // Code spans first so their content isn't further transformed.
  s = s.replace(/`([^`\n]+)`/g, (_m, c: string) => `<code>${c}</code>`);
  // Bold + italic.
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  // Markdown links [text](url) — only http(s):// or relative paths.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
    if (!/^(https?:\/\/|\/|\.)/i.test(url)) {
      return `[${text}](${url})`;
    }
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
  return s;
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
  let para: string[] = [];

  function flushPara(): void {
    if (para.length === 0) return;
    out += `<p>${inlineMd(para.join(" "))}</p>`;
    para = [];
  }
  function closeList(): void {
    if (listType) {
      out += `</${listType}>`;
      listType = null;
    }
  }

  for (const raw of lines) {
    if (inCode) {
      if (/^```/.test(raw)) {
        out += `<pre><code data-lang="${escapeHtml(codeLang)}">${escapeHtml(codeBuf.join("\n"))}</code></pre>`;
        inCode = false;
        codeBuf = [];
        codeLang = "";
        continue;
      }
      codeBuf.push(raw);
      continue;
    }
    if (/^```/.test(raw)) {
      flushPara();
      closeList();
      inCode = true;
      codeLang = raw.slice(3).trim();
      continue;
    }
    const escaped = escapeHtml(raw);
    if (/^\s*$/.test(raw)) {
      flushPara();
      closeList();
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = raw.match(/^(#{1,3})\s+(.+)$/))) {
      flushPara();
      closeList();
      const level = m[1]!.length;
      out += `<h${level}>${inlineMd(escapeHtml(m[2]!))}</h${level}>`;
      continue;
    }
    if ((m = raw.match(/^\s*[-*]\s+(.*)$/))) {
      flushPara();
      if (listType !== "ul") {
        closeList();
        out += "<ul>";
        listType = "ul";
      }
      out += `<li>${inlineMd(escapeHtml(m[1]!))}</li>`;
      continue;
    }
    if ((m = raw.match(/^\s*\d+\.\s+(.*)$/))) {
      flushPara();
      if (listType !== "ol") {
        closeList();
        out += "<ol>";
        listType = "ol";
      }
      out += `<li>${inlineMd(escapeHtml(m[1]!))}</li>`;
      continue;
    }
    if ((m = raw.match(/^\s*>\s?(.*)$/))) {
      flushPara();
      closeList();
      out += `<blockquote>${inlineMd(escapeHtml(m[1]!))}</blockquote>`;
      continue;
    }
    closeList();
    para.push(escaped);
  }
  if (inCode) {
    out += `<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`;
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
