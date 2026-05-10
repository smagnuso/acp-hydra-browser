// Render coalescer: multiple synchronous render() calls within one
// animation frame collapse into a single repaint. Saves and restores
// focus/caret on any element with a `data-focus-key` so re-renders
// don't blow away the user's typing position.

import { state } from "./state.js";
import { renderApp } from "./views.js";

let scheduled = false;

export function render(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
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

  root.replaceChildren();
  renderApp(root, state);

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
