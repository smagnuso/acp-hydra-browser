// Minimal element-builder. Accepts an attribute bag where:
//   - "class": className
//   - "html": innerHTML (caller must have already escaped untrusted text)
//   - "on<event>": event listener (lowercased after the "on")
//   - anything else: setAttribute
// false/null/undefined attribute values are skipped so we can write
// `el("button", { disabled: someFlag && true })` without polluting the
// element tree.

type Attrs = Record<string, unknown> | null | undefined;
type Child = Node | string | number | false | null | undefined | Child[];

export function el(tag: string, attrs?: Attrs, ...children: Child[]): HTMLElement {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) {
        continue;
      }
      if (k === "class") {
        node.className = v as string;
      } else if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === "html") {
        node.innerHTML = v as string;
      } else {
        node.setAttribute(k, String(v));
      }
    }
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) {
      for (const cc of c) appendChild(node, cc);
    } else {
      appendChild(node, c);
    }
  }
  return node;
}

function appendChild(parent: Node, c: Child): void {
  if (c == null || c === false) return;
  if (c instanceof Node) {
    parent.appendChild(c);
  } else {
    parent.appendChild(document.createTextNode(String(c)));
  }
}
