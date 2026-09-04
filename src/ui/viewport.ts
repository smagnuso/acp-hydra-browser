// iOS — especially this app added to the home screen as a standalone
// PWA — doesn't reliably re-lay-out a `height: 100%` chain when the
// on-screen keyboard shows/hides: #app ends up sized against a stale
// viewport, leaving a blank gap at the bottom equal to the difference
// once the keyboard closes. window.visualViewport tracks the actual
// visible area live, so drive #app's height off a custom property fed
// by it instead of the CSS percentage chain.
//
// Sizing alone isn't enough, though: body is position:fixed (see
// index.html) so the page itself can't be document-scrolled to reveal a
// focused input, but WebKit fixes `position: fixed` elements to the
// *layout* viewport, not the *visual* one. When the keyboard opens, iOS
// instead pans the visual viewport down over the (unmoved) layout
// viewport to bring the focused input into view — visualViewport.offsetTop
// is that pan distance — and a fixed element that doesn't know about the
// pan appears to slide up off the top of the screen by the same amount.
// Countering it with a translateY of +offsetTop cancels the pan out.
// Minimum shrinkage (current viewport vs. the tallest seen at this
// orientation) before we treat it as "the keyboard is up" rather than
// noise. Comfortably below even a small predictive-text-only keyboard
// (150pt+) and comfortably above anything else that nudges
// visualViewport.height by a few px.
const KEYBOARD_HEIGHT_THRESHOLD_PX = 100;

// On-screen viewport readout for debugging keyboard/viewport sizing
// from a phone with no attached debugger (?vpdebug=1). This is how the
// standalone dead-strip bug was found — see the status-bar-style meta
// in index.html.
const DEBUG_VIEWPORT = (() => {
  try {
    return new URLSearchParams(window.location.search).get("vpdebug") === "1";
  } catch {
    return false;
  }
})();

function updateDebugOverlay(h: number, offsetTop: number, keyboardOpen: boolean): void {
  let overlay = document.getElementById("__viewport_debug__");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "__viewport_debug__";
    // Deliberately NOT position:fixed. Two rounds of that (as a body
    // child, then as a documentElement child) both went invisible once
    // the keyboard opened — position:fixed is exactly the mechanism
    // under suspicion here, so trusting it for the *diagnostic* overlay
    // is circular. position:absolute anchors to body's (possibly
    // transformed) box instead: it rides along with whatever body does,
    // same as #app, but floats over the content without displacing it —
    // static flow at body's top pushed #app's composer off the bottom.
    overlay.style.cssText =
      "position:absolute;top:0;left:0;right:0;z-index:9999;background:rgba(0,0,0,0.85);color:#fd9;padding:0.4rem 0.6rem;font:11px/1.4 ui-monospace,monospace;border:1px solid #d4a17e;border-radius:6px;white-space:pre;pointer-events:none;opacity:0.9";
    document.body.appendChild(overlay);
  }
  const composer = document.querySelector<HTMLElement>(".composer");
  const composerRect = composer?.getBoundingClientRect();
  const composerPadBottom = composer
    ? getComputedStyle(composer).paddingBottom
    : "n/a";
  const app = document.getElementById("app");
  const appRect = app?.getBoundingClientRect();
  const appHeightStyle = app ? getComputedStyle(app).height : "n/a";
  const chatBody = document.querySelector<HTMLElement>(".chat-body");
  const chatBodyRect = chatBody?.getBoundingClientRect();
  // Paint-truth markers: rects can claim whatever they want, these show
  // where WebKit actually stops painting. Lime = the buggy ICB bottom
  // (innerHeight); magenta = the corrected --app-height bottom; cyan
  // outline = the composer button row's true painted extent.
  let limeLine = document.getElementById("__vp_icb_line__");
  if (!limeLine) {
    limeLine = document.createElement("div");
    limeLine.id = "__vp_icb_line__";
    document.body.appendChild(limeLine);
  }
  limeLine.style.cssText = `position:absolute;left:0;right:0;top:${window.innerHeight - 3}px;height:3px;background:lime;z-index:9999;pointer-events:none`;
  let magentaLine = document.getElementById("__vp_app_line__");
  if (!magentaLine) {
    magentaLine = document.createElement("div");
    magentaLine.id = "__vp_app_line__";
    document.body.appendChild(magentaLine);
  }
  magentaLine.style.cssText = `position:absolute;left:0;right:0;top:calc(var(--app-height, 100%) - 3px);height:3px;background:magenta;z-index:9999;pointer-events:none`;
  const buttonRow = document.querySelector<HTMLElement>(".composer-buttons");
  if (buttonRow) {
    buttonRow.style.outline = "2px solid cyan";
  }
  const fmt = (r: DOMRect | undefined): string =>
    r ? `top=${r.top.toFixed(0)} h=${r.height.toFixed(0)} bottom=${r.bottom.toFixed(0)}` : "n/a";
  const bodyRect = document.body.getBoundingClientRect();
  overlay.textContent =
    `innerHeight=${window.innerHeight} appH(vv+inset)=${h.toFixed(1)} inset=${topInsetPx().toFixed(0)}\n` +
    `vv.offsetTop=${offsetTop.toFixed(1)} keyboard-open=${keyboardOpen}\n` +
    `screen.h=${screen.height} docClientH=${document.documentElement.clientHeight}\n` +
    `body ${fmt(bodyRect)}\n` +
    `#app styleH=${appHeightStyle} ${fmt(appRect)}\n` +
    `.chat-body ${fmt(chatBodyRect)}\n` +
    `.composer padBottom=${composerPadBottom} ${fmt(composerRect)}`;
}

// Measures env(safe-area-inset-top) from a hidden probe element, since
// env() isn't readable from JS directly. Why we need it: in home-screen
// standalone mode with a black-translucent status bar, WebKit renders
// the page from the very top of the screen (y=0, behind the clock) but
// *subtracts* the status-bar inset from every height it reports —
// vv.height, innerHeight, and the ICB all read screen-minus-inset
// (measured live: 793 on an 852pt screen, inset 59). Sizing #app from
// vv.height alone therefore leaves an inset-sized dead strip at the
// screen bottom, keyboard open or closed. Adding the inset back
// compensates; in-browser the inset is 0 (Safari's own chrome covers
// the notch) so this is a no-op there.
let insetProbe: HTMLElement | null = null;
function topInsetPx(): number {
  if (!insetProbe) {
    insetProbe = document.createElement("div");
    insetProbe.style.cssText =
      "position:fixed;top:0;left:0;width:1px;height:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none";
    document.documentElement.appendChild(insetProbe);
  }
  return insetProbe.getBoundingClientRect().height;
}

export function initViewportHeight(): void {
  const root = document.documentElement;
  // Tallest corrected viewport seen, keyed by viewport width so a
  // rotation starts a fresh baseline instead of comparing portrait
  // heights against a landscape ceiling.
  const maxHeightByWidth = new Map<number, number>();
  // Last-applied values, so a no-op apply() (same numbers) skips the
  // actual style/class writes. visualViewport fires "scroll" during a
  // .chat-body touch-drag (see below), which without this ran apply()
  // — and its unconditional setProperty/classList.toggle calls — on
  // every tick of the gesture and its rubber-band settle. Mutating an
  // ancestor's layout-affecting style while a nested scroller is mid-
  // momentum is a known way to wedge iOS Safari's compositor scroll
  // layer (scrolling dead, taps fine, until another gesture resets
  // it) — this reproduced with no streaming or app-render activity at
  // all, purely from the visualViewport scroll noise.
  let lastH: number | null = null;
  let lastKeyboardOpen: boolean | null = null;
  let lastOffsetTop: number | null = null;
  // A pointer down anywhere (e.g. reaching for the composer's Send
  // button right after a keystroke) freezes --app-offset-top/--app-height
  // writes until it lifts. Without this, a keyboard-open settle() tick
  // landing between pointerdown and pointerup can shift the composer a
  // few px right under the finger, so the tap's hit-test misses. Pending
  // changes aren't lost — they're just deferred to the apply() this
  // triggers on release, plus whatever tick settle()'s own rAF loop is
  // already mid-way through.
  let pointerActive = false;
  const apply = (): void => {
    if (pointerActive) return;
    const vv = window.visualViewport;
    const h = (vv?.height ?? window.innerHeight) + topInsetPx();
    const rawOffsetTop = vv?.offsetTop ?? 0;
    if (h !== lastH) {
      lastH = h;
      root.style.setProperty("--app-height", `${h}px`);
    }
    // env(safe-area-inset-bottom) is a static device property — it
    // doesn't shrink to 0 just because the keyboard now occupies that
    // strip of the screen instead of the home-indicator gesture area.
    // Left alone, the composer keeps reserving that padding under an
    // open keyboard, leaving a dead gap between it and the keyboard.
    // This class lets index.html's CSS drop the padding only then.
    // Detection compares against the tallest viewport seen rather than
    // window.innerHeight: on iOS innerHeight shrinks in lockstep with
    // vv.height when the keyboard opens, so an innerHeight delta reads
    // ~0 and never fires.
    const widthKey = Math.round(vv?.width ?? window.innerWidth);
    const ceiling = Math.max(h, maxHeightByWidth.get(widthKey) ?? 0);
    maxHeightByWidth.set(widthKey, ceiling);
    const keyboardOpen = ceiling - h > KEYBOARD_HEIGHT_THRESHOLD_PX;
    if (keyboardOpen !== lastKeyboardOpen) {
      lastKeyboardOpen = keyboardOpen;
      root.classList.toggle("keyboard-open", keyboardOpen);
    }
    // visualViewport fires "scroll" for more than the keyboard pan this
    // is meant to counter — a touch-drag inside a scrollable div (e.g.
    // .chat-body) can make WebKit pan the visual viewport itself instead
    // of cleanly scrolling the div, and mirroring that into body's
    // transform unconditionally turns "scroll chat history" into "drag
    // the whole app around, and it doesn't reliably scroll." Only apply
    // the offset while the keyboard is actually open, which is the one
    // case this compensates for.
    const offsetTop = keyboardOpen ? rawOffsetTop : 0;
    if (offsetTop !== lastOffsetTop) {
      lastOffsetTop = offsetTop;
      root.style.setProperty("--app-offset-top", `${offsetTop}px`);
    }
    if (DEBUG_VIEWPORT) updateDebugOverlay(h, offsetTop, keyboardOpen);
  };
  apply();
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", apply);
    window.visualViewport.addEventListener("scroll", apply);
  }
  // Standalone (home-screen) WebKit is known to report a stale, smaller
  // viewport on cold launch / resume and then never fire the
  // visualViewport resize that would correct it — measured live: the
  // in-browser tab sized correctly while the standalone app kept a
  // browser-chrome-sized gap at the bottom with the keyboard closed.
  // Re-apply on every plausible wake-up signal, plus focus transitions
  // (keyboard animation settles asynchronously without a reliable
  // event), plus a 1s heartbeat as the backstop. apply() is cheap and
  // idempotent, so overshooting costs nothing.
  window.addEventListener("resize", apply);
  window.addEventListener("orientationchange", apply);
  window.addEventListener("pageshow", apply);
  window.addEventListener("focus", apply);
  document.addEventListener("visibilitychange", apply);
  window.addEventListener(
    "pointerdown",
    () => {
      pointerActive = true;
    },
    { capture: true }
  );
  const releasePointer = (): void => {
    if (!pointerActive) return;
    pointerActive = false;
    apply();
  };
  window.addEventListener("pointerup", releasePointer, { capture: true });
  window.addEventListener("pointercancel", releasePointer, { capture: true });
  // A fixed handful of setTimeout checkpoints (the previous approach)
  // guesses at how long the keyboard's show/hide animation takes; guess
  // too short and #app's height sits stuck at the old (small) value for
  // a visible beat after the keyboard's already settled, guess too long
  // and there's needless polling. Track visualViewport.height directly
  // instead: re-apply every frame until it stops moving (two
  // consecutive unchanged frames) or a generous ceiling is hit, so
  // #app's height follows the actual animation rather than a fixed
  // schedule — the chat area no longer reads as "stuck small, then
  // snaps" after dismissing the keyboard (composer swipe-to-dismiss
  // made this very visible, but it applies to any focus change).
  const SETTLE_CEILING_MS = 1200;
  let settleRaf = 0;
  const settle = (): void => {
    if (settleRaf) cancelAnimationFrame(settleRaf);
    const deadline = performance.now() + SETTLE_CEILING_MS;
    let lastH: number | null = null;
    let stableFrames = 0;
    const tick = (): void => {
      apply();
      const h = window.visualViewport?.height ?? window.innerHeight;
      if (lastH !== null && Math.abs(h - lastH) < 0.5) {
        stableFrames++;
      } else {
        stableFrames = 0;
      }
      lastH = h;
      if (stableFrames >= 2 || performance.now() >= deadline) {
        settleRaf = 0;
        return;
      }
      settleRaf = requestAnimationFrame(tick);
    };
    settleRaf = requestAnimationFrame(tick);
  };
  document.addEventListener("focusin", settle);
  document.addEventListener("focusout", settle);
  setInterval(apply, 1000);
}
