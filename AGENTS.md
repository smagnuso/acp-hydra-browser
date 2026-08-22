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

## Updating this file

If you discover a durable, non-obvious invariant while working here — the
kind of thing you wish had been in this file when you started — flag it
in your final turn summary so the human can decide whether to add it. Do
not silently edit AGENTS.md mid-task. Prefer additions to `## Gotchas`
over reworking existing sections; never delete a gotcha without checking
that the underlying invariant is actually gone.
