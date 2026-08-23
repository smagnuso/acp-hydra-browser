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
// Mirrors pull-refresh.ts's touch-gesture shape otherwise: module-level
// touch state, document-level listeners, a direction lock so a normal
// vertical scroll is never disturbed. Entirely passive — no
// preventDefault — so unlike pull-refresh this can never fight the
// browser's own scrolling.

import { state } from "./state.js";
import { openChat, closeChat } from "./routing.js";
import { isFormControl } from "./dom.js";

const THRESHOLD_PX = 80;
const DIRECTION_LOCK_PX = 12;

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
let hint: HTMLElement | null = null;

function ensureHint(): HTMLElement {
  if (hint) return hint;
  hint = document.createElement("div");
  hint.className = "swipe-back-hint";
  document.body.appendChild(hint);
  return hint;
}

function targetLabel(): string {
  const id = state.lastSessionId;
  const session = state.sessions.find((s) => s.sessionId === id);
  if (session?.title) return session.title;
  return id ? id.slice(0, 12) : "";
}

function setHint(dx: number, m: Mode): void {
  const el = ensureHint();
  const progress = Math.min(Math.abs(dx) / THRESHOLD_PX, 1);
  el.classList.toggle("left", m === "toList");
  if (m === "toChat") {
    el.textContent = (progress >= 1 ? "↩ Release to open " : "← ") + targetLabel();
    el.style.transform = `translate(${Math.min(-dx, THRESHOLD_PX + 20) * -1}px, -50%)`;
  } else {
    el.textContent = progress >= 1 ? "↩ Release for session list" : "Session list →";
    el.style.transform = `translate(${Math.min(dx, THRESHOLD_PX + 20)}px, -50%)`;
  }
  el.style.opacity = progress > 0 ? String(progress) : "0";
}

function hideHint(): void {
  if (!hint) return;
  hint.style.opacity = "0";
}

function reset(): void {
  startX = null;
  startY = null;
  mode = null;
  candidate = false;
  locked = false;
  hideHint();
}

function onTouchStart(e: TouchEvent): void {
  reset();
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
  }
  setHint(dx, mode);
}

function onTouchEnd(e: TouchEvent): void {
  if (!locked || startX === null || !mode) {
    reset();
    return;
  }
  const touch = e.changedTouches[0];
  const dx = touch ? touch.clientX - startX : 0;
  if (mode === "toChat" && dx <= -THRESHOLD_PX) {
    const target = state.lastSessionId;
    const session = target ? state.sessions.find((s) => s.sessionId === target) : undefined;
    if (target && session) {
      openChat(target, session.status === "cold");
    }
  } else if (mode === "toList" && dx >= THRESHOLD_PX) {
    closeChat();
  }
  reset();
}

export function initSwipeBack(): void {
  document.addEventListener("touchstart", onTouchStart, { passive: true });
  document.addEventListener("touchmove", onTouchMove, { passive: true });
  document.addEventListener("touchend", onTouchEnd, { passive: true });
  document.addEventListener("touchcancel", reset, { passive: true });
}
