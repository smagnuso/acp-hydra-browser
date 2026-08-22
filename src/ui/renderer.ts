// Render coalescer: multiple synchronous render() calls within one
// animation frame collapse into a single repaint. Saves and restores
// focus/caret on any element with a `data-focus-key` so re-renders
// don't blow away the user's typing position.

import { state } from "./state.js";
import { renderApp } from "./views.js";

let scheduled = false;

// A full render() tears down and rebuilds the whole #app tree (see
// actuallyRender() below), which destroys any DOM node mid-gesture. A
// button press spans mousedown/touchstart -> mouseup/touchend -> click,
// and WS traffic (e.g. agent_message_chunk while a turn is streaming)
// can trigger a render() at any point in that window — tearing out the
// pressed button before the click event has a chance to fire on it. So
// while a button is physically held down we hold off on the actual
// rebuild; the deferred render flushes on release, just before the
// browser dispatches click, so the still-live node handles it normally.
let buttonPressed = false;
document.addEventListener(
  "pointerdown",
  (e) => {
    if ((e.target as HTMLElement | null)?.closest("button")) {
      buttonPressed = true;
    }
  },
  true,
);
document.addEventListener(
  "pointerup",
  () => {
    if (!buttonPressed) return;
    buttonPressed = false;
    render();
  },
  true,
);
document.addEventListener(
  "pointercancel",
  () => {
    buttonPressed = false;
  },
  true,
);

// Debug mode is enabled via ?debug=1 in the URL. When on, render() logs
// each scheduled render with a stack trace fingerprint and updates a
// tiny corner overlay showing renders-per-second.
const DEBUG_RENDER = (() => {
  try {
    return new URLSearchParams(window.location.search).get("debug") === "1";
  } catch {
    return false;
  }
})();
let renderCount = 0;
let lastReasons: string[] = [];

export function render(): void {
  if (DEBUG_RENDER) {
    // Capture the call site so we can attribute the schedule. Trim to
    // the most useful bit (caller of render).
    const stack = new Error().stack ?? "";
    const lines = stack.split("\n").slice(1, 5);
    const trace = lines.map((l) => l.trim()).join(" ← ");
    lastReasons.push(`${new Date().toISOString().slice(11, 23)} ${trace}`);
    if (lastReasons.length > 20) lastReasons = lastReasons.slice(-20);
  }
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    if (buttonPressed) {
      // Defer until the press releases instead of dropping the render.
      render();
      return;
    }
    actuallyRender();
    if (DEBUG_RENDER) {
      renderCount += 1;
      updateDebugOverlay();
    }
  });
}

function updateDebugOverlay(): void {
  let overlay = document.getElementById("__render_debug__");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "__render_debug__";
    overlay.style.cssText =
      "position:fixed;top:0.5rem;right:0.5rem;z-index:9999;background:rgba(0,0,0,0.85);color:#9fd;padding:0.4rem 0.6rem;font:11px/1.3 ui-monospace,monospace;border:1px solid #6ea8fe;border-radius:6px;max-width:30rem;max-height:14rem;overflow:auto;pointer-events:none;white-space:pre-wrap";
    document.body.appendChild(overlay);
  }
  const recent = lastReasons.slice(-5).join("\n");
  overlay.textContent = `renders: ${renderCount}\n${recent}`;
}

function actuallyRender(): void {
  const root = document.getElementById("app");
  if (!root) return;
  // Capture focus + caret before tearing down the tree so we can
  // restore them on the matching node afterwards. Any element that
  // wants to survive renders should set data-focus-key="…".
  const active = document.activeElement as HTMLElement | null;
  let focusKey: string | null = null;
  let selStart: number | null = null;
  let selEnd: number | null = null;
  if (
    active &&
    active !== document.body &&
    active.dataset &&
    active.dataset.focusKey
  ) {
    focusKey = active.dataset.focusKey;
    if ("selectionStart" in active) {
      try {
        selStart = (active as HTMLInputElement).selectionStart;
        selEnd = (active as HTMLInputElement).selectionEnd;
      } catch {
        // Some input types throw on selection access; ignore.
      }
    }
  }

  // Capture chat-body scroll state. If the user was within ~50px of
  // the bottom we'll snap to the new bottom (so streaming text stays
  // visible); otherwise we restore their exact scrollTop so reading
  // history isn't disrupted by every render. Doing this synchronously
  // (no setTimeout) avoids the one-frame "scroll-from-zero" flash that
  // showed up as text shifting around.
  const oldBody = root.querySelector<HTMLElement>(".chat-body");
  let oldScrollTop: number | null = null;
  let oldWasAtBottom = true;
  if (oldBody) {
    oldScrollTop = oldBody.scrollTop;
    oldWasAtBottom =
      oldBody.scrollHeight - oldBody.scrollTop - oldBody.clientHeight < 50;
  }
  const oldList = root.querySelector<HTMLElement>(".list");
  const oldListScrollTop = oldList ? oldList.scrollTop : null;
  const oldFilesBody = root.querySelector<HTMLElement>(".files .body");
  const oldFilesBodyScrollTop = oldFilesBody ? oldFilesBody.scrollTop : null;
  const oldFilesPreview = root.querySelector<HTMLElement>(".files .preview");
  const oldFilesPreviewScrollTop = oldFilesPreview ? oldFilesPreview.scrollTop : null;

  root.replaceChildren();
  renderApp(root, state);

  const newBody = root.querySelector<HTMLElement>(".chat-body");
  if (newBody) {
    if (oldScrollTop === null || oldWasAtBottom) {
      newBody.scrollTop = newBody.scrollHeight;
    } else {
      newBody.scrollTop = oldScrollTop;
    }
  }
  const newList = root.querySelector<HTMLElement>(".list");
  if (newList && oldListScrollTop !== null) {
    newList.scrollTop = oldListScrollTop;
  }
  const newFilesBody = root.querySelector<HTMLElement>(".files .body");
  if (newFilesBody && oldFilesBodyScrollTop !== null) {
    newFilesBody.scrollTop = oldFilesBodyScrollTop;
  }
  const newFilesPreview = root.querySelector<HTMLElement>(".files .preview");
  if (newFilesPreview && oldFilesPreviewScrollTop !== null) {
    newFilesPreview.scrollTop = oldFilesPreviewScrollTop;
  }

  if (focusKey) {
    const next = root.querySelector<HTMLElement>(
      `[data-focus-key="${CSS.escape(focusKey)}"]`,
    );
    if (next) {
      next.focus();
      const inputLike = next as HTMLInputElement;
      if (selStart !== null && typeof inputLike.setSelectionRange === "function") {
        try {
          inputLike.setSelectionRange(selStart, selEnd!);
        } catch {
          // Fall through silently.
        }
      }
    }
  }
}
