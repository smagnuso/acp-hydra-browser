# AGENTS.md

Brief for AI agents working in this repo.

## What this is

`hydra-acp-browser` — a browser-based UI **extension** for Hydra. Serves a
small single-page app on localhost that lists live sessions, mirrors them
in real time, and lets you prompt, approve permission requests, switch
modes/models, create/kill sessions, and browse the project files of any
session — from a phone or laptop browser.

The hydra master token never leaves the machine. The browser authenticates
with a separate per-host authkey stored under `~/.hydra-acp/browser/`.

## How it fits into Hydra

Hydra is a multi-client ACP session daemon. Full docs and wire protocol
live at [`smagnuso/hydra-acp`](https://github.com/smagnuso/hydra-acp) — see
`cli/PROTOCOL.md`.

This is a **client extension**: the server-side process connects to the
daemon over REST + WSS using `HYDRA_ACP_TOKEN` and re-exposes a scoped
subset to the browser SPA over its own HTTP + WS surface, gated by the
per-host authkey.

## Layout

- `src/index.ts` — entry point
- `src/server/` — HTTP + WS server the browser talks to
  (`/api/sessions`, `/api/agents`, `/api/kill`, `/api/files/*`,
  `/ws?session=<id>`, …)
- `src/hydra/` — client-side adapter to the daemon (REST + WSS)
- `src/ui/` — the SPA (built by `pnpm build:ui`)
- `src/config.ts`, `src/util/` — config resolution, shared plumbing

Two build steps: `build:server` (tsup → `dist/`) and `build:ui`. Top-level
`build` runs both.

## Build & test

```
npm install
npm run build     # server + UI
npm run build:server
npm run build:ui
npm test          # vitest
npm run lint
```

Ships as `hydra-acp-browser` on PATH. Registered via
`hydra-acp extension add hydra-acp-browser`.

## Conventions

- TypeScript, ESM, tsup for the server, vitest for tests.
- Default bind is localhost only. Anything binding to a non-loopback host
  must require TLS — mirror the daemon's stance.
- Never proxy the hydra master token to the browser. The authkey is the
  browser's credential; keep them separate.
- The browser API surface is a *scoped subset* of the daemon's — don't
  expose management endpoints (auth rotation, extension lifecycle) through
  it.

## Gotchas

- The daemon can restart underneath us; WS reconnect must be transparent
  to the browser (buffer or replay, don't drop state).
- Permission prompts are races (RFD #533). If the user in the browser is
  slow and the TUI answers first, the browser must gracefully accept the
  `permission_resolved` update instead of erroring.
- Files API reads from disk on the daemon's host — respect the session's
  `cwd` as the root and reject path traversal.
- **`fs/*` MCP requests are refused, not proxied** (`ws-bridge.ts`). The
  bridge advertises fs off in initialize; if an agent asks anyway, we
  error. Do NOT "helpfully" forward these — it exposes the daemon's disk
  to any agent.
- **Permission-request buffering by `permissionDelayMs`**
  (`ws-bridge.ts`): sibling controllers (auto-approver) usually resolve
  within milliseconds, so the browser holds the frame in
  `pendingPermissionFrames` keyed by `toolCallId` and drops it if a
  `permission_resolved` notification lands first. RFD #533 keys
  everything by `toolCallId`; don't change the map key.
- **CSRF/token gate runs at WS upgrade time** (`ws-bridge.ts`), before
  `handleUpgrade`. A bad request never allocates a socket. Move-that-code
  refactors will silently trade defense-in-depth for latency.
- **The auth rate limiter is defense-in-depth**, not primary — the
  daemon has its own on `/v1/auth/login`. Removing the local one isn't
  "simplification".
- **The SPA's `render()` is a full teardown** of `#app` (`renderer.ts`),
  and WS/poll events (`bridge.ts`, `acp.ts`, `queue.ts`) can trigger one
  at any point, including mid-tap. On mobile Chrome, `click` is a
  compatibility event synthesized after `pointerup` and can arrive a
  frame or more later — after `render()` has already replaced the
  element out from under it, silently dropping the tap. Every
  interactive element in `views.ts` is wired with `tapHandler()`
  (`dom.ts`), which acts on `pointerup` instead and stops propagation so
  a nested control can't double-fire its container's handler. Any new
  clickable element must use `tapHandler`, not a plain `onclick` — a
  plain `onclick` will "mostly work" in testing and then flake on real
  phones under load.
- **Any independently-scrolling container nested inside the fixed-position
  app shell needs `overscroll-behavior: contain`** (`index.html`:
  `.chat-body`, `.list`, `.files .body`/`.preview`). `body` is
  `position: fixed` and its ancestors (`#app`, `.chat`) are
  `overflow: hidden`, so none of them can actually scroll. Without
  `overscroll-behavior`, iOS Safari's rubber-band bounce at a scroll
  container's boundary tries to chain the remaining overscroll momentum
  to the next scrollable ancestor; the failed handoff can leave that
  container's own scrolling unresponsive (taps still fine) until an
  unrelated touch resets its internal state. Reproduces with zero app
  JS involved — a pure CSS/scroll-chaining bug, not a render or pin
  timing issue. Any new independently-scrolling panel needs the same
  property.

## Debugging a "the transcript is missing X" report

Split it into *data* vs *render* before theorising — the two live in
different halves of the system and the answer usually falls out in
minutes. Three levels, cheapest first:

1. **Does the daemon have it?**
   `~/.hydra-acp/sessions/<id>/history.jsonl` is the record of truth;
   `hydra session transcript <id>` is the readable view. If a
   `prompt_received` frame is there, nothing was lost server-side.
2. **Does a full attach replay it?** Connect to the daemon's `/acp`
   directly (`wss://<host>/acp`, subprotocols `acp.v1` and
   `hydra-acp-token.<token>` from `~/.hydra-acp/auth-token`), send
   `initialize` + `session/attach {historyPolicy: "full"}`, and capture
   the notifications. Feeding that capture through the real
   `handleNotification` in a `tsx` script (stub `globalThis.document`,
   hand-build a `ChatState` — see `test/acp-replay-cursor.test.ts`)
   tells you whether the *client logic* renders it, with no browser
   involved.
3. **Does the real SPA render it?** Drive it with headless Chrome over
   CDP: launch with `--remote-debugging-port` + `--ignore-certificate-errors`,
   `Network.setCookie` `hb_session` = the daemon token (the browser
   server only checks the cookie *exists*; the daemon validates it, so
   the master token works and no password is needed),
   `Emulation.setDeviceMetricsOverride` for phone metrics, seed
   `localStorage["hydra-acp-browser:filters"]` to match the reporter's
   `hideThoughts` etc., then dump `.chat-body > *` class names and
   `getBoundingClientRect()`. `Network.webSocketCreated` also shows the
   `afterMessageId`/`afterSeq`/`load` params the SPA actually sent,
   which is the fastest way to tell a full replay from a delta.

Correlate with the two logs, whose clocks match:
`~/.hydra-acp/extensions/hydra-acp-browser/current.log` (`bridge open` /
`browser closed`) and the daemon's `current.log`
(`session/attach OK … requestedPolicy=… appliedPolicy=… replayed=N`).
A `browser closed` landing *before* its own attach response means that
connection's whole replay went nowhere.

If all three levels come back clean, the transcript is intact and the
reporter is looking at a wedged long-lived `ChatState` — a reload fixes
it, and the bug is in whatever teardown dropped the items, not in the
data.

## Updating this file

If you discover a durable, non-obvious invariant while working here — the
kind of thing you wish had been in this file when you started — flag it
in your final turn summary so the human can decide whether to add it. Do
not silently edit AGENTS.md mid-task. Prefer additions to `## Gotchas`
over reworking existing sections; never delete a gotcha without checking
that the underlying invariant is actually gone.
