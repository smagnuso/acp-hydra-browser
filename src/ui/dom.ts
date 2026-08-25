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
// still runs fn(e) normally. Every stage also stops propagation, so a
// tapHandler'd control nested inside another clickable container (a
// card, a modal backdrop, a spinner row) never double-fires the
// ancestor's own handler — for mouse, click still bubbles even after
// preventDefault, so without this a nested control's click could also
// trigger its parent's onclick.
//
// A native click is also suppressed by the browser when the pointer
// moves far enough between down and up to count as a drag/scroll
// (e.g. the pull-to-refresh gesture starting on a session card) — acting
// on pointerup directly bypasses that, so we track the down position and
// skip fn() on pointerup if the release has moved past TAP_MOVE_THRESHOLD.
// For touch this fully suppresses activation (the compatibility click is
// already gone via preventDefault); for mouse it falls through to the
// click handler below, matching a plain onclick's behavior.
//
// Same story for a long-press-to-select: it barely moves the pointer, so
// the movement check doesn't catch it, but a native click is still
// suppressed once the gesture resolves into a text selection instead of a
// tap (e.g. long-pressing a session card to copy its cwd). preventDefault
// on pointerdown doesn't stop that native selection gesture from starting,
// so we check for one directly and skip activation — in both onpointerup
// and onclick, since a mouse click-drag-select needs the same guard as a
// touch long-press-select.
//
// A tapHandler'd container (a modal backdrop, say) can have a real form
// control nested inside it — e.g. the new-session modal's cwd input sits
// inside .modal-bg. That input's own pointerdown bubbles up to the
// backdrop's handler same as anything else, and preventDefault on it
// blocks the input's native focus-on-pointerdown, so the input never
// focuses and the mobile keyboard never opens. Bypass entirely — no
// preventDefault, no stopPropagation, no fn() — whenever the tap actually
// landed on a form control, so it gets fully native behavior.
export const TAP_MOVE_THRESHOLD = 10;

export function hasActiveSelection(): boolean {
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed && sel.toString().length > 0;
}

export function isFormControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}

// Same signal index.html's desktop-only CSS already gates on (chat-back
// button, queue button sizing) — a mouse/trackpad with real hover, not
// just a wide viewport (a tablet in landscape can be just as wide as a
// laptop but still wants touch behavior). JS-side uses: deciding whether
// autofocusing the composer is free (no virtual keyboard to pop up) or
// costly (steals the screen on a touch device).
export function isDesktopPointer(): boolean {
  return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

// Width-based, not device-based — a narrow desktop Chrome window falls
// back to the single-pane layout same as phone, and a hypothetical wide
// touch tablet gets the split view. views.ts's renderApp reads this to
// decide whether to render the session-list rail alongside chat instead
// of as its own full-screen view.
const WIDE_LAYOUT_QUERY = "(min-width: 1000px)";

export function isWideLayout(): boolean {
  return window.matchMedia(WIDE_LAYOUT_QUERY).matches;
}

// Call once at boot. Re-renders on crossing the breakpoint so the
// split/single-pane layout tracks a live window resize, not just the
// value at last render.
export function initWideLayoutWatcher(onChange: () => void): void {
  window.matchMedia(WIDE_LAYOUT_QUERY).addEventListener("change", onChange);
}

export function tapHandler(fn: (e: Event) => void): Record<string, unknown> {
  let firedViaPointer = false;
  let startX = 0;
  let startY = 0;
  return {
    onpointerdown: (e: Event) => {
      if (isFormControl(e.target)) return;
      const pe = e as PointerEvent;
      if (pe.pointerType === "mouse" && pe.button !== 0) return;
      startX = pe.clientX;
      startY = pe.clientY;
      e.preventDefault();
      e.stopPropagation();
    },
    onpointerup: (e: Event) => {
      if (isFormControl(e.target)) return;
      const pe = e as PointerEvent;
      if (pe.pointerType === "mouse" && pe.button !== 0) return;
      e.stopPropagation();
      if (Math.hypot(pe.clientX - startX, pe.clientY - startY) > TAP_MOVE_THRESHOLD) return;
      if (hasActiveSelection()) return;
      firedViaPointer = true;
      fn(e);
    },
    onclick: (e: Event) => {
      if (isFormControl(e.target)) return;
      e.stopPropagation();
      if (firedViaPointer) {
        firedViaPointer = false;
        return;
      }
      if (hasActiveSelection()) return;
      fn(e);
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
