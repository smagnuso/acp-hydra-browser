import { WebSocket, WebSocketServer } from "ws";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { logger } from "../util/log.js";
import {
  UpstreamConnection,
  isNotification,
  isRequest,
  isResponse,
  runInitialize,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcId,
} from "../hydra/ws.js";
import {
  COOKIE_NAME,
  parseCookies,
} from "./auth.js";
import { checkStateChanging } from "../util/csrf.js";
import type { ServerContext } from "./http.js";
import { HydraRestClient } from "../hydra/client.js";
import { hasSubscriptions, sendPushToEndpoint } from "./push-store.js";
import { registerForPush } from "./turn-notify-callback.js";
import { clearConnection, isSessionVisible, setConnectionVisible } from "./session-visibility.js";

const log = logger("ws-bridge");

const ALLOWED_BROWSER_REQUEST_METHODS = new Set<string>([
  "session/prompt",
  // session/cancel is kept here for backward compat with older browser
  // builds that frame it as a request. New builds send the notification
  // form (see ALLOWED_BROWSER_NOTIFICATION_METHODS) per the ACP spec.
  "session/cancel",
  "session/set_mode",
  "session/set_model",
  // Generic config-option setter (model/mode/agent plus whatever the
  // agent advertises on its own, e.g. effort). Targets configId/value
  // pairs the daemon already validated as advertised, so it's as
  // harmless to forward as the two verbs above.
  "session/set_config_option",
  // Hydra-side queue control. cancel_prompt drops a queued entry
  // before it runs; update_prompt rewrites a queued entry's content.
  // Both target a specific messageId so they're harmless to forward
  // — hydra rejects unknown / already-running ids with a structured
  // result.
  "hydra-acp/prompt/cancel",
  "hydra-acp/prompt/update",
  // Amend the in-flight head with a replacement prompt. Hydra
  // rejects unknown/closed/already-running targets with a typed
  // result, so it's safe to forward.
  "hydra-acp/prompt/amend",
  // Mid-turn steering (pre-standard extension) — injects into the
  // live turn instead of cancel-and-resubmit when the underlying
  // agent supports it natively; hydra synthesizes the amend-style
  // fallback itself when it doesn't. Always operates against this
  // connection's own sessionId (coerced below), so it's as harmless
  // to forward as the amend/cancel/update trio above.
  "_session/steering",
]);

const ALLOWED_BROWSER_NOTIFICATION_METHODS = new Set<string>([
  "session/cancel",
]);

// How long to keep the daemon connection open after the browser WS
// closes, when a just-sent session/prompt hasn't been paired with its
// messageId yet (see cleanup()). prompt_received fires as soon as the
// daemon accepts the prompt, well before the turn itself finishes, so
// this only needs to outlast that brief window.
const OWN_PROMPT_GRACE_MS = 20_000;

// Entries replayed on a cold (uncursored) attach. The browser's replay is
// effectively uninterruptible: the transcript only swaps in at
// bridge/ready, which the client sends after the WHOLE replay has landed,
// so a socket that dies mid-replay throws that work away and starts over.
// Uncapped, a long-running session replays megabytes — one busy session
// measured 1516 frames / 2.5MB — and a phone dropping its socket every few
// seconds never reaches ready at all: four consecutive attaches moved the
// entire 2.5MB between them and not one completed. Capping the cold window
// keeps the handshake inside the connection window a flaky client actually
// holds; the rest stays one "Load full history" away (fullHistory=true,
// which sends historyLimit 0).
//
// Deliberately NOT applied to after_message (delta) attaches: those are
// already bounded by the client's cursor, and capping one risks the cutoff
// falling outside the window, which downgrades the reply to a full replay
// and blanks the transcript the delta existed to preserve.
//
// Sized by measurement, not taste. Entries are not turns: a tool-heavy
// turn can run hundreds of entries on its own, so too small a cap lands
// the whole window INSIDE one turn and replays agent output with no
// prompt above it — the same "the prompt went missing" report the cache's
// own trim had to grow a turn-boundary snap to avoid. Measured against
// the busiest session here (50 turns, 3.18MB uncapped):
//
//   limit   replay   complete turns
//     400   0.18MB   0   <- opens mid-turn, prompt-less
//    1500   0.64MB   1
//    2500   0.83MB   5
//    4000   1.09MB   15
//
// 2500 keeps several whole turns of scrollback at roughly a third of the
// bytes. Re-measure before changing it; the entries-per-turn ratio is a
// property of how tool-heavy the sessions are, not a constant.
const COLD_ATTACH_HISTORY_LIMIT = 2500;

const SHORT_CIRCUIT_AGENT_REQUEST_METHODS = new Set<string>([
  "fs/read_text_file",
  "fs/write_text_file",
]);

export function attachWsBridge(
  httpServer: HttpServer,
  ctx: ServerContext,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://placeholder");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const ip = (request.socket.remoteAddress ?? "unknown").toString();
    if (ctx.rateLimiter.isBlocked(ip)) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      socket.destroy();
      return;
    }
    const csrf = checkStateChanging(ctx.security, request.headers);
    if (!csrf.ok) {
      socket.write(`HTTP/1.1 ${csrf.status} ${csrf.reason}\r\n\r\n`);
      socket.destroy();
      return;
    }
    const cookies = parseCookies(request.headers.cookie);
    const sessionToken = cookies.get(COOKIE_NAME);
    if (!sessionToken || sessionToken.length === 0) {
      ctx.rateLimiter.recordFailure(ip);
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const sessionId = url.searchParams.get("session");
    const load = url.searchParams.get("load") === "true";
    // Set by a reconnecting client that already holds a transcript — lets
    // us ask the daemon for a delta replay instead of a full one (see
    // doHandshake below) so a quiet reconnect doesn't blow away the
    // browser's scroll position.
    const afterMessageId = url.searchParams.get("afterMessageId") ?? undefined;
    // The exact form of that cursor (PROTOCOL.md, _meta["hydra-acp"].seq).
    // Unique per recorded frame, where a messageId covers every chunk of a
    // reply — so a reconnect landing mid-reply resumes on the frame the
    // browser actually stopped at. The SPA sends one or the other, never
    // both: a daemon too old to know afterSeq ignores it, sees
    // after_message with no cursor it understands, and correctly falls
    // back to a full replay.
    // Set by the SPA's "Load full history" tap. The daemon otherwise
    // caps a replay at its own entry limit, which makes that button a
    // lie on any session longer than the cap; this is the explicit
    // opt-out, sent only on a deliberate user action.
    const fullHistory = url.searchParams.get("fullHistory") === "true";
    const rawAfterSeq = url.searchParams.get("afterSeq");
    const parsedSeq = rawAfterSeq === null ? Number.NaN : Number(rawAfterSeq);
    const afterSeq = Number.isFinite(parsedSeq) ? parsedSeq : undefined;
    if (!sessionId) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (browserWs) => {
      handleConnection(
        browserWs,
        request,
        ctx,
        sessionId,
        sessionToken,
        load,
        afterMessageId,
        afterSeq,
        fullHistory,
      );
    });
  });

  return wss;
}

function handleConnection(
  browserWs: WebSocket,
  _req: IncomingMessage,
  ctx: ServerContext,
  sessionId: string,
  sessionToken: string,
  load: boolean,
  afterMessageId: string | undefined,
  afterSeq: number | undefined,
  fullHistory: boolean,
): void {
  log.info(`bridge open session=${sessionId} load=${load}`);

  const upstream = new UpstreamConnection({
    daemonWsUrl: ctx.config.hydraWsUrl,
    token: sessionToken,
  });

  // Identity for this connection's entry in the session-visibility
  // registry (see bridge/visibility handling below). Deliberately NOT
  // pre-marked visible: a reconnect that happens while the app is
  // already backgrounded (its own retry logic, a brief network blip)
  // opens a fresh WS without any visibility change on the client to
  // report — no visibilitychange event fires because nothing changed —
  // so a "connecting implies visible" default would sit there wrongly
  // suppressing pushes for as long as that connection lives. bridge.ts's
  // reportVisibility() sends the real state right after bridge/ready,
  // so genuine foreground opens still get marked visible within
  // milliseconds; this only changes the (safer) assumption in between.
  const connId = Symbol("ws-bridge-conn");

  // Track ids of outstanding upstream→browser requests so we can validate
  // browser-supplied responses (and reject responses for unknown ids,
  // which would otherwise be a path for a compromised tab to spoof
  // permission outcomes).
  const outstandingFromUpstream = new Set<string>();

  // Permission requests held back while session/update permission_resolved
  // might still arrive from a sibling controller (e.g. the auto-approver).
  // If a resolved notification comes in for one of these before the timer
  // fires, we drop the request entirely — the UI never sees it, no prompt
  // card flashes on screen. Keyed by toolCallId per RFD #533.
  const pendingPermissionFrames = new Map<string, NodeJS.Timeout>();
  const permissionDelayMs = ctx.config.permissionDisplayDelayMs;

  // Permission requests that HAVE been shown (to this tab or a sibling
  // client) but are still unresolved permissionNotifyDelayMs after that,
  // pending a "waiting on you" push — see schedulePermissionNotify. A
  // separate map from pendingPermissionFrames above: that one buffers a
  // request the UI hasn't seen yet, this one times out a request the UI
  // HAS seen, once no permission_resolved has followed it in time.
  // Keyed by toolCallId per RFD #533, same as pendingPermissionFrames.
  const pendingPermissionNotifyTimers = new Map<string, NodeJS.Timeout>();
  const permissionNotifyDelayMs = ctx.config.permissionNotifyDelayMs;

  // messageIds of this connection's own prompts that hydra has queued
  // (hydra-acp/prompt_queue/added, matched by originator.clientId) but
  // hasn't yet reported as started. Consumed (deleted) the moment a
  // prompt_queue/removed{started} confirms which messageId is now the
  // in-flight head — see currentTurnIsOwn below.
  const ownQueuedMessageIds = new Set<string>();
  // Whether the turn currently running on this session (if any) was
  // started by a prompt THIS connection submitted, per the last
  // prompt_queue/removed{started}. Only one turn runs at a time per
  // session, so this is authoritative until the next "started" event —
  // gates schedulePermissionNotify so a peer's (TUI, another tab)
  // permission wait never buzzes this device.
  let currentTurnIsOwn = false;

  let upstreamReady = false;
  // While the upstream handshake is running we can't yet forward browser
  // frames. Buffer them and flush once attach completes.
  const browserBuffer: JsonRpcMessage[] = [];
  // session/update notifications arrive via notify() from inside the
  // daemon's session/attach handler, so replay can start landing before
  // the attach *response* (and its authoritative historyPolicy field)
  // does. Park them here until doHandshake knows whether the daemon
  // honored an after_message request or fell back to a full replay —
  // the browser needs that answer first so it knows whether to keep its
  // existing transcript or clear it before the replay lands. Non-null
  // while armed; set to null once flushed. Mirrors cli's tui/app.ts
  // reconnectReplayBuffer.
  let handshakeBuffer: JsonRpcMessage[] | null = [];

  // This connection's own clientId, learned from the attach response —
  // used to recognize our own submissions on prompt_queue/added (see
  // below), which fans out every client's prompts on the session, not
  // just this connection's. Undefined until doHandshake completes.
  let ownClientId: string | undefined;

  // This connection's own Web Push subscription endpoint, reported by the
  // browser over bridge/push-endpoint (mirrors bridge/visibility below).
  // Undefined if this device has turn-end notifications off. Threaded
  // into maybeRegisterPush so a delivered push targets only the device
  // that submitted the prompt, not every subscribed device — see
  // turn-notify-callback.ts.
  let ownPushEndpoint: string | undefined;

  // Count of session/prompt requests forwarded upstream that haven't
  // been resolved by a matching prompt_queue/added yet (see
  // maybeRegisterPush below). Used only to decide whether cleanup()
  // needs to hold the upstream connection open a little longer.
  let pendingOwnPrompts = 0;

  async function fetchSessionTitle(): Promise<string> {
    try {
      const info = await HydraRestClient.forRequest(
        ctx.config.hydraDaemonUrl,
        ctx.config.hydraToken,
      ).getSession(sessionId);
      return info.title || "Hydra";
    } catch {
      return "Hydra";
    }
  }

  // Web Push registration for this connection's own prompts, mirroring
  // the foreground own-turn-end scope in notifications.ts (a
  // peer-submitted turn finishing isn't "browser initiated"). Only
  // fires when at least one device has subscribed — otherwise this is
  // a no-op REST call to the daemon for every prompt, for nobody.
  async function maybeRegisterPush(messageId: string): Promise<void> {
    if (!(await hasSubscriptions())) {
      return;
    }
    const title = await fetchSessionTitle();
    await registerForPush(ctx.config, sessionId, messageId, title, ownPushEndpoint);
  }

  // Fires after permissionNotifyDelayMs of an own-turn permission request
  // sitting unresolved (see schedulePermissionNotify). Mirrors
  // deliverPush's suppression rules in turn-notify-callback.ts: skip if
  // this tab (or a sibling) is already looking at the session, and only
  // target the device that actually submitted the prompt.
  async function maybeSendPermissionPush(): Promise<void> {
    if (isSessionVisible(sessionId)) {
      log.info(`session=${sessionId} currently visible — suppressing permission push`);
      return;
    }
    if (!ownPushEndpoint) {
      return;
    }
    if (!(await hasSubscriptions())) {
      return;
    }
    const title = await fetchSessionTitle();
    await sendPushToEndpoint(ownPushEndpoint, {
      title,
      body: "Waiting on a permission approval.",
      url: `/#/session/${encodeURIComponent(sessionId)}`,
      tag: `hydra-acp-permission-${sessionId}`,
    });
  }

  // Buffers a just-displayed permission request for permissionNotifyDelayMs.
  // If session/update permission_resolved arrives for this toolCallId
  // before the timer fires — answered in this tab, a sibling client, or
  // the auto-approver — the notification handler below clears it and no
  // push goes out. Skipped entirely when the in-flight turn isn't ours;
  // see currentTurnIsOwn.
  function schedulePermissionNotify(toolCallId: string): void {
    if (permissionNotifyDelayMs <= 0 || !currentTurnIsOwn) {
      return;
    }
    const timer = setTimeout(() => {
      pendingPermissionNotifyTimers.delete(toolCallId);
      void maybeSendPermissionPush();
      maybeStopUpstream();
    }, permissionNotifyDelayMs);
    pendingPermissionNotifyTimers.set(toolCallId, timer);
  }

  upstream.on("open", () => {
    void doHandshake().catch((err: unknown) => {
      log.warn(
        `handshake failed for ${sessionId}: ${(err as Error).message}`,
      );
      sendBrowserError("handshake_failed", (err as Error).message);
      cleanup();
    });
  });

  upstream.on("notification", (n) => {
    // prompt_queue/added is the accept-time signal (fires the instant
    // hydra enqueues the prompt) and, unlike prompt_received/turn_complete,
    // is NOT excluded from the originating connection — PROTOCOL.md is
    // explicit that only prompt_received/turn_complete skip the sender.
    // An earlier version of this hooked prompt_received instead, which
    // meant it could never fire for our own prompts at all. Match by
    // originator.clientId (not FIFO position) since queue/added fans out
    // every client's submissions on this same connection, not just ours.
    if (n.method === "hydra-acp/prompt_queue/added") {
      const params = (n.params ?? {}) as {
        messageId?: unknown;
        originator?: { clientId?: unknown };
      };
      const originatorClientId =
        params.originator && typeof params.originator === "object"
          ? params.originator.clientId
          : undefined;
      if (
        typeof params.messageId === "string" &&
        ownClientId !== undefined &&
        originatorClientId === ownClientId &&
        pendingOwnPrompts > 0
      ) {
        pendingOwnPrompts -= 1;
        ownQueuedMessageIds.add(params.messageId);
        void maybeRegisterPush(params.messageId);
      }
    }
    // prompt_queue/removed{reason:"started"} is the authoritative signal
    // for which messageId is now the session's in-flight head — see
    // acp.ts's onPromptQueueRemoved. Reaches the originator too, unlike
    // prompt_received/turn_complete, so this is also how a peer's turn
    // starting becomes visible to us. Consumed (deleted) either way: once
    // a queued own messageId either starts or leaves the queue some other
    // way (cancelled/abandoned), it's done informing currentTurnIsOwn.
    if (n.method === "hydra-acp/prompt_queue/removed") {
      const params = (n.params ?? {}) as { messageId?: unknown; reason?: unknown };
      const messageId = typeof params.messageId === "string" ? params.messageId : undefined;
      if (messageId !== undefined) {
        if (params.reason === "started") {
          currentTurnIsOwn = ownQueuedMessageIds.has(messageId);
        }
        ownQueuedMessageIds.delete(messageId);
      }
    }
    // Permission resolution during the display-delay window cancels
    // the pending forward. The UI never saw the request so dropping
    // the resolved notification too is correct — there's nothing for
    // the UI to tear down.
    if (n.method === "session/update") {
      const params = (n.params ?? {}) as { update?: unknown };
      const update = params.update as
        | { sessionUpdate?: unknown; toolCallId?: unknown; messageId?: unknown }
        | undefined;
      if (
        update?.sessionUpdate === "permission_resolved" &&
        typeof update.toolCallId === "string"
      ) {
        const timer = pendingPermissionFrames.get(update.toolCallId);
        if (timer) {
          clearTimeout(timer);
          pendingPermissionFrames.delete(update.toolCallId);
          log.debug(
            `permission suppressed-by-delay session=${sessionId} toolCallId=${update.toolCallId}`,
          );
          return;
        }
        const notifyTimer = pendingPermissionNotifyTimers.get(update.toolCallId);
        if (notifyTimer) {
          clearTimeout(notifyTimer);
          pendingPermissionNotifyTimers.delete(update.toolCallId);
          maybeStopUpstream();
        }
      }
      if (handshakeBuffer) {
        handshakeBuffer.push(n);
        return;
      }
    }
    sendBrowserFrame(n);
  });

  upstream.on("request", (r) => {
    if (SHORT_CIRCUIT_AGENT_REQUEST_METHODS.has(r.method)) {
      // We advertised fs/* off in initialize; if an agent still asks,
      // refuse rather than expose the user's filesystem to it.
      upstream.replyError(
        r.id,
        -32601,
        `method not supported: ${r.method}`,
      );
      return;
    }
    if (r.method === "session/request_permission") {
      const params = (r.params ?? {}) as {
        toolCall?: { toolCallId?: unknown };
      };
      const toolCallId =
        typeof params.toolCall?.toolCallId === "string"
          ? params.toolCall.toolCallId
          : undefined;
      const deliver = (): void => {
        outstandingFromUpstream.add(String(r.id));
        sendBrowserFrame(r);
        // Only once the request has actually been shown does the
        // notify-delay clock start — see schedulePermissionNotify.
        if (toolCallId) {
          schedulePermissionNotify(toolCallId);
        }
      };
      if (toolCallId && permissionDelayMs > 0) {
        // Buffer the request for permissionDelayMs. Sibling controllers
        // (the auto-approver) often answer within a handful of ms; if
        // session/update permission_resolved arrives before the timer
        // fires, the notification handler above clears this entry and
        // the request never reaches the browser tab (no flash). Keyed
        // by toolCallId per RFD #533.
        const timer = setTimeout(() => {
          pendingPermissionFrames.delete(toolCallId);
          deliver();
        }, permissionDelayMs);
        pendingPermissionFrames.set(toolCallId, timer);
        return;
      }
      deliver();
      return;
    }
    outstandingFromUpstream.add(String(r.id));
    sendBrowserFrame(r);
  });

  upstream.on("response", (r) => {
    sendBrowserFrame(r);
  });

  upstream.on("close", ({ code, reason }) => {
    log.info(`upstream closed session=${sessionId} code=${code} reason=${reason}`);
    // The daemon connection this timer would confirm against is gone —
    // don't fire a stale "waiting on you" push for a turn that no longer
    // has anywhere to report a resolution.
    for (const timer of pendingPermissionNotifyTimers.values()) {
      clearTimeout(timer);
    }
    pendingPermissionNotifyTimers.clear();
    try {
      browserWs.close();
    } catch {
      void 0;
    }
  });

  upstream.on("error", (err) => {
    log.warn(`upstream error session=${sessionId}: ${err.message}`);
  });

  browserWs.on("message", (data, isBinary) => {
    if (isBinary) {
      return;
    }
    let parsed: JsonRpcMessage;
    try {
      parsed = JSON.parse(data.toString("utf8")) as JsonRpcMessage;
    } catch (err) {
      log.warn(`browser parse error: ${(err as Error).message}`);
      return;
    }
    // Local-only signal (see notifications.ts's reportVisibility) — never
    // forwarded upstream, doesn't go through ALLOWED_BROWSER_*_METHODS.
    // Lets turn-notify-callback.ts skip a push when the answer is
    // already on screen.
    if (isNotification(parsed) && parsed.method === "bridge/visibility") {
      const params = (parsed.params ?? {}) as { visible?: unknown };
      setConnectionVisible(sessionId, connId, params.visible === true);
      return;
    }
    // Local-only signal (see bridge.ts's reportPushEndpoint) — never
    // forwarded upstream. Lets maybeRegisterPush target a turn-end push
    // at this connection's own device instead of every subscribed one.
    if (isNotification(parsed) && parsed.method === "bridge/push-endpoint") {
      const params = (parsed.params ?? {}) as { endpoint?: unknown };
      ownPushEndpoint = typeof params.endpoint === "string" ? params.endpoint : undefined;
      return;
    }
    // Application-level heartbeat (see bridge.ts's sendPing). Local-only,
    // like bridge/visibility above — answering here, immediately, rather
    // than round-tripping through the daemon is the whole point: it's
    // testing whether the browser<->extension leg of the connection is
    // actually alive, which is exactly the leg that can go quietly dead
    // (bad wifi, cell handoff) while readyState still says otherwise.
    if (isNotification(parsed) && parsed.method === "bridge/ping") {
      sendBrowserFrame({ jsonrpc: "2.0", method: "bridge/pong" });
      return;
    }
    handleBrowserFrame(parsed);
  });

  browserWs.on("close", () => {
    log.info(`browser closed session=${sessionId}`);
    cleanup();
  });

  browserWs.on("error", (err) => {
    log.warn(`browser error session=${sessionId}: ${err.message}`);
  });

  upstream.start();

  function handleBrowserFrame(msg: JsonRpcMessage): void {
    if (!upstreamReady) {
      browserBuffer.push(msg);
      return;
    }
    forwardBrowserFrame(msg);
  }

  function forwardBrowserFrame(msg: JsonRpcMessage): void {
    if (isRequest(msg)) {
      if (!ALLOWED_BROWSER_REQUEST_METHODS.has(msg.method)) {
        log.warn(`reject browser request method=${msg.method}`);
        sendBrowserResponseError(
          msg.id,
          -32601,
          `method not allowed: ${msg.method}`,
        );
        return;
      }
      // Coerce sessionId in params to the URL-bound session so a
      // compromised tab can't redirect prompts at sessions it doesn't
      // hold the WS for.
      const params =
        msg.params && typeof msg.params === "object"
          ? { ...(msg.params as Record<string, unknown>), sessionId }
          : { sessionId };
      if (msg.method === "session/prompt") {
        pendingOwnPrompts += 1;
      }
      upstream.sendRaw({
        jsonrpc: "2.0",
        id: msg.id,
        method: msg.method,
        params,
      });
      return;
    }
    if (isResponse(msg)) {
      const idStr = String(msg.id);
      if (!outstandingFromUpstream.has(idStr)) {
        log.warn(`reject browser response for unknown id=${idStr}`);
        return;
      }
      outstandingFromUpstream.delete(idStr);
      upstream.sendRaw(msg);
      return;
    }
    if (isNotification(msg)) {
      if (!ALLOWED_BROWSER_NOTIFICATION_METHODS.has(msg.method)) {
        log.debug(`ignore browser notification method=${msg.method}`);
        return;
      }
      // Same sessionId coercion as the request branch: a compromised tab
      // shouldn't be able to send notifications targeting other sessions.
      const params =
        msg.params && typeof msg.params === "object"
          ? { ...(msg.params as Record<string, unknown>), sessionId }
          : { sessionId };
      upstream.sendRaw({
        jsonrpc: "2.0",
        method: msg.method,
        params,
      });
      return;
    }
  }

  function sendBrowserFrame(msg: JsonRpcMessage): void {
    if (browserWs.readyState !== WebSocket.OPEN) {
      return;
    }
    browserWs.send(JSON.stringify(msg));
  }

  function sendBrowserError(code: string, message: string): void {
    sendBrowserFrame({
      jsonrpc: "2.0",
      method: "bridge/error",
      params: { code, message },
    });
  }

  function sendBrowserResponseError(
    id: JsonRpcId,
    code: number,
    message: string,
  ): void {
    const resp: JsonRpcResponse = {
      jsonrpc: "2.0",
      id,
      error: { code, message },
    };
    sendBrowserFrame(resp);
  }

  async function doHandshake(): Promise<void> {
    const initResp = (await runInitialize(upstream)) as
      | { _meta?: Record<string, unknown> }
      | undefined;
    // Pluck the daemon's hydra-acp capability flags out of the
    // initialize response _meta so we can pass them through to the
    // browser. prompt.amending is the gate for the Amend button —
    // older daemons that don't advertise it should not show one.
    let initHydraMeta: Record<string, unknown> | undefined;
    if (initResp?._meta && typeof initResp._meta === "object") {
      const hm = (initResp._meta as Record<string, unknown>)["hydra-acp"];
      if (hm && typeof hm === "object") {
        initHydraMeta = hm as Record<string, unknown>;
      }
    }
    if (load) {
      try {
        await upstream.request("session/load", { sessionId });
      } catch (err) {
        log.warn(
          `session/load failed for ${sessionId}: ${(err as Error).message} — will still attempt attach`,
        );
      }
    }
    const wantsAfterMessage =
      afterMessageId !== undefined || afterSeq !== undefined;
    const attachResp = (await upstream.request("session/attach", {
      sessionId,
      historyPolicy: wantsAfterMessage ? "after_message" : "full",
      ...(afterMessageId !== undefined ? { afterMessageId } : {}),
      ...(afterSeq !== undefined ? { afterSeq } : {}),
      // 0 = no cap. Hydra-specific attach options ride under _meta;
      // session/attach keeps only RFD #533's own fields at the top level.
      ...(fullHistory
        ? { _meta: { "hydra-acp": { historyLimit: 0 } } }
        : wantsAfterMessage
          ? {}
          : {
              _meta: {
                "hydra-acp": { historyLimit: COLD_ATTACH_HISTORY_LIMIT },
              },
            }),
      clientInfo: {
        name: upstream.clientName,
        version: upstream.clientVersion,
      },
    })) as {
      sessionId?: string;
      clientId?: string;
      historyPolicy?: string;
      _meta?: Record<string, unknown>;
      configOptions?: unknown[];
    };
    // Tell the browser whether it got the delta replay it asked for
    // before forwarding any of the buffered session/update notifications,
    // so it knows whether to keep its existing transcript (after_message)
    // or clear it first (full — either never requested, or the daemon
    // couldn't find afterMessageId and fell back). Order matters: this
    // must land before the buffered replay frames below.
    const appliedPolicy: "full" | "after_message" =
      wantsAfterMessage && attachResp?.historyPolicy === "after_message"
        ? "after_message"
        : "full";
    const buffered = handshakeBuffer ?? [];
    handshakeBuffer = null;
    sendBrowserFrame({
      jsonrpc: "2.0",
      method: "bridge/replay_policy",
      params: { policy: appliedPolicy },
    });
    for (const n of buffered) {
      sendBrowserFrame(n);
    }
    // Pass through clientId and _meta from the attach response so the
    // browser can recognize its own prompt_queue_added broadcasts (by
    // matching originator.clientId) and hydrate any queue snapshot
    // hydra delivers in _meta["hydra-acp"].queue.
    const readyParams: Record<string, unknown> = { sessionId };
    if (typeof attachResp?.clientId === "string") {
      readyParams.clientId = attachResp.clientId;
      ownClientId = attachResp.clientId;
    }
    // configOptions (model/mode/agent plus whatever the agent advertises,
    // e.g. effort) rides at the top level of the attach response, not
    // under _meta — it isn't re-synthesized via session/update on a bare
    // reattach, so this is the only source for the initial snapshot. A
    // config_option_update notification still covers live changes after.
    if (Array.isArray(attachResp?.configOptions)) {
      readyParams.configOptions = attachResp.configOptions;
    }
    if (attachResp?._meta && typeof attachResp._meta === "object") {
      readyParams._meta = attachResp._meta;
    }
    // Merge the initialize-response hydra-acp capability flags into
    // readyParams._meta["hydra-acp"] so the browser sees them in one
    // place alongside the attach-response queue snapshot.
    if (initHydraMeta !== undefined) {
      const existingMeta = (readyParams._meta as Record<string, unknown>) ?? {};
      const existingHydra =
        (existingMeta["hydra-acp"] as Record<string, unknown>) ?? {};
      readyParams._meta = {
        ...existingMeta,
        "hydra-acp": { ...initHydraMeta, ...existingHydra },
      };
    }
    sendBrowserFrame({
      jsonrpc: "2.0",
      method: "bridge/ready",
      params: readyParams,
    });
    upstreamReady = true;
    while (browserBuffer.length > 0) {
      const next = browserBuffer.shift()!;
      forwardBrowserFrame(next);
    }
  }

  // True once the browser side has gone away — gates maybeStopUpstream so
  // it never tears down the daemon connection while the tab is still
  // attached, only once there's nothing left to hold it open for.
  let browserClosed = false;
  let upstreamStopScheduled = false;

  // Tears down the daemon connection once the browser is gone AND
  // nothing still needs it kept alive: an own prompt awaiting its
  // prompt_queue/added (brief grace window), or a permission-notify timer
  // awaiting either its own deadline or a permission_resolved to cancel
  // it against (see schedulePermissionNotify and the permission_resolved
  // handling above). Re-entrant — called again each time one of those
  // conditions clears, from wherever it cleared.
  function maybeStopUpstream(): void {
    if (!browserClosed || upstreamStopScheduled) {
      return;
    }
    if (pendingOwnPrompts > 0) {
      // If a session/prompt we just forwarded hasn't produced its
      // prompt_queue/added yet, don't tear down the daemon connection
      // immediately — backgrounding the app right after hitting send
      // (the literal case Web Push exists for) closes the browser WS
      // within a second or two on iOS, possibly before the notification
      // lands. Killing upstream here would silently drop the
      // turn-notify registration every time. Give it a short grace
      // window instead.
      upstreamStopScheduled = true;
      log.info(
        `browser gone with ${pendingOwnPrompts} own prompt(s) unresolved for session=${sessionId} — holding upstream ${OWN_PROMPT_GRACE_MS}ms for prompt_queue/added`,
      );
      setTimeout(() => upstream.stop(), OWN_PROMPT_GRACE_MS);
      return;
    }
    if (pendingPermissionNotifyTimers.size > 0) {
      log.info(
        `browser gone with ${pendingPermissionNotifyTimers.size} permission-notify timer(s) pending for session=${sessionId} — holding upstream`,
      );
      return;
    }
    upstreamStopScheduled = true;
    upstream.stop();
  }

  function cleanup(): void {
    browserClosed = true;
    clearConnection(sessionId, connId);
    for (const timer of pendingPermissionFrames.values()) {
      clearTimeout(timer);
    }
    pendingPermissionFrames.clear();
    maybeStopUpstream();
    if (browserWs.readyState === WebSocket.OPEN) {
      try {
        browserWs.close();
      } catch {
        void 0;
      }
    }
  }
}

// Exported for tests.
export const _internal = {
  ALLOWED_BROWSER_REQUEST_METHODS,
  ALLOWED_BROWSER_NOTIFICATION_METHODS,
  SHORT_CIRCUIT_AGENT_REQUEST_METHODS,
};

export type { JsonRpcRequest };
