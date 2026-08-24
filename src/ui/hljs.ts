import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("go", go);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("php", php);
hljs.registerLanguage("python", python);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

const EXT_MAP: Record<string, string> = {
  bash: "bash",
  sh: "bash",
  zsh: "bash",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  css: "css",
  dockerfile: "dockerfile",
  go: "go",
  ini: "ini",
  toml: "ini",
  java: "java",
  cjs: "javascript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  json: "json",
  jsonc: "json",
  kt: "kotlin",
  kts: "kotlin",
  md: "markdown",
  markdown: "markdown",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sql: "sql",
  swift: "swift",
  cts: "typescript",
  mts: "typescript",
  ts: "typescript",
  tsx: "typescript",
  htm: "xml",
  html: "xml",
  svg: "xml",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

// Returns highlighted HTML for the body of a <code> element, or null if the
// file extension is not recognised (caller should fall back to escapeHtml).
export function highlightCode(code: string, filename: string): string | null {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const lang =
    EXT_MAP[ext] ??
    (filename.toLowerCase() === "dockerfile" ? "dockerfile" : null);
  if (!lang) return null;
  return hljs.highlight(code, { language: lang }).value;
}

const REGISTERED_LANG_IDS = new Set([
  "bash", "c", "cpp", "css", "dockerfile", "go", "ini", "java", "javascript",
  "json", "kotlin", "markdown", "php", "python", "ruby", "rust", "sql",
  "swift", "typescript", "xml", "yaml",
]);

// Markdown fence tags occasionally differ from EXT_MAP's file-extension
// keys (e.g. "c++" instead of "cpp", "shell"/"console" instead of "sh").
const FENCE_LANG_ALIASES: Record<string, string> = {
  "c++": "cpp",
  shell: "bash",
  console: "bash",
};

// Same idea as highlightCode, but resolves a markdown fence's language tag
// (```cpp, ```c++, ```sh, ...) instead of a filename extension.
export function highlightFenced(code: string, langTag: string): string | null {
  const key = langTag.trim().toLowerCase();
  if (!key) return null;
  const lang = REGISTERED_LANG_IDS.has(key)
    ? key
    : (FENCE_LANG_ALIASES[key] ?? EXT_MAP[key]);
  if (!lang) return null;
  return hljs.highlight(code, { language: lang }).value;
}
