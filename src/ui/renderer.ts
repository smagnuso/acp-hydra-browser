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

export function render(): void {
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
