// Render coalescer: multiple synchronous render() calls within one
// animation frame collapse into a single repaint. Saves and restores
// focus/caret on any element with a `data-focus-key` so re-renders
// don't blow away the user's typing position.

import { state } from "./state.js";
import { hasActiveSelection } from "./dom.js";
import {
  renderApp,
  resyncChatScroll,
  tryPatchChat,
  tryRestoreScrollAnchor,
  updateTurnToast,
} from "./views.js";

let scheduled = false;

// actuallyRender() rebuilds the WHOLE tree from scratch every time,
// including a full markdown re-parse of every currently-streaming
// message bubble's full accumulated text (see markdown.ts — there's no
// incremental append path). A fast turn fires agent_message_chunk many
// times a second, each one landing on its own animation frame (the
// rAF-based coalescing above only merges calls within the SAME frame,
// not across consecutive ones), so a long response reparses its own
// growing text from scratch dozens of times a second — O(n^2) in the
// final message length, and each individual rebuild gets slower as the
// message grows. That's expensive enough on its own to block the main
// thread for a real stretch regardless of touch timing, which is why
// gating on pointer state (above) didn't fully fix reported hangs: it
// only avoids racing a rebuild against a gesture, not the rebuild's own
// cost. Throttling to at most one rebuild per MIN_RENDER_INTERVAL_MS
// caps how often that O(n^2) cost gets paid without hurting perceived
// liveness — a chat updating every 100ms still reads as live streaming.
const MIN_RENDER_INTERVAL_MS = 100;
let lastRenderAt = 0;

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
// Set when a render() request arrived while the pointer was down and had
// to be held. Release only flushes when this is set — an ordinary tap
// with no render activity during the press must NOT trigger a render of
// its own, because that rebuild lands exactly when the browser is
// attaching native UI to the tapped element (a <select>'s picker, a text
// input's keyboard) and kills it before it's visible.
let renderHeldByPress = false;
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
    if (!renderHeldByPress) return;
    renderHeldByPress = false;
    // A click-and-drag text selection resolves exactly on this same
    // pointerup — flushing the held render right here tears down (or,
    // on the patch path, moves) the bubble the selection lives in and
    // the browser drops it before the user ever sees it land. Hold off
    // the same way a form control's native UI does below; selectionGate
    // below picks it back up once the selection is gone.
    if (hasActiveSelection()) {
      renderHeldBySelection = true;
      return;
    }
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") {
      // A tap on a form control's native focus sequence (keyboard for
      // text inputs, picker sheet for selects) can trail the touch by a
      // frame or more. If a render lands in that gap it tears down and
      // recreates the control, and the native UI attached to the old
      // node dies before it's visible — WebKit in particular only opens
      // the keyboard for a focus() inside a trusted-gesture callstack,
      // so the rAF-deferred focus restore can't bring it back. Give the
      // native sequence a beat to finish before rebuilding.
      setTimeout(render, 300);
      return;
    }
    render();
  },
  true,
);
// Selecting text isn't only a pointer-drag gesture (double-click,
// shift+arrow, "select all") and a selection can also sit there for a
// while after it's made — any of the render triggers that fire
// continuously during an active turn (streaming chunks, polling) would
// otherwise land moments later and clear it anyway. Picks back up
// automatically once the selection is gone, whether that's the user
// clicking elsewhere or copying it out.
let renderHeldBySelection = false;
document.addEventListener("selectionchange", () => {
  if (!renderHeldBySelection || hasActiveSelection()) return;
  renderHeldBySelection = false;
  render();
});
document.addEventListener(
  "pointercancel",
  () => {
    pointerDown = false;
    // The browser took the gesture (native scroll, system sheet). Flush
    // any held render; the patch path no longer disturbs the scroller.
    if (renderHeldByPress) {
      renderHeldByPress = false;
      render();
    }
  },
  true,
);

// Same idea as the pointer gate above, extended to keystrokes. During
// an active turn, render() gets called roughly every
// MIN_RENDER_INTERVAL_MS for the turn's whole duration (each streamed
// chunk retriggers it), and actuallyRender/tryPatchChat's real cost —
// see the comment below — lands on the same main thread as keystroke
// handling every single time, not just once. That's what made typing
// specifically feel worse while a turn was streaming, separate from
// (and on top of) the render cost itself. Defer while there's been a
// keystroke in the last TYPING_HOLDOFF_MS; whatever triggers the next
// render() call — the next chunk, turn_complete, anything — naturally
// re-evaluates and either defers again or flushes once typing has
// actually paused, the same self-chaining way the pointer gate doesn't
// need an explicit "still down" poll loop either.
const TYPING_HOLDOFF_MS = 250;
let lastKeystrokeAt = 0;
export function noteTypingActivity(): void {
  lastKeystrokeAt = performance.now();
}
// Exported for api.ts's poll guard — same "genuinely, recently typing"
// signal, not just "a text input happens to have focus" (see there).
export function isActivelyTyping(): boolean {
  const active = document.activeElement;
  if (
    !(active instanceof HTMLTextAreaElement) &&
    !(active instanceof HTMLInputElement)
  ) {
    return false;
  }
  return performance.now() - lastKeystrokeAt < TYPING_HOLDOFF_MS;
}
let renderHeldByTyping = false;

export function render(): void {
  if (scheduled) return;
  scheduled = true;
  const sinceLast = performance.now() - lastRenderAt;
  const delay = Math.max(0, MIN_RENDER_INTERVAL_MS - sinceLast);
  const fire = (): void => {
    scheduled = false;
    if (pointerDown) {
      // Park it; pointerup/pointercancel flushes. No rAF respin — that
      // was a busy-loop for the whole duration of every press.
      renderHeldByPress = true;
      return;
    }
    if (isActivelyTyping()) {
      renderHeldByTyping = true;
      setTimeout(() => {
        if (renderHeldByTyping) {
          renderHeldByTyping = false;
          render();
        }
      }, TYPING_HOLDOFF_MS);
      return;
    }
    if (hasActiveSelection()) {
      // A selection can just be sitting there, made moments ago and not
      // yet acted on — same risk as the pointerup case above (see its
      // comment), just without a gesture in flight to hang the gate off
      // of. selectionchange (above) flushes this once it's gone.
      renderHeldBySelection = true;
      return;
    }
    lastRenderAt = performance.now();
    actuallyRender();
  };
  if (delay > 0) {
    setTimeout(() => requestAnimationFrame(fire), delay);
  } else {
    requestAnimationFrame(fire);
  }
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
  const restoreFocus = (): void => {
    if (!focusKey) return;
    const next = root.querySelector<HTMLElement>(
      `[data-focus-key="${CSS.escape(focusKey)}"]`,
    );
    if (!next) return;
    next.focus();
    const inputLike = next as HTMLInputElement;
    if (selStart !== null && typeof inputLike.setSelectionRange === "function") {
      try {
        inputLike.setSelectionRange(selStart, selEnd!);
      } catch {
        // Fall through silently.
      }
    }
  };

  // In-place patch for "same chat, nothing structural changed": the
  // scroll container and unchanged bubbles are left alone entirely, so
  // scroll momentum and in-progress taps survive streaming repaints.
  // Falls through to the teardown path on view/session/banner/modal
  // transitions.
  if (tryPatchChat(root, state)) {
    restoreFocus();
    return;
  }

  // Capture chat-body's scrollTop so a teardown-then-reattach (this path
  // runs whenever a banner/modal/file-overlay makes tryPatchChat bail —
  // e.g. an auto-triggered "Context compacted" banner or a reconnect
  // notice, which can land mid-scroll same as anything else) doesn't
  // lose the user's read position even if the browser resets scrollTop
  // on detach. Whether to additionally snap to bottom is NOT decided
  // here — that's resyncChatScroll's job below, gated the same way as
  // every other scroll-pin path (no finger down, scroller settled). An
  // earlier version snapped unconditionally whenever the OLD body read
  // "near bottom," with no such gating, and reproduced the exact
  // scroll-wedge bug this file spent a whole pass fixing elsewhere.
  const oldBody = root.querySelector<HTMLElement>(".chat-body");
  const oldScrollTop = oldBody ? oldBody.scrollTop : null;
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
    // requestFullHistory (routing.ts) rebuilds the log from scratch —
    // brand-new LogItem objects, typically MORE history above what was
    // previously loaded — so the raw scrollTop captured above no longer
    // points at the same message; that's the "random place" a full
    // reload used to land on. tryRestoreScrollAnchor (views.ts) is also
    // called from tryPatchChat's patch path — the log reset can start
    // matching that path's structural check before any replay content
    // has arrived, well before this teardown branch would otherwise be
    // the one to find it.
    if (!tryRestoreScrollAnchor(newBody) && oldScrollTop !== null) {
      newBody.scrollTop = oldScrollTop;
    }
    if (state.current) {
      resyncChatScroll(state.current);
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
    const turnToast = newBody.querySelector<HTMLElement>(".turn-toast");
    if (turnToast) {
      updateTurnToast(newBody, turnToast);
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

  restoreFocus();
}
