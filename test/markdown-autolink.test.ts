import { test } from "node:test";
import assert from "node:assert/strict";

const { renderMarkdown } = await import("../src/ui/markdown.js");

test("bare URLs become links", () => {
  const html = renderMarkdown("see https://example.com/a for detail");
  assert.match(html, /<a href="https:\/\/example\.com\/a"[^>]*>https:\/\/example\.com\/a<\/a>/);
});

test("a code span that is only a URL still links", () => {
  // Agents habitually wrap a bare link in backticks; treating that as
  // literal makes the common case unclickable.
  const html = renderMarkdown("wrapped `https://example.com/a`");
  assert.match(html, /<code><a href="https:\/\/example\.com\/a"/);
});

test("a code span holding a command stays verbatim", () => {
  const html = renderMarkdown("run `curl https://example.com/x` now");
  assert.match(html, /<code>curl https:\/\/example\.com\/x<\/code>/);
  assert.doesNotMatch(html, /<code>[^<]*<a /);
});

test("markdown links are not re-linkified into nested anchors", () => {
  const html = renderMarkdown("[named](https://example.com) stays");
  assert.equal(html.match(/<a /g)?.length, 1);
  assert.match(html, />named<\/a>/);
});

test("sentence punctuation is left outside the href", () => {
  const html = renderMarkdown("trailing (https://example.com/a).");
  assert.match(html, /href="https:\/\/example\.com\/a"/);
  assert.match(html, /<\/a>\)\./);
});

test("a paren that belongs to the path is kept", () => {
  const html = renderMarkdown("wiki https://en.wikipedia.org/wiki/Foo_(bar) end");
  assert.match(html, /href="https:\/\/en\.wikipedia\.org\/wiki\/Foo_\(bar\)"/);
});

test("a quote in a URL cannot break out of the attribute", () => {
  const html = renderMarkdown('evil https://x.com/"onmouseover=alert(1) end');
  // The text "onmouseover=" survives as escaped content, which is
  // harmless. What must not happen is a RAW quote closing the href and
  // starting a new attribute.
  assert.doesNotMatch(html, /"\s*onmouseover\s*=/);
  assert.match(html, /&quot;onmouseover/);
});
