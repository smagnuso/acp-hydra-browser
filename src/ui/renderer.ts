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
// while a pointer is physically down we hold off on the actual rebuild;
// the deferred render flushes on release.
//
// Originally scoped to button presses only, but the same teardown hits
// touch-scrolling just as hard: a fast-streaming turn fires
// agent_message_chunk many times a second, each one tearing out and
// recreating .chat-body out from under an in-progress touch-drag, which
// is what made scrolling go dead for a few seconds during bursty agent
// output — not just on session attach. Gating on ANY pointerdown (not
// only ones that hit a <button>) covers that: a touch-driven scroll
// gesture fires pointerdown/pointermove/pointerup the same as a tap, so
// this defers the rebuild for the gesture's whole duration and lets it
// catch up in one shot on release instead of yanking the scroll
// container out from under every finger movement.
let pointerDown = false;
document.addEventListener(
  "pointerdown",
  () => {
    pointerDown = true;
  },
  true,
);
document.addEventListener(
  "pointerup",
  (e) => {
    if (!pointerDown) return;
    pointerDown = false;
    const target = e.target as HTMLElement | null;
    if (target?.tagName === "TEXTAREA" || target?.tagName === "INPUT") {
      // A tap on a text input's native focus-and-open-keyboard sequence
      // can trail the touch by a frame or more (same story as
      // tapHandler's synthetic click). If a render lands in that gap it
      // tears down and recreates the input, and the focus restore below
      // calls .focus() from a deferred rAF callback rather than directly
      // inside the tap's own handler — WebKit in particular only opens
      // the on-screen keyboard for a focus() trusted-gesture callstack,
      // so the DOM focus "succeeds" but the keyboard never shows,
      // and the user has to tap again. Give the native sequence a beat
      // to finish before tearing the node down again.
      setTimeout(render, 300);
      return;
    }
    render();
  },
  true,
);
document.addEventListener(
  "pointercancel",
  () => {
    pointerDown = false;
  },
  true,
);

export function render(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    if (pointerDown) {
      // Defer until the press/drag releases instead of dropping the render.
      render();
      return;
    }
    actuallyRender();
  });
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
    // The jump-to-latest button only updates its own visibility on a
    // "scroll" event, which a scrollTop assignment doesn't reliably fire
    // synchronously — sync it here so a re-render that lands while
    // scrolled up doesn't show the button late (or hide it early once
    // snapped to bottom).
    const jumpToLatest = newBody.querySelector<HTMLElement>(".jump-to-latest");
    if (jumpToLatest) {
      const atBottom = newBody.scrollHeight - newBody.scrollTop - newBody.clientHeight < 50;
      jumpToLatest.classList.toggle("visible", !atBottom);
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
