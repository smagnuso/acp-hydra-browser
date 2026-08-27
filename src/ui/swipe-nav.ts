// Swipe navigation between the session list and a chat:
//   - List → chat: swipe right-to-left anywhere on the list to jump
//     back into the session you last closed (state.lastSessionId,
//     stashed by closeChat() in routing.ts).
//   - Chat → list: swipe left-to-right anywhere in the chat to close
//     it. Rather than gating by a fixed start zone (too narrow to hit
//     reliably; too wide and it starts eating the composer/header),
//     hasScrollableLeftAncestor bails only when the touch actually
//     landed on something that could itself consume a rightward drag —
//     a horizontally-scrolled code block or table (index.html's
//     `pre`/`.msg .body table` overflow-x: auto) with room left to
//     scroll — and isFormControl bails on text inputs so a text-
//     selection drag in the composer isn't hijacked. Everything else
//     in the chat (bubbles, header, armed-tasks block, …) arms it.
//
// The chat is always the topmost, frontmost layer — whether it's
// departing (a back swipe) or arriving (a forward swipe) — mirroring
// how a native push/pop transition always keeps the pushed view
// frontmost regardless of direction; the list, as the "root" underneath
// it, always gets a parallax recede + darkening scrim instead. Whichever
// side is real, live DOM (#app's direct children — one for chat, three
// for list: topbar/search/list) is dragged directly via an inline
// transform; the OTHER side is a static preview inserted for the
// gesture. Committing past THRESHOLD_PX finishes that motion, then
// hands off to the real navigation. Swiping back into the
// exact session you just left is special-cased end to end: the reveal
// pane reuses that session's real, still-intact chat DOM (still cached
// by identity in views.ts's chatViews WeakMap even though closeChat()
// detached it), and committing resumes that SAME ChatState in place
// (routing.ts's reopenClosedChat) rather than opening a fresh one from
// scratch — which would reset the log to empty and the scroll to top
// right as the preview showing the real, already-scrolled transcript
// hands off, reading as a flicker. Every other case (a different
// session, or list -> list — i.e. closeChat()) still tears down and
// rebuilds #app from scratch as normal. Cancelling animates everything
// back and cleans up by hand either way.
//
// Only wired up in narrow layout: in split view both panes are already
// on screen side by side, so there's nothing to reveal.
//
// Mirrors pull-refresh.ts's touch-gesture shape otherwise: module-level
// touch state, document-level listeners, a direction lock so a normal
// vertical scroll is never disturbed. touchmove only calls
// preventDefault() once locked into a confirmed horizontal swipe (same
// override pull-refresh.ts uses for its own gesture) — before that,
// while a touch is still an undecided candidate, it's left completely
// alone. Without it, the touch's target (still whatever was under the
// finger at touchstart — the departing chat's own scrollable body, on a
// back swipe) can keep honoring the browser's native vertical scroll
// for the rest of THIS SAME touch even after the horizontal drag has
// locked in, since a passive listener never gets the chance to say
// otherwise — the two visibly fighting over the one finger.

import { state } from "./state.js";
import {
  openChat,
  closeChat,
  getLastClosedChat,
  getLastClosedScrollTop,
  reopenClosedChat,
} from "./routing.js";
import { isFormControl, isWideLayout } from "./dom.js";
import { buildChatPreviewPane, buildListPreviewPane, peekChatViewRoot } from "./views.js";
import { beginExternalRenderHold, endExternalRenderHold } from "./renderer.js";
import type { ChatState } from "./types.js";

const THRESHOLD_PX = 80;
const DIRECTION_LOCK_PX = 12;
// Peak scrim darkness — the list's only motion cue. It never moves
// itself, whether it's being revealed or covered; only chat does.
const SCRIM_MAX_OPACITY = 0.25;
const SETTLE_MS = 220;

function hasScrollableLeftAncestor(target: EventTarget | null): boolean {
  let el = target instanceof Element ? target : null;
  while (el && el !== document.body) {
    if (el.scrollWidth > el.clientWidth && el.scrollLeft > 0) {
      return true;
    }
    el = el.parentElement;
  }
  return false;
}

type Mode = "toChat" | "toList";

let startX: number | null = null;
let startY: number | null = null;
let mode: Mode | null = null;
let candidate = false;
let locked = false;

// The real, live DOM nodes making up the departing view (#app's direct
// children) — dragged in place, never replaced. Populated once the
// gesture locks in onTouchMove, cleared on cleanup.
let frontNodes: HTMLElement[] = [];
// The synthetic preview layer behind them, inserted fresh per gesture.
let revealLayer: HTMLElement | null = null;
let revealContent: HTMLElement | null = null;
let revealScrim: HTMLElement | null = null;
// Set alongside revealContent when the reveal pane is the just-closed
// session's real cached ChatState (see buildRevealPane) — commit()
// hands this to reopenClosedChat() so a completed swipe resumes that
// SAME state in place instead of opening a brand new one from scratch.
let revealChatState: ChatState | null = null;
// A scrolled container's scrollTop resets to 0 when its node is removed
// from the document and later reattached elsewhere — the same class of
// bug syncChildren hit reordering chat log nodes (see acp.ts's history).
// closeChat()'s teardown already detached the cached .chat node once;
// re-inserting it into revealContent here is a second detach/reattach
// cycle, which reset .chat-body's scroll to the top for the duration of
// the drag before the real render's own scroll-restore logic snapped it
// back on release. The value has to come from routing.ts's
// getLastClosedScrollTop() (captured once, synchronously, while the
// node was still live) rather than a fresh .scrollTop read here — by
// the time this runs the node may already have been detached/reattached
// once by a prior, cancelled attempt at this same gesture, which would
// just be reading back our own already-reset value. Only the .chat-body
// element reference itself needs a fresh lookup each time (to apply the
// value to); found in buildRevealPane, reapplied once armDrag has
// actually inserted the node.
let revealScrollFixup: { body: HTMLElement; top: number } | null = null;

function buildRevealPane(m: Mode): HTMLElement | null {
  revealChatState = null;
  revealScrollFixup = null;
  if (m === "toList") {
    return buildListPreviewPane();
  }
  const target = state.lastSessionId;
  if (!target) return null;
  // Common case a swipe-back invites: swiping straight back into the
  // session you just left. Its real chat DOM (transcript, scroll
  // position, everything) is still sitting in memory, just detached —
  // reuse it outright instead of a blank/loading placeholder. commit()
  // below goes one step further and resumes this SAME state rather
  // than reconnecting from scratch, avoiding a flicker back to an
  // empty, top-scrolled chat right after this preview showed the real,
  // already-scrolled one.
  const lastClosed = getLastClosedChat();
  if (lastClosed && lastClosed.sessionId === target) {
    const cachedRoot = peekChatViewRoot(lastClosed);
    if (cachedRoot) {
      // This exact node was the departing frontNode the last time
      // *this* view got swiped away — commit() left it translated
      // fully off-screen (and z-indexed) on the assumption the real
      // render's teardown would discard it, which no longer happens
      // now that this reference keeps it alive. Strip that leftover
      // styling or it reappears here still transformed out of view —
      // present in the DOM, invisible on screen.
      cachedRoot.style.transform = "";
      cachedRoot.style.transition = "";
      cachedRoot.style.zIndex = "";
      revealChatState = lastClosed;
      const body = cachedRoot.querySelector<HTMLElement>(".chat-body");
      if (body) {
        revealScrollFixup = { body, top: getLastClosedScrollTop() };
      }
      return cachedRoot;
    }
  }
  const session = state.sessions.find((s) => s.sessionId === target);
  return session ? buildChatPreviewPane(session) : null;
}

// Arms the drag visuals on first confirmed movement — not on
// touchstart, since plenty of arm-eligible touches never turn into a
// real drag (a tap, a vertical scroll) and building/inserting the
// preview pane for those would be wasted work every time.
function armDrag(m: Mode): boolean {
  const app = document.getElementById("app");
  if (!app) return false;
  const pane = buildRevealPane(m);
  if (!pane) return false;
  frontNodes = Array.from(app.children) as HTMLElement[];
  if (frontNodes.length === 0) return false;
  revealContent = document.createElement("div");
  revealContent.className = "swipe-reveal-content";
  revealContent.appendChild(pane);
  revealLayer = document.createElement("div");
  revealLayer.className = "swipe-reveal-layer";
  revealLayer.appendChild(revealContent);
  // A plain sibling of revealLayer, not nested inside it — for a
  // forward swipe the thing needing dimming (the list) is frontNodes,
  // entirely outside revealLayer's subtree, so the scrim can't live in
  // there and still reach it. Positioned identically (inset: 0) either
  // way; z-index alone decides which side it's actually dimming.
  revealScrim = document.createElement("div");
  revealScrim.className = "swipe-reveal-scrim";
  // Chat is frontNodes (departing) on a back swipe, or revealLayer
  // (arriving) on a forward one — either way it stays on top, the list
  // stays behind the scrim. See the module comment for why.
  const chatIsFrontNodes = m === "toList";
  for (const node of frontNodes) {
    node.style.zIndex = chatIsFrontNodes ? "2" : "0";
  }
  revealLayer.style.zIndex = chatIsFrontNodes ? "0" : "2";
  revealScrim.style.zIndex = "1";
  app.insertBefore(revealScrim, app.firstChild);
  app.insertBefore(revealLayer, app.firstChild);
  if (revealScrollFixup) {
    revealScrollFixup.body.scrollTop = revealScrollFixup.top;
  }
  // A render landing mid-drag is already held off by renderer.ts's
  // ordinary pointerDown gate — but that gate's pointerup handler
  // flushes a held render immediately, synchronously, BEFORE this
  // gesture's own touchend handler ever runs (pointerup precedes
  // touchend on the same release). Left alone, releasing after a poll
  // fired mid-drag replaced the whole custom transform + preview with a
  // freshly-rendered, untouched view a beat before commit()/cancel()
  // got to run — the drag visibly snapping away as if it had never
  // happened. Held until this gesture's own animated release finishes.
  beginExternalRenderHold();
  return true;
}

// Whichever side is chat always tracks the finger directly (dx, 1:1) —
// on a back swipe it's already fully on screen and just moves by dx; on
// a forward swipe it starts translated a full viewport width off-screen
// and dx (negative) counts down from there, so it arrives at the same
// literal pixel rate the finger moves at instead of racing ahead of it.
// Only THRESHOLD_PX worth of that (80px) plays out during the drag
// itself — same as the back swipe only reveals an 80px sliver of what's
// underneath before release — commit() below finishes sliding the rest
// of the way on its own. The list — the "root" underneath, whichever
// direction — never moves at all; the scrim (fading in as chat covers
// it, fading out as chat reveals it) is its only motion cue, driven by
// progress (0 at rest, 1 at/past the threshold).
function paint(dx: number, m: Mode): void {
  if (!revealContent || !revealScrim) return;
  const progress = Math.min(Math.abs(dx) / THRESHOLD_PX, 1);
  if (m === "toList") {
    for (const node of frontNodes) {
      node.style.transform = `translateX(${dx}px)`;
    }
    revealScrim.style.opacity = String(SCRIM_MAX_OPACITY * (1 - progress));
  } else {
    const w = window.innerWidth;
    revealContent.style.transform = `translateX(${w + dx}px)`;
    revealScrim.style.opacity = String(SCRIM_MAX_OPACITY * progress);
  }
}

function cleanup(): void {
  for (const node of frontNodes) {
    node.style.transform = "";
    node.style.transition = "";
    node.style.zIndex = "";
  }
  frontNodes = [];
  revealLayer?.remove();
  revealScrim?.remove();
  revealLayer = null;
  revealContent = null;
  revealScrim = null;
  revealChatState = null;
  revealScrollFixup = null;
  // Flushes anything a poll queued mid-drag, now that it's safe to.
  endExternalRenderHold();
}

// Finishes the drag at full speed (transform's own transition) before
// handing off to the real navigation — snapping instantly on release
// reads as an interrupted gesture, not a completed one.
function commit(m: Mode): void {
  const w = window.innerWidth;
  if (m === "toList") {
    // Chat (frontNodes) finishes sliding off-screen; list never moved,
    // nothing to settle beyond its scrim clearing.
    for (const node of frontNodes) {
      node.style.transition = `transform ${SETTLE_MS}ms ease-out`;
      node.style.transform = `translateX(${w}px)`;
    }
    if (revealScrim) {
      revealScrim.style.transition = `opacity ${SETTLE_MS}ms ease-out`;
      revealScrim.style.opacity = "0";
    }
  } else {
    // Chat (revealContent) finishes sweeping fully into place on top;
    // list stays put underneath, now fully covered regardless (scrim at
    // peak, matching).
    if (revealContent) {
      revealContent.style.transition = `transform ${SETTLE_MS}ms ease-out`;
      revealContent.style.transform = "translateX(0)";
    }
    if (revealScrim) {
      revealScrim.style.transition = `opacity ${SETTLE_MS}ms ease-out`;
      revealScrim.style.opacity = String(SCRIM_MAX_OPACITY);
    }
  }
  const chatState = revealChatState;
  setTimeout(() => {
    // Release the hold before triggering the real navigation below —
    // both paths end in a render() that's itself still subject to this
    // same gate.
    endExternalRenderHold();
    // The real render tears down and rebuilds #app's DOM from scratch
    // either way, which discards revealLayer and frontNodes' inline
    // styles along with everything else — nothing left to clean up on
    // this path. reopenClosedChat's ChatState survives that teardown
    // regardless (ensureChatView/views.ts reuses its existing view by
    // identity), which is the whole point: no rebuilt-from-empty flash.
    if (m === "toList") {
      closeChat();
      return;
    }
    if (chatState && reopenClosedChat(chatState)) {
      return;
    }
    const target = state.lastSessionId;
    const session = target ? state.sessions.find((s) => s.sessionId === target) : undefined;
    if (target && session) {
      openChat(target, session.status === "cold");
    } else {
      // Session vanished mid-gesture (killed, filtered out) — nothing
      // to open. cleanup() by hand since no real render is coming.
      cleanup();
    }
  }, SETTLE_MS);
}

function cancel(): void {
  for (const node of frontNodes) {
    node.style.transition = `transform ${SETTLE_MS}ms ease-out`;
    node.style.transform = "translateX(0)";
  }
  if (revealContent) {
    revealContent.style.transition = `transform ${SETTLE_MS}ms ease-out`;
  }
  paint(0, mode ?? "toList");
  setTimeout(cleanup, SETTLE_MS);
}

function reset(): void {
  startX = null;
  startY = null;
  mode = null;
  candidate = false;
  locked = false;
}

function onTouchStart(e: TouchEvent): void {
  reset();
  if (isWideLayout() || state.modal || state.banner) return;
  const touch = e.touches[0];
  if (!touch) return;
  if (state.view === "list" && state.lastSessionId) {
    mode = "toChat";
  } else if (
    state.view === "chat" &&
    !isFormControl(touch.target) &&
    !hasScrollableLeftAncestor(touch.target)
  ) {
    mode = "toList";
  } else {
    return;
  }
  startX = touch.clientX;
  startY = touch.clientY;
  candidate = true;
}

function onTouchMove(e: TouchEvent): void {
  if (!candidate || startX === null || startY === null || !mode) return;
  const touch = e.touches[0];
  if (!touch) return;
  const dx = touch.clientX - startX;
  const dy = touch.clientY - startY;
  if (!locked) {
    if (Math.abs(dx) < DIRECTION_LOCK_PX && Math.abs(dy) < DIRECTION_LOCK_PX) {
      return;
    }
    // Only lock into the gesture for a clearly horizontal drag in the
    // direction this mode expects — anything more vertical (or the
    // opposite direction) is a normal scroll or pull-to-refresh, left
    // completely alone.
    const directionOk = mode === "toChat" ? dx < 0 : dx > 0;
    if (Math.abs(dy) > Math.abs(dx) || !directionOk) {
      candidate = false;
      return;
    }
    locked = true;
    if (!armDrag(mode)) {
      candidate = false;
      locked = false;
      return;
    }
  }
  // Locked in as our gesture now — stop the browser from also scrolling
  // whatever's still nominally under this touch alongside it.
  e.preventDefault();
  paint(dx, mode);
}

function onTouchEnd(e: TouchEvent): void {
  if (!locked || startX === null || !mode) {
    reset();
    return;
  }
  const touch = e.changedTouches[0];
  const dx = touch ? touch.clientX - startX : 0;
  const past = mode === "toChat" ? dx <= -THRESHOLD_PX : dx >= THRESHOLD_PX;
  if (past) {
    commit(mode);
  } else {
    cancel();
  }
  reset();
}

function onTouchCancel(): void {
  if (locked) {
    cancel();
  }
  reset();
}

export function initSwipeBack(): void {
  document.addEventListener("touchstart", onTouchStart, { passive: true });
  // Non-passive: onTouchMove calls preventDefault() once locked into a
  // confirmed horizontal swipe, to override the browser's native
  // scroll for the rest of that touch. See the module comment.
  document.addEventListener("touchmove", onTouchMove, { passive: false });
  document.addEventListener("touchend", onTouchEnd, { passive: true });
  document.addEventListener("touchcancel", onTouchCancel, { passive: true });
}
