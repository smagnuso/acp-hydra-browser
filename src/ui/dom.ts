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

// Button activation via "click" is unreliable on mobile Chrome for this
// app: click is a compatibility event synthesized after pointerup, and
// on a slower device it can land a frame or more later — after our
// full-teardown render() has already replaced the button's DOM node out
// from under it, silently dropping the event. pointerup fires
// synchronously with the physical release, before any of that, so we
// act on it directly instead. preventDefault on pointerdown stops the
// button from taking focus (which would blur/dismiss an open mobile
// keyboard) and, for touch, suppresses the compatibility click entirely;
// the firedViaPointer guard covers the mouse case, where click still
// fires after pointerup despite the preventDefault. A plain "click" (no
// preceding pointerdown/pointerup — keyboard Enter/Space activation)
// still runs fn() normally.
export function tapHandler(fn: () => void): Record<string, unknown> {
  let firedViaPointer = false;
  return {
    onpointerdown: (e: Event) => {
      const pe = e as PointerEvent;
      if (pe.pointerType === "mouse" && pe.button !== 0) return;
      e.preventDefault();
    },
    onpointerup: (e: Event) => {
      const pe = e as PointerEvent;
      if (pe.pointerType === "mouse" && pe.button !== 0) return;
      firedViaPointer = true;
      fn();
    },
    onclick: () => {
      if (firedViaPointer) {
        firedViaPointer = false;
        return;
      }
      fn();
    },
  };
}

function appendChild(parent: Node, c: Child): void {
  if (c == null || c === false) return;
  if (c instanceof Node) {
    parent.appendChild(c);
  } else {
    parent.appendChild(document.createTextNode(String(c)));
  }
}
