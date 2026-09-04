// All render functions and the top-level renderApp(root, state)
// composer. Imports are kept at the top for readability; this is the
// largest module by design — keeping all the DOM-shaping code together
// makes UX iteration easier than chasing pieces across files.

import { state, setState, isRailDirty, markRailClean } from "./state.js";
import { render, noteTypingActivity } from "./renderer.js";
import {
  el,
  tapHandler,
  isFormControl,
  isDesktopPointer,
  isWideLayout,
  TAP_MOVE_THRESHOLD,
} from "./dom.js";
import { renderMarkdown, escapeHtml } from "./markdown.js";
import { highlightCode } from "./hljs.js";
import {
  api,
  importBundle,
  pollSessions,
  tryImportBundleWith409,
} from "./api.js";
import { reportPushEndpoint, respondPermission } from "./bridge.js";
import {
  amendPrompt,
  amendQueuedPrompt,
  cancelProcessingPrompt,
  cancelQueuedPrompt,
  sendCancel,
  sendCompactCommand,
  sendPrompt,
  sendSetConfigOption,
  sendSetMode,
  sendSetModel,
  sendWorkspaceCommand,
  updateQueuedPrompt,
} from "./queue.js";
import { openChat, closeChat, requestFullHistory } from "./routing.js";
import { queueDraftWrite } from "./composer-draft.js";
import {
  requestNotificationPermission,
  subscribeForPush,
  unsubscribeFromPush,
} from "./notifications.js";
import { buildDiffDisplayLines, countDiffChanges } from "./edit-diff.js";
import { applyFontScale, applyTheme } from "./theme.js";
import { describeCachedSession } from "./history-cache.js";
import { bump, describeSlow, describeCounts } from "./perf.js";
import type { DiffDisplayLine } from "./edit-diff.js";
import type {
  AppState,
  ArmedTask,
  Attachment,
  ChatState,
  ConfigOption,
  EditDiff,
  EditDiffLogItem,
  FileEntry,
  PermissionEntry,
  QueueEntry,
  SessionInfo,
  SessionModalData,
  SpinnerState,
} from "./types.js";

// Mirrors cli/src/tui/attachments.ts MAX_ATTACHMENT_BYTES — keeps the two
// clients' caps in sync without a shared package.
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// Tracks which thought bubbles the user has collapsed. Keyed by log item
// object reference, which is stable across re-renders (mutated in place).
const collapsedThoughts = new WeakSet<object>();

// ---- Attachments ---------------------------------------------

// Mirrors cli/src/tui/attachments.ts formatSize.
function formatAttachmentSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(0)}KB`;
  }
  return `${bytes}B`;
}

// Read pasted image files into base64 Attachments and append them to the
// composer's pending list. Oversized files are rejected with a banner
// rather than silently dropped, mirroring the TUI's clipboard-read errors.
function addPastedImages(c: ChatState, files: File[]): void {
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setState({
        banner: {
          kind: "warn",
          text: `pasted image is ${formatAttachmentSize(file.size)}, max ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)}`,
        },
      });
      continue;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") return;
      const comma = result.indexOf(",");
      if (comma < 0) return;
      c.attachments.push({
        mimeType: file.type || "image/png",
        data: result.slice(comma + 1),
        sizeBytes: file.size,
      });
      render();
    };
    reader.readAsDataURL(file);
  }
}

function dataUri(a: Attachment): string {
  return `data:${a.mimeType};base64,${a.data}`;
}

// Pending-attachment chips shown above the composer textarea, each with a
// thumbnail and a remove button. Returns null when there's nothing to show
// so callers can skip appending an empty row.
function renderAttachmentChips(c: ChatState): Node | null {
  if (c.attachments.length === 0) return null;
  return el(
    "div",
    { class: "attachment-chips" },
    ...c.attachments.map((a, i) =>
      el(
        "span",
        { class: "attachment-chip", title: formatAttachmentSize(a.sizeBytes) },
        el("img", { class: "attachment-thumb", src: dataUri(a) }),
        el(
          "button",
          {
            class: "attachment-remove",
            title: "Remove image",
            ...tapHandler(() => {
              c.attachments.splice(i, 1);
              render();
            }),
          },
          "×",
        ),
      ),
    ),
  );
}

// ---- Format helpers ---------------------------------------------

// Title fallback when neither hydra nor the title-cache has a real
// title for the session. Subtitle rows always show the short session
// id alongside agent/cwd, so the title row can stay clean.
function fallbackTitle(_sessionId: string): string {
  return "untitled";
}

// Short, copy-pasteable form of the session id for inline display in
// subtitle rows. Strips the redundant "hydra_session_" prefix.
function shortSessionId(sessionId: string): string {
  return sessionId.replace(/^hydra_session_/, "");
}

// Drop the provider prefix on a model id ("openai/gpt-4o-mini" →
// "gpt-4o-mini") so subtitle rows stay narrow.
function shortenModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const idx = model.lastIndexOf("/");
  return idx === -1 ? model : model.slice(idx + 1);
}

// "agent•model" when both are known, just the agent (or "?") otherwise.
// Matches the CLI's TUI header (see cli/src/core/agent-display.ts).
function agentWithModel(
  agent: string | undefined,
  model: string | undefined,
): string {
  const a = agent || "?";
  const m = shortenModel(model);
  return m ? `${a}•${m}` : a;
}

// Abbreviated duration. Matches the CLI/TUI style: "<1m", "12m", "3h",
// "2d", "5w", "11mo", "2y".
function formatDuration(ms: number): string {
  const sec = Math.floor(Math.max(0, ms) / 1000);
  if (sec < 60) return "<1m";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 14) return `${day}d`;
  const week = Math.floor(day / 7);
  if (week < 9) return `${week}w`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month}mo`;
  const year = Math.floor(day / 365);
  return `${year}y`;
}

// "Time since" hint for the subtitle row.
function formatRelativeAge(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "?";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "?";
  return formatDuration(now - t);
}

// Compact-format a token count: <1k → "n", <1M → "n.nk", else "n.nM".
// Used in the chat header where horizontal space is scarce.
function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return "?";
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const v = (n / 1000).toFixed(n < 10_000 ? 1 : 0);
    return v.replace(/\.0$/, "") + "k";
  }
  return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, "") + "M";
}

// Format an ACP cost field. The agent-side shape varies — sometimes
// a bare number (assumed USD), sometimes { amount, currency }, and
// some agents nest under { total: { amount, currency } }. We probe
// each layout, fall back to USD, and stretch decimals based on
// magnitude so sub-dollar costs stay readable.
function fmtCost(cost: unknown): string | null {
  let amount: number | null = null;
  let currency = "USD";
  if (typeof cost === "number") {
    amount = cost;
  } else if (cost && typeof cost === "object") {
    const c = cost as { amount?: unknown; currency?: unknown; total?: unknown };
    if (typeof c.amount === "number") amount = c.amount;
    else if (typeof c.total === "number") amount = c.total;
    else if (c.total && typeof c.total === "object") {
      const t = c.total as { amount?: unknown; currency?: unknown };
      if (typeof t.amount === "number") amount = t.amount;
      if (typeof t.currency === "string") currency = t.currency;
    }
    if (typeof c.currency === "string") currency = c.currency;
  }
  if (amount === null) return null;
  const decimals = amount < 0.01 ? 4 : amount < 1 ? 3 : 2;
  if (currency === "USD") return `$${amount.toFixed(decimals)}`;
  return `${amount.toFixed(decimals)} ${currency}`;
}

// ---- Top-level shell ---------------------------------------------

export function renderApp(root: HTMLElement, s: AppState): void {
  if (s.banner) {
    root.appendChild(
      el("div", { class: "banner " + s.banner.kind }, s.banner.text),
    );
  }
  if (isWideLayout()) {
    root.appendChild(renderSplitLayout(s));
  } else if (s.view === "list") {
    root.appendChild(renderTopbar());
    root.appendChild(renderSessionSearch());
    root.appendChild(renderList());
  } else if (s.view === "chat" && s.current) {
    root.appendChild(renderChat(s.current));
    if (s.current.fileOverlay) {
      root.appendChild(renderFileOverlay(s.current));
    }
  }
  if (s.modal) {
    if (s.modal.kind === "session") {
      root.appendChild(renderSessionModal(s.modal));
    } else if (s.modal.kind === "modes" && s.current) {
      root.appendChild(
        renderListModal(
          "Mode",
          s.current.modes,
          s.current.mode,
          (m) => sendSetMode(m.id),
        ),
      );
    } else if (s.modal.kind === "models" && s.current) {
      root.appendChild(
        renderListModal(
          "Model",
          s.current.models,
          s.current.model,
          (m) => sendSetModel(m.id),
        ),
      );
    } else if (s.modal.kind === "options") {
      root.appendChild(renderOptionsModal());
    }
  }
}

// ---- Wide-layout split view ---------------------------------------
// Above dom.ts's isWideLayout() breakpoint, the session list renders as
// a persistent rail alongside the active chat instead of taking over
// the whole screen. The rail has no incremental view object the way
// chatViews gives the chat pane — it's always been a from-scratch
// rebuild (renderList()) on every render(). That's fine when it's the
// only thing on screen, but tryPatchChat's fast path now keeps the
// chat patching in place many times a second during a stream, and the
// rail sits right next to it the whole time — rebuilding hundreds of
// session cards on every streamed token would be real, needless jank.
// isRailDirty()/markRailClean() (state.ts) gate the rebuild on whether
// anything rail-relevant actually changed since the last one.

function buildRailContents(): Node[] {
  return [renderTopbar(), renderSessionSearch(), renderList()];
}

// Static snapshot of the session-list pane for swipe-nav.ts's chat→list
// drag-reveal. Real content built from already-loaded state (no
// network/async involved), but a throwaway one: it doesn't react to
// further polling while the gesture is in flight, since it's discarded
// either way — cancelled, or replaced wholesale by the real list once
// closeChat()'s render lands.
export function buildListPreviewPane(): HTMLElement {
  return el("div", { class: "swipe-preview-list" }, ...buildRailContents());
}

// Lightweight identity card for swipe-nav.ts's list→chat drag-reveal —
// deliberately NOT a full chat preview, NOT a sign the session's actual
// history is gone. Opening a session is async (WS connect, history-cache
// load), so no real transcript is available synchronously at drag time;
// this sells the reveal with the header a real chat would show and an
// explicit "opening…" in the body so the gap between the two reads as
// "loading", not "empty" — the real renderChat() (with the real,
// untouched transcript) takes over once the drag commits and openChat()
// actually runs.
export function buildChatPreviewPane(session: SessionInfo): HTMLElement {
  const title = session.title || fallbackTitle(session.sessionId);
  const subtitle = [
    shortSessionId(session.sessionId),
    agentWithModel(session.agentId, session.currentModel),
  ].join(" · ");
  return el(
    "div",
    { class: "swipe-preview-chat" },
    el(
      "div",
      { class: "chat-header" },
      el(
        "div",
        { class: "chat-title-row" },
        el("div", { class: "chat-title" }, title),
      ),
      el(
        "div",
        { class: "chat-header-row" },
        el("div", { class: "info" }, el("div", { class: "row2" }, subtitle)),
      ),
    ),
    el(
      "div",
      { class: "chat-body swipe-preview-chat-body" },
      el(
        "div",
        { class: "swipe-preview-loading" },
        el("span", { class: "dot" }),
        "opening…",
      ),
    ),
  );
}

// The rail element itself — not its children — is what carries
// keyboard focus (see focusListRail below). replaceChildren() never
// disturbs the element holding it, so unlike a full #app teardown this
// needs no data-focus-key restore dance.
function renderRail(): HTMLElement {
  const rail = el(
    "div",
    { class: "rail", tabindex: "-1", "data-focus-key": "list-rail" },
    ...buildRailContents(),
  );
  if (state.railWidth !== null) {
    rail.style.flex = `0 0 ${clampRailWidth(state.railWidth)}px`;
  }
  markRailClean();
  return rail;
}

function refreshRailInPlace(rail: HTMLElement): void {
  if (!isRailDirty()) return;
  const oldList = rail.querySelector<HTMLElement>(".list");
  const oldScrollTop = oldList ? oldList.scrollTop : null;
  const anchor = oldList ? captureListAnchor(oldList) : null;
  // replaceChildren destroys the focused node, and unlike a full #app
  // teardown nothing else restores it on this path — so typing in the
  // session filter (which marks the rail dirty on every keystroke, since
  // it changes what the rail shows) would lose the caret each character.
  // Same data-focus-key contract renderer.ts's actuallyRender uses.
  const active = document.activeElement as HTMLElement | null;
  const focusKey =
    active && rail.contains(active) ? (active.dataset.focusKey ?? null) : null;
  const selStart = focusKey ? (active as HTMLInputElement).selectionStart : null;
  const selEnd = focusKey ? (active as HTMLInputElement).selectionEnd : null;
  rail.replaceChildren(...buildRailContents());
  markRailClean();
  if (focusKey) {
    const next = rail.querySelector<HTMLElement>(
      `[data-focus-key="${CSS.escape(focusKey)}"]`,
    );
    if (next) {
      next.focus();
      const inputLike = next as HTMLInputElement;
      if (selStart !== null && typeof inputLike.setSelectionRange === "function") {
        try {
          inputLike.setSelectionRange(selStart, selEnd!);
        } catch {
          // Non-text input types throw on selection access; ignore.
        }
      }
    }
  }
  const newList = rail.querySelector<HTMLElement>(".list");
  if (newList) {
    if (anchor) {
      restoreListAnchor(newList, anchor);
    } else if (oldScrollTop !== null) {
      newList.scrollTop = oldScrollTop;
    }
  }
}

// Keeps the rail usable at both ends: narrow enough to be mostly chat,
// wide enough that session titles aren't all ellipsis, and never so wide
// the chat pane is squeezed out.
function clampRailWidth(px: number): number {
  const max = Math.max(280, Math.min(window.innerWidth * 0.6, window.innerWidth - 360));
  return Math.round(Math.max(240, Math.min(px, max)));
}

// Drag handle between the rail and the chat. Resizes by writing to the
// rail's own style during the drag rather than going through render() —
// a full rebuild per pointermove would be both janky and pointless,
// since only one element's width is changing. State is committed once,
// on release.
function renderSplitter(): HTMLElement {
  const sp = el("div", { class: "splitter", title: "Drag to resize (double-click to reset)" });
  sp.addEventListener("dblclick", () => {
    const rail = sp.previousElementSibling as HTMLElement | null;
    // Clears the persisted drag width so the rail falls back to the
    // CSS default (.rail's flex-basis) instead of an inline style that
    // would keep overriding it forever, including any future default
    // width change, until the user happened to drag again.
    if (rail) rail.style.flex = "";
    setState({ railWidth: null });
  });
  sp.addEventListener("pointerdown", (e: PointerEvent) => {
    const rail = sp.previousElementSibling as HTMLElement | null;
    if (!rail) return;
    // Stops the gesture turning into a text selection across both panes.
    e.preventDefault();
    const startX = e.clientX;
    const startW = rail.getBoundingClientRect().width;
    sp.setPointerCapture(e.pointerId);
    sp.classList.add("dragging");
    const move = (ev: PointerEvent): void => {
      rail.style.flex = `0 0 ${clampRailWidth(startW + (ev.clientX - startX))}px`;
    };
    const done = (): void => {
      sp.releasePointerCapture(e.pointerId);
      sp.classList.remove("dragging");
      sp.removeEventListener("pointermove", move);
      sp.removeEventListener("pointerup", done);
      sp.removeEventListener("pointercancel", done);
      setState({ railWidth: clampRailWidth(rail.getBoundingClientRect().width) });
    };
    sp.addEventListener("pointermove", move);
    sp.addEventListener("pointerup", done);
    sp.addEventListener("pointercancel", done);
  });
  return sp;
}

function renderSplitLayout(s: AppState): HTMLElement {
  // "split-detail", not "detail" — that name collides with the
  // pre-existing generic .detail label+control row class used all over
  // the app (options modal, chat-details panel, permission rows, …).
  // CSS classes aren't scoped, so sharing it silently applied this
  // wrapper's column-flex/max-width rules to every one of those rows
  // too, stacking each label above its control instead of beside it.
  const detail = el("div", { class: "split-detail" });
  if (s.current) {
    detail.appendChild(renderChat(s.current));
    if (s.current.fileOverlay) {
      detail.appendChild(renderFileOverlay(s.current));
    }
  } else {
    detail.appendChild(
      el("div", { class: "split-detail-empty" }, "Select a session from the list"),
    );
  }
  return el("div", { class: "split" }, renderRail(), renderSplitter(), detail);
}

// Moves keyboard focus to the session-list rail (wide layout only) so
// Up/Down/Enter act on it — see handleListKeydown below. Used in place
// of closeChat()'s narrow-mode "leave chat, show list" navigation: in
// split view the chat stays open and visible the whole time; only the
// keyboard target changes. Exported for main.ts's back-button/Ctrl+P
// handlers.
export function focusListRail(): void {
  const rail = document.querySelector<HTMLElement>('[data-focus-key="list-rail"]');
  if (!rail) return;
  // Land the cursor on the currently-open session so the focus move is
  // actually visible — a bare DOM focus() with no card highlighted
  // looked like nothing happened. Unconditional: an earlier version
  // gated this on the session still showing in the (possibly filtered,
  // possibly stale-by-a-poll-cycle) visible list, which could silently
  // skip the highlight while focus still moved — exactly the "focus
  // moved but nothing got reselected" split a filter mismatch or a
  // just-created session not yet polled into state.sessions would
  // produce. Setting a highlight id for a card that isn't currently
  // rendered is harmless (renderSessionCard just never matches it).
  // setState's render() is async (rAF-deferred); rail.focus() below
  // runs against this same still-live node before that fires, and the
  // eventual re-render patches the rail's children in place
  // (refreshRailInPlace/tryPatchChat) rather than replacing this node,
  // so the focus set here survives it.
  if (state.current) {
    setState({ listHighlightedSessionId: state.current.sessionId });
  }
  rail.focus();
}

// ---- Topbar ------------------------------------------------------

// Sits between the topbar and the list, so it's outside .list's own
// scroll container and stays put as the list scrolls. Carries a
// data-focus-key: render() tears the whole tree down (poll ticks, WS
// traffic), and without one the caret would be lost mid-word — see
// renderer.ts's focus/selection restore.
function renderSessionSearch(): HTMLElement {
  const clear =
    state.sessionSearch.length > 0
      ? el(
          "button",
          {
            class: "session-search-clear",
            title: "Clear filter",
            ...tapHandler(() => setState({ sessionSearch: "" })),
          },
          "×",
        )
      : null;
  return el(
    "div",
    { class: "session-search-row" },
    el("input", {
      class: "session-search",
      // Deliberately type=text, not type=search: the native search
      // widget's own clear affordance varies by browser and would sit
      // alongside ours.
      type: "text",
      placeholder: "Filter sessions…",
      value: state.sessionSearch,
      "data-focus-key": "session-search",
      autocomplete: "off",
      autocapitalize: "off",
      autocorrect: "off",
      spellcheck: "false",
      oninput: (e: Event) => {
        setState({ sessionSearch: (e.target as HTMLInputElement).value });
      },
      onkeydown: (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        // Escape clears first and only gives up focus on a second
        // press, so it can't strand a filter the user can no longer
        // see the effect of. stopPropagation keeps the window-level
        // list/modal Escape handlers out of it either way.
        e.preventDefault();
        e.stopPropagation();
        if (state.sessionSearch.length > 0) {
          setState({ sessionSearch: "" });
        } else {
          (e.target as HTMLInputElement).blur();
        }
      },
    }),
    clear,
  );
}

function renderTopbar(): HTMLElement {
  return el(
    "div",
    { class: "topbar" },
    el(
      "span",
      {
        class: "pill clickable",
        title: "Click to toggle grouping by project/recent",
        ...tapHandler(() =>
          setState({ groupBy: state.groupBy === "project" ? "recent" : "project" }),
        ),
      },
      state.groupBy,
    ),
    el(
      "span",
      {
        class: "pill clickable",
        title: "Click to toggle showing disk-only sessions",
        ...tapHandler(() => {
          setState({ showCold: !state.showCold });
        }),
      },
      state.showCold ? "all" : "warm",
    ),
    renderHostFilter(),
    el("span", { class: "spacer" }),
    el("button", { ...tapHandler(openOptionsModal), title: "Options" }, "⚙"),
    el(
      "button",
      {
        ...tapHandler(openImportPicker),
        title: "Import a *.hydra bundle from disk",
      },
      "📥",
    ),
    el("button", { ...tapHandler(openSessionModal), title: "New Session" }, "＋"),
  );
}

// Namespace prefixes for the host-filter value — see describeHostFilter
// and cli's picker.ts (same fix, same reason): a `hydra remote add`
// name is very commonly just the machine's own hostname (e.g. `hydra
// remote add mrclean mrclean.local`), which is the exact same string
// importedFromMachine already uses for old bundle imports from that
// box. Without a prefix, "mrclean" as a bare filter value can't tell a
// live federated remote from an unrelated years-old import mirror
// apart, and silently merges two unrelated session sets into one
// bucket — an actual bug, not a hypothetical.
const REMOTE_FILTER_PREFIX = "remote:";
const HOST_FILTER_PREFIX = "host:";

function describeHostFilter(value: string): string {
  if (value.startsWith(REMOTE_FILTER_PREFIX)) {
    return `remote "${value.slice(REMOTE_FILTER_PREFIX.length)}"`;
  }
  if (value.startsWith(HOST_FILTER_PREFIX)) {
    return `host "${value.slice(HOST_FILTER_PREFIX.length)}"`;
  }
  return `host "${value}"`; // pre-namespacing persisted value
}

// Build the host-filter dropdown. Options are computed live from the
// current session list so newly-imported peer hosts (or newly
// federated remotes) appear without page reload. Sentinels/namespaced
// values:
//   "__local"    — sessions created here OR imported and bound to a
//                  local agent. Federated (remote-set) sessions never
//                  land here.
//   "__all"      — every session.
//   "host:<m>"   — passive mirrors imported from machine <m> that
//                  haven't been attached locally yet.
//   "remote:<n>" — live sessions federated under the `hydra remote`
//                  named <n> — see s.remote in types.ts.
// A peer host with no passive mirrors (all its sessions have been
// attached locally) drops out of the option list — its filter would
// render empty. A federated remote never drops out this way: it has no
// local-attach equivalent, so it stays live in its own bucket for as
// long as it's federated.
function renderHostFilter(): HTMLElement {
  const remotes = new Set<string>();
  const hosts = new Set<string>();
  for (const s of state.sessions) {
    if (s.remote) {
      remotes.add(s.remote);
      continue;
    }
    if (s.importedFromMachine && !s.upstreamSessionId) {
      hosts.add(s.importedFromMachine);
    }
  }
  const select = el("select", {
    class: "host-select",
    title: "Filter sessions by origin host",
    onchange: (e: Event) => {
      const value = (e.target as HTMLSelectElement).value;
      setState({ hostFilter: value });
    },
  }) as HTMLSelectElement;
  const addOption = (value: string, label: string): void => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    if (state.hostFilter === value) {
      opt.selected = true;
    }
    select.appendChild(opt);
  };
  addOption("__local", "local");
  for (const name of [...remotes].sort()) {
    addOption(`${REMOTE_FILTER_PREFIX}${name}`, name);
  }
  for (const machine of [...hosts].sort()) {
    // Suffixed (unlike the bare remote label above) so the collision
    // case — same name, both a live remote and an old import — reads
    // as two distinct, identifiable options instead of a duplicate.
    addOption(`${HOST_FILTER_PREFIX}${machine}`, `${machine} (imported)`);
  }
  addOption("__all", "all");
  // If the current filter points at a host/remote that no longer
  // appears in any session, the select would render with nothing
  // selected. Pin the rendered value to the state explicitly so this
  // stays sane.
  const known = new Set<string>(["__local", "__all"]);
  for (const name of remotes) {
    known.add(`${REMOTE_FILTER_PREFIX}${name}`);
  }
  for (const machine of hosts) {
    known.add(`${HOST_FILTER_PREFIX}${machine}`);
  }
  if (!known.has(state.hostFilter)) {
    select.value = state.hostFilter;
  }
  return select;
}

// ---- Session list -----------------------------------------------

// Daemon always returns everything now; the "show cold" toggle and the
// host filter are client-side passes — apply them in order. Shared by
// renderList (which also needs raw `visible` for the empty-state check)
// and flatVisibleSessionIds (keyboard nav needs the exact same set and
// order the user is actually looking at).
// Substring match across the same fields the TUI picker's `/` search
// covers (cli/src/tui/picker.ts matchesSearch): id, upstream id, agent,
// title and cwd. Case-insensitive, no fuzzy matching — typing a literal
// fragment of a path or title is what people actually do, and fuzzy
// matching makes short terms match almost everything.
function matchesSessionSearch(s: SessionInfo, term: string): boolean {
  if (term.length === 0) return true;
  const t = term.toLowerCase();
  const haystacks = [
    shortSessionId(s.sessionId),
    s.upstreamSessionId ?? "",
    s.agentId ?? "",
    s.title ?? "",
    s.cwd,
    // The cards display cwd home-shortened, so "~/dev/foo" has to match
    // what the user can actually see. The TUI gets this from a real
    // $HOME; we only have the path, so collapse the usual container.
    s.cwd.replace(/^\/(?:home|Users)\/[^/]+/, "~"),
  ];
  return haystacks.some((h) => h.toLowerCase().includes(t));
}

function visibleFilteredSessions(): SessionInfo[] {
  let visible = state.showCold
    ? state.sessions
    : state.sessions.filter((s) => s.status !== "cold");
  if (state.hostFilter === "__local") {
    visible = visible.filter(
      (s) =>
        !s.remote && (!s.importedFromMachine || !!s.upstreamSessionId),
    );
  } else if (state.hostFilter.startsWith(REMOTE_FILTER_PREFIX)) {
    const name = state.hostFilter.slice(REMOTE_FILTER_PREFIX.length);
    visible = visible.filter((s) => s.remote === name);
  } else if (state.hostFilter !== "__all") {
    const machine = state.hostFilter.startsWith(HOST_FILTER_PREFIX)
      ? state.hostFilter.slice(HOST_FILTER_PREFIX.length)
      : state.hostFilter; // pre-namespacing persisted value
    visible = visible.filter(
      (s) => s.importedFromMachine === machine && !s.upstreamSessionId,
    );
  }
  const term = state.sessionSearch.trim();
  if (term.length > 0) {
    visible = visible.filter((v) => matchesSessionSearch(v, term));
  }
  return visible;
}

// Flattened top-to-bottom order of session cards as actually rendered
// (groups, then per-group sort) — the sequence Up/Down/Enter navigate.
export function flatVisibleSessionIds(): string[] {
  return groupSessions(visibleFilteredSessions(), state.groupBy).flatMap(
    (g) => g.sessions.map((s) => s.sessionId),
  );
}

function focusComposer(): void {
  document.querySelector<HTMLElement>('[data-focus-key="composer"]')?.focus();
}

// Shared by handleListKeydown's Enter/Escape branches: switching to a
// session already showing in the split-view detail pane doesn't need a
// reconnect, just a focus move — openChat() tears down and reconnects
// unconditionally, which narrow mode never risked (you can't select a
// session you're not currently viewing there) but wide mode can, since
// the chat stays open the whole time you're navigating the rail.
function openOrFocusChat(sessionId: string, cold: boolean): void {
  if (isWideLayout() && state.current?.sessionId === sessionId) {
    focusComposer();
    return;
  }
  openChat(sessionId, cold);
}

// Up/Down (or n/p) moves a keyboard-nav cursor over the session list
// (by id, see listHighlightedSessionId); Enter opens whatever it's on; Escape jumps
// back into whichever session you most recently backed out of (same
// target and same "still exists" guard as swipe-nav.ts's list->chat
// swipe). Mirrors the TUI's session picker. Ignored while a form
// control (the host-filter select) has focus, so arrow keys there
// change the select's value instead of hijacking it. Otherwise active
// in narrow mode's list view, or in wide mode's split view once
// focusListRail has moved keyboard focus onto the rail (see
// renderApp/focusListRail) — composer text and its own history-recall
// arrow keys are what's focused the rest of the time in wide mode, and
// this must not steal those keystrokes out from under it.
export function handleListKeydown(e: KeyboardEvent): void {
  const railFocused =
    (document.activeElement as HTMLElement | null)?.dataset.focusKey === "list-rail";
  if (state.view !== "list" && !(isWideLayout() && railFocused)) return;
  if (isFormControl(document.activeElement)) return;
  if (e.key === "Escape") {
    // Wide mode: the chat never closed, so there's nothing to jump
    // back into — just hand focus back to it. lastSessionId (below)
    // is narrow mode's mechanism and is never set by the rail-focus
    // path (see focusListRail; unlike closeChat(), it doesn't touch
    // lastSessionId, since nothing was actually closed). Also snaps
    // the highlight back to the session actually being viewed — Up/Down
    // may have moved it to preview a different row without committing
    // (Enter is what commits), and abandoning that via Escape should
    // abandon the preview highlight too, not leave it stranded on
    // whatever row the cursor last landed on.
    if (isWideLayout() && state.current) {
      e.preventDefault();
      setState({ listHighlightedSessionId: state.current.sessionId });
      focusComposer();
      return;
    }
    const id = state.lastSessionId;
    const s = id ? state.sessions.find((s) => s.sessionId === id) : undefined;
    if (!s) return;
    e.preventDefault();
    openOrFocusChat(s.sessionId, s.status === "cold");
    return;
  }
  // "c" opens the new-session dialog. Plain key only; a modifier
  // (Ctrl/Cmd+C for copy, etc.) falls through to the browser's own
  // handling untouched.
  if (
    e.key.toLowerCase() === "c" &&
    !e.shiftKey &&
    !e.altKey &&
    !e.ctrlKey &&
    !e.metaKey
  ) {
    e.preventDefault();
    openSessionModal();
    return;
  }
  // n/p are emacs/vi-style synonyms for Down/Up, same plain-key-only
  // (no modifier) rule as "c" above so Ctrl/Cmd+N/P (new window,
  // print) fall through untouched.
  const noMods = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
  const isDown = e.key === "ArrowDown" || (e.key === "n" && noMods);
  const isUp = e.key === "ArrowUp" || (e.key === "p" && noMods);
  if (!isDown && !isUp && e.key !== "Enter") return;
  const ids = flatVisibleSessionIds();
  if (ids.length === 0) return;
  if (e.key === "Enter") {
    const id = state.listHighlightedSessionId;
    if (!id || !ids.includes(id)) return;
    const s = state.sessions.find((s) => s.sessionId === id);
    if (!s) return;
    e.preventDefault();
    openOrFocusChat(s.sessionId, s.status === "cold");
    return;
  }
  e.preventDefault();
  const currentIdx = state.listHighlightedSessionId
    ? ids.indexOf(state.listHighlightedSessionId)
    : -1;
  const nextIdx =
    currentIdx === -1
      ? 0
      : isDown
      ? Math.min(ids.length - 1, currentIdx + 1)
      : Math.max(0, currentIdx - 1);
  setState({ listHighlightedSessionId: ids[nextIdx]! });
}

// Tracks the last highlight renderList() actually scrolled to, so a
// render triggered by something else entirely (a poll tick) doesn't
// re-trigger the scroll-into-view just because the highlight is still
// set from an earlier, unrelated navigation.
let lastScrolledHighlightId: string | null = null;

function renderList(): HTMLElement {
  const visible = visibleFilteredSessions();
  // Count cold-filtered sessions separately so the empty-state message
  // for the "warm" toggle isn't muddied by host-filter hits.
  const hiddenCold = state.showCold
    ? 0
    : state.sessions.filter((s) => s.status === "cold").length;
  const groups = groupSessions(visible, state.groupBy);
  const list = el("div", { class: "list" });
  // Keyboard-highlighted card may be scrolled out of view (a long list,
  // or the highlight just moved past the fold) — bring it on screen.
  // Deferred a tick: `list` isn't attached to the document until
  // renderApp's caller appends this function's return value. Gated on
  // the highlight actually CHANGING since the last render, not merely
  // being set — listHighlightedSessionId stays pinned to the open
  // session for as long as it's open, and re-queuing this on every poll
  // tick (every render, not just a keyboard-nav one) would yank anyone
  // who'd scrolled the list away from the open session right back to
  // it a couple seconds later.
  if (
    state.listHighlightedSessionId &&
    state.listHighlightedSessionId !== lastScrolledHighlightId
  ) {
    lastScrolledHighlightId = state.listHighlightedSessionId;
    queueMicrotask(() => {
      document.querySelector(".card.highlighted")?.scrollIntoView({ block: "nearest" });
    });
  } else if (!state.listHighlightedSessionId) {
    lastScrolledHighlightId = null;
  }
  if (visible.length === 0) {
    let msg: string;
    if (state.sessionSearch.trim().length > 0) {
      msg = `No sessions match “${state.sessionSearch.trim()}”.`;
    } else if (state.sessions.length === 0) {
      msg = "No sessions. Use + to create one, or run `hydra-acp launch <agent>` from your editor.";
    } else if (state.hostFilter === "__local") {
      msg = "No local sessions. Switch the host filter to see imported sessions.";
    } else if (state.hostFilter !== "__all") {
      msg = `No sessions from ${describeHostFilter(state.hostFilter)}. Try a different host.`;
    } else {
      msg = `No warm sessions. ${hiddenCold} cold session${hiddenCold === 1 ? "" : "s"} hidden — click "warm" to switch to "all".`;
    }
    list.appendChild(el("div", { class: "empty" }, msg));
  }
  for (const g of groups) {
    const groupNode = el("div", { class: "group" });
    if (g.label) {
      groupNode.appendChild(el("h2", null, g.label));
    }
    for (const s of g.sessions) {
      groupNode.appendChild(renderSessionCard(s, g.label === null));
    }
    list.appendChild(groupNode);
  }
  return list;
}

interface SessionGroup {
  label: string | null;
  sessions: SessionInfo[];
}

// Same tiering as the TUI picker's sortSessions (picker.ts): a mid-turn
// agent blocked on a question (busy + awaiting-input) is the most urgent
// row there is, plain busy comes next, then a stale awaiting-input flag
// on a turn that's already over (often just an uncleared flag rather
// than an agent actually standing by), then priority-pinned idle-warm,
// then plain idle-warm, then priority-pinned cold, then plain cold —
// priority only breaks ties within "both idle-warm" or "both cold", never
// outranking actual activity. Tiebreak within a tier is the priority
// integer itself, then updatedAt at minute precision so per-chunk mtime
// churn doesn't reshuffle the list between polls.
function compareSessions(a: SessionInfo, b: SessionInfo): number {
  const priorityOf = (s: SessionInfo): number => (s.priority && s.priority > 0 ? s.priority : 0);
  const tier = (s: SessionInfo): number => {
    const isWarm = s.status === "warm";
    const isPriority = priorityOf(s) > 0;
    if (isWarm && s.busy && s.awaitingInput) return 6;
    if (isWarm && s.busy) return 5;
    if (isWarm && s.awaitingInput) return 4;
    if (isWarm && isPriority) return 3;
    if (isWarm) return 2;
    if (isPriority) return 1;
    return 0;
  };
  const dt = tier(b) - tier(a);
  if (dt !== 0) {
    return dt;
  }
  const dp = priorityOf(b) - priorityOf(a);
  if (dp !== 0) {
    return dp;
  }
  return String(b.updatedAt || "").slice(0, 16).localeCompare(String(a.updatedAt || "").slice(0, 16));
}

// Collapse a leading home directory into "~" so the session list has
// room to actually show the rest of the path instead of truncating it.
function shortenCwd(cwd: string): string {
  return cwd.replace(/^\/(home|Users)\/[^/]+/, "~");
}

function detailRow(label: string, value: string): HTMLElement {
  return el(
    "div",
    { class: "detail" },
    el("span", { class: "k" }, label),
    el("code", null, value),
  );
}

// High-priority sort weight, toggled with `*` in the TUI picker (see
// compareSessions). Undocumented in PROTOCOL.md — an internal hydra
// extension field (SessionListEntry.priority), not part of the ACP
// spec proper. Same on/off distinction as the TUI's own picker — the
// underlying field takes any positive integer for a future
// finer-grained tier, but neither UI exposes that yet.
function priorityRow(sessionId: string, priority: number | undefined): HTMLElement {
  const checkbox = el("input", {
    type: "checkbox",
    title: "Float this session to the top of the list",
    onchange: (e: Event) => {
      void setSessionPriority(sessionId, (e.target as HTMLInputElement).checked ? 1 : null);
    },
  }) as HTMLInputElement;
  checkbox.checked = (priority ?? 0) > 0;
  return el(
    "div",
    { class: "detail" },
    el("span", { class: "k" }, "high priority"),
    checkbox,
  );
}

async function setSessionPriority(sessionId: string, priority: number | null): Promise<void> {
  try {
    await api(`/api/sessions/${encodeURIComponent(sessionId)}/priority`, {
      method: "PATCH",
      body: JSON.stringify({ priority }),
    });
    void pollSessions();
  } catch (err) {
    setState({
      banner: { kind: "bad", text: "priority update failed: " + (err as Error).message },
    });
  }
}

// Workspace action row for the expanded chat-details panel. Buttons send
// `/hydra workspace <verb>` through the composer's own send path — there
// is no REST equivalent for these verbs (only `clean` has one), so a
// slash command is the only way to trigger them.
function workspaceRow(workspace: SessionInfo["workspace"]): HTMLElement {
  const button = (verb: "start" | "sync" | "stop" | "apply", label: string) =>
    el(
      "button",
      { class: "ghost", ...tapHandler(() => sendWorkspaceCommand(verb)) },
      label,
    );
  if (!workspace) {
    return el(
      "div",
      { class: "detail" },
      el("span", { class: "k" }, "workspace"),
      button("start", "Start workspace"),
    );
  }
  return el(
    "div",
    { class: "detail" },
    el("span", { class: "k" }, "workspace"),
    el(
      "code",
      null,
      `${workspace.label}${workspace.clean === false ? " · dirty" : ""}`,
    ),
    button("sync", "Sync"),
    button("stop", "Stop"),
    button("apply", "Apply"),
  );
}

// Global (cross-session) toggle for whether agent_thought_chunk
// bubbles render at all. Lives in the global options modal (see
// renderOptionsModal below), not a per-session panel — the preference
// applies everywhere, so a per-session home would misleadingly imply
// otherwise.
function hideThoughtsRow(): HTMLElement {
  return el(
    "div",
    { class: "detail" },
    el("span", { class: "k" }, "hide thoughts"),
    el(
      "label",
      { class: "checkbox-label" },
      el("input", {
        type: "checkbox",
        checked: state.hideThoughts ? "" : undefined,
        onchange: (e: Event) => {
          setState({ hideThoughts: (e.target as HTMLInputElement).checked });
        },
      }),
    ),
  );
}

// Global (device-wide, not per-session) toggle for a Web Push
// notification when a turn THIS device submitted finishes while it
// isn't the one being looked at (see ws-bridge.ts / turn-notify-callback.ts).
// Turning it on requests Notification permission and subscribes right
// away rather than waiting for the first turn to finish, so a denial
// surfaces immediately instead of silently. Lives in the global options
// modal — subscribing here arms it for every session, not just
// whichever one happened to be open.
function notifyOnTurnEndRow(): HTMLElement {
  return el(
    "div",
    { class: "detail" },
    el("span", { class: "k" }, "notify"),
    el(
      "label",
      { class: "checkbox-label" },
      el("input", {
        type: "checkbox",
        checked: state.notifyOnTurnEnd ? "" : undefined,
        onchange: (e: Event) => {
          const checked = (e.target as HTMLInputElement).checked;
          if (!checked) {
            setState({ notifyOnTurnEnd: false });
            void unsubscribeFromPush().then(() => reportPushEndpoint());
            return;
          }
          void requestNotificationPermission().then((granted) => {
            if (!granted) {
              setState({
                banner: {
                  kind: "warn",
                  text: "Notifications blocked — enable them for this site in your browser settings.",
                },
              });
              return;
            }
            setState({ notifyOnTurnEnd: true });
            void subscribeForPush().then(() => reportPushEndpoint());
          });
        },
      }),
    ),
  );
}

function openOptionsModal(): void {
  const sid = state.current?.sessionId;
  state.cacheInfo = sid ? "…" : "no session open";
  if (sid) {
    void describeCachedSession(sid).then((info: string) => {
      state.cacheInfo = info;
      render();
    });
  }
  state.daemonVersion = "…";
  void api<{ status: string; upstream?: { version?: string } }>("/api/health")
    .then((res) => {
      state.daemonVersion = res.upstream?.version ?? "unknown";
      render();
    })
    .catch(() => {
      state.daemonVersion = "unreachable";
      render();
    });
  setState({ modal: { kind: "options" } });
}

// Global (device-wide) light/dark theme picker. Lives in the same spot
// as hideThoughts/notifyOnTurnEnd — a display preference, not session
// state. applyTheme (theme.ts) does the actual work; this just persists
// the choice and re-triggers it.
const THEME_OPTIONS: Array<{ value: AppState["theme"]; label: string }> = [
  { value: "system", label: "system" },
  { value: "dark", label: "dark" },
  { value: "light", label: "light" },
];

const FONT_SCALE_OPTIONS = [
  { value: 0.85, label: "smaller" },
  { value: 0.95, label: "small" },
  { value: 1, label: "normal" },
  { value: 1.15, label: "large" },
  { value: 1.3, label: "larger" },
  { value: 1.5, label: "largest" },
];

function fontSizeRow(): HTMLElement {
  const select = el(
    "select",
    {
      onchange: (e: Event) => {
        setState({ fontScale: Number((e.target as HTMLSelectElement).value) });
        applyFontScale();
      },
    },
    ...FONT_SCALE_OPTIONS.map((opt) =>
      el("option", { value: String(opt.value) }, opt.label),
    ),
  ) as HTMLSelectElement;
  select.value = String(state.fontScale);
  return el("div", { class: "detail" }, el("span", { class: "k" }, "text size"), select);
}

// Which bundle this client is actually running. A stale cached PWA and
// a real bug present identically, and there's no inspector to hand on a
// phone — this makes the difference readable in two taps.
// Tap to copy. These exist to be reported back, and retyping a build
// stamp or a frame breakdown off a phone screen is exactly the friction
// that stops someone bothering. Falls back to a selection when the
// clipboard API isn't available (it needs a secure context, and this is
// reachable over plain http on a LAN), so the value is still grabbable.
function copyableDiagnostic(label: string, value: string): HTMLElement {
  const shown = el("span", { class: "diag-value" }, value);
  const row = el(
    "div",
    {
      class: "detail diag-copy",
      title: "Tap to copy",
      ...tapHandler(() => {
        const done = (): void => {
          const prev = shown.textContent;
          shown.textContent = "copied";
          setTimeout(() => {
            shown.textContent = prev;
          }, 1200);
        };
        const text = `${label}: ${value}`;
        if (navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(text).then(done, () => selectFallback(shown));
        } else {
          selectFallback(shown);
        }
      }),
    },
    el("span", { class: "k" }, label),
    shown,
  );
  return row;
}

// No clipboard API — select the text so a long-press "Copy" still works.
function selectFallback(node: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

// What this client's history cache holds for the open session. Readable
// on a phone, where the console isn't.
function cacheRow(): HTMLElement {
  return copyableDiagnostic("cache", state.cacheInfo ?? "…");
}

function buildRow(): HTMLElement {
  const id = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";
  return copyableDiagnostic("build", id);
}

function versionRow(): HTMLElement {
  const version = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
  return copyableDiagnostic("browser", version);
}

function daemonVersionRow(): HTMLElement {
  return copyableDiagnostic("daemon", state.daemonVersion ?? "…");
}

function themeRow(): HTMLElement {
  const select = el(
    "select",
    {
      onchange: (e: Event) => {
        setState({ theme: (e.target as HTMLSelectElement).value as AppState["theme"] });
        applyTheme();
      },
    },
    ...THEME_OPTIONS.map((opt) => {
      const el_ = el("option", { value: opt.value }, opt.label);
      if (opt.value === state.theme) el_.setAttribute("selected", "");
      return el_;
    }),
  ) as HTMLSelectElement;
  select.value = state.theme;
  return el("div", { class: "detail" }, el("span", { class: "k" }, "theme"), select);
}

// Global, device-wide preferences — as opposed to the per-session
// chat-details panel, which holds settings scoped to one session
// (title, cwd, model/mode/agent). Reachable from the gear button on
// both the session-list topbar and a session's chat header, so it's
// available whether or not a session happens to be open.
function renderOptionsModal(): HTMLElement {
  return el(
    "div",
    {
      class: "modal-bg",
      ...tapHandler((e) => {
        if ((e.target as HTMLElement).classList.contains("modal-bg")) closeModal();
      }),
    },
    el(
      "div",
      { class: "modal" },
      el("h2", null, "Options"),
      themeRow(),
      fontSizeRow(),
      hideThoughtsRow(),
      notifyOnTurnEndRow(),
      // Diagnostics, not settings — nothing here is adjustable. Kept
      // because both have already earned their place: "which bundle is
      // this client on" and "what does its cache actually hold" were
      // each unanswerable on a phone, and each one cost a wrong
      // conclusion before it existed.
      el(
        "div",
        { class: "diagnostics" },
        versionRow(),
        daemonVersionRow(),
        buildRow(),
        cacheRow(),
        copyableDiagnostic("slow", describeSlow()),
        copyableDiagnostic("paths", describeCounts()),
      ),
      el(
        "div",
        { class: "actions" },
        el("button", { class: "primary", ...tapHandler(closeModal) }, "Close"),
      ),
    ),
  );
}

// One row per config-option dimension (hydra's own model/mode/agent
// plus whatever the agent advertises on its own, e.g. effort) in the
// expanded chat-details panel. A native <select> beats cycling/modal
// pickers here since there can be an arbitrary, agent-defined number of
// these and the user just wants to jump straight to a value.
function configOptionRow(option: ConfigOption): HTMLElement {
  const select = el(
    "select",
    {
      onchange: (e: Event) => {
        sendSetConfigOption(option.id, (e.target as HTMLSelectElement).value);
      },
    },
    ...option.options.map((v) => {
      const opt = el("option", { value: v.value }, v.name || v.value);
      if (v.value === option.currentValue) opt.setAttribute("selected", "");
      return opt;
    }),
  ) as HTMLSelectElement;
  select.value = option.currentValue;
  return el(
    "div",
    { class: "detail" },
    el("span", { class: "k", title: option.description ?? "" }, option.name || option.id),
    select,
  );
}

// compareSessions resorts by activity on every poll, which can slide a
// card out from under the cursor in the instant between hovering it and
// clicking. An earlier attempt froze the order for as long as the
// pointer merely hovered .list at all — but a click leaves the cursor
// resting exactly on the card it landed on, so opening a session and
// then reading its reply (mouse untouched, still over that same rail
// card the whole time) froze that card's position indefinitely: it
// looked like the highlighted entry had simply stopped responding to
// its own activity changing. Keying off recent pointer MOVEMENT instead
// of mere presence self-heals — a stationary mouse goes idle after
// REORDER_HOLDOFF_MS and reordering resumes on its own, while an
// approaching click (which involves actual motion right up to the
// moment of contact) still finds the order held still.
const REORDER_HOLDOFF_MS = 500;
let lastListPointerMoveAt = 0;
document.addEventListener("pointermove", (e) => {
  if ((e.target as Element | null)?.closest?.(".list")) {
    lastListPointerMoveAt = performance.now();
  }
});

let lastCommittedOrder: string[] | null = null;

function stableSortSessions(sessions: SessionInfo[]): SessionInfo[] {
  const natural = sessions.slice().sort(compareSessions);
  const idle = performance.now() - lastListPointerMoveAt > REORDER_HOLDOFF_MS;
  if (idle || !lastCommittedOrder) {
    lastCommittedOrder = natural.map((s) => s.sessionId);
    return natural;
  }
  const rank = new Map(lastCommittedOrder.map((id, i) => [id, i]));
  return natural
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const ra = rank.get(a.s.sessionId);
      const rb = rank.get(b.s.sessionId);
      // Both previously ranked: keep their held order. Only one ranked:
      // it keeps its place and the newcomer goes after every held row
      // rather than jumping in among them. Neither ranked (both new
      // since the hold began): fall back to natural order between
      // themselves.
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return a.i - b.i;
    })
    .map((x) => x.s);
}

function groupSessions(sessions: SessionInfo[], mode: "project" | "recent"): SessionGroup[] {
  const ordered = stableSortSessions(sessions);
  if (mode === "recent") {
    return [{ label: null, sessions: ordered }];
  }
  const map = new Map<string, SessionInfo[]>();
  for (const s of ordered) {
    const key = s.cwd || "(unknown)";
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(s);
  }
  const out: SessionGroup[] = [];
  for (const [cwd, items] of [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push({ label: shortenCwd(cwd), sessions: items });
  }
  return out;
}

// "recent" grouping re-sorts the whole list by activity on every poll
// (compareSessions), so a session below the fold changing tier (idle ->
// busy, say) reshuffles rows above and below the user's current scroll
// position. Restoring a raw scrollTop pixel value after that leaves the
// scrollbar in the same place but shows different cards underneath it —
// reads as "losing my scroll" even though nothing actually reset it.
// Anchoring to the session card nearest the top of the viewport (and its
// exact sub-pixel offset) instead survives reordering elsewhere in the
// list, since that card's rank changing doesn't move IT.
//
// Uses getBoundingClientRect(), not offsetTop, deliberately: .list has
// no `position`, so it's never a card's offsetParent (that lands on
// whatever positioned ancestor — or <body> — the walk-up finds), which
// made offsetTop and list.scrollTop two different coordinate spaces.
// getBoundingClientRect is always viewport-relative on both sides, so
// diffing two rects is safe regardless of who ends up as offsetParent.
export interface ListScrollAnchor {
  sessionId: string;
  offset: number;
}

export function captureListAnchor(list: HTMLElement): ListScrollAnchor | null {
  // Scrolled to the very top means "show me the top of the list",
  // not "keep this particular card exactly here" — pinning to
  // whichever card happened to be first, by identity, is what made a
  // reorder that promoted a different card to first place scroll the
  // list DOWN to drag the old first card back to the top, hiding the
  // new arrival above the fold instead of just leaving the view at 0
  // like the user was already looking at. A fresh .list defaults its
  // own scrollTop to 0, so returning null here and doing nothing is
  // sufficient to keep it there.
  if (list.scrollTop <= 0) return null;
  const listTop = list.getBoundingClientRect().top;
  for (const card of list.querySelectorAll<HTMLElement>(".card")) {
    const cardRect = card.getBoundingClientRect();
    if (cardRect.bottom <= listTop) continue;
    const sessionId = card.dataset.sessionId;
    if (!sessionId) return null;
    return { sessionId, offset: cardRect.top - listTop };
  }
  return null;
}

export function restoreListAnchor(list: HTMLElement, anchor: ListScrollAnchor | null): void {
  if (!anchor) return;
  const card = list.querySelector<HTMLElement>(
    `.card[data-session-id="${CSS.escape(anchor.sessionId)}"]`,
  );
  if (!card) return;
  const delta = card.getBoundingClientRect().top - list.getBoundingClientRect().top - anchor.offset;
  list.scrollTop += delta;
}

function renderSessionCard(s: SessionInfo, showCwd: boolean): HTMLElement {
  const title = s.title || fallbackTitle(s.sessionId);
  const subtitle = [
    shortSessionId(s.sessionId),
    agentWithModel(s.agentId, s.currentModel),
    `age ${formatRelativeAge(s.updatedAt)}`,
  ].join(" · ");
  // A session with armed background tasks but no turn in flight is idle
  // right now but may restart itself with no prompt. The TUI just folds
  // that into "busy" rather than giving it its own status, so mirror
  // that here instead of a separate "armed" badge.
  const armed = !s.busy && (s.armedTasks ?? 0) > 0;
  return el(
    "div",
    {
      class: s.sessionId === state.listHighlightedSessionId ? "card highlighted" : "card",
      "data-session-id": s.sessionId,
      ...tapHandler((e) => {
        const target = e.target as HTMLElement;
        if (target.closest("button")) return;
        openOrFocusChat(s.sessionId, s.status === "cold");
      }),
    },
    el("div", { class: "row1" }, title),
    el(
      "div",
      { class: "card-body" },
      el(
        "div",
        { class: "meta" },
        el("div", { class: "row2" }, subtitle),
      ),
      el(
        "div",
        { class: "badges" },
        // "warm" is implied by busy/needs-input/armed (you can't be busy
        // and not warm), so skip the redundant badge whenever one of
        // those is already showing — "cold" is still worth its own badge
        // since it's the interesting/actionable state either way.
        s.status === "cold" || !(s.busy || s.awaitingInput || armed)
          ? el(
              "span",
              {
                class: `badge ${s.status === "cold" ? "cold" : "warm"}`,
                title:
                  s.status === "cold"
                    ? "Disk-only — opening will resurrect the session"
                    : "Live in-memory session",
              },
              s.status === "cold" ? "cold" : "warm",
            )
          : null,
        // busy and blocked are independent axes, not one enum — a session
        // can be mid-turn AND blocked on a permission prompt at once, so
        // both badges can legitimately show together.
        s.busy || armed
          ? el(
              "span",
              {
                class: "badge busy",
                title: s.busy
                  ? "Agent is working"
                  : "Agent has a background task running. It may resume on its own.",
              },
              "busy",
            )
          : null,
        s.awaitingInput
          ? el(
              "span",
              {
                class: "badge blocked",
                title: "Waiting on you — a permission request or other prompt is pending",
              },
              "blocked",
            )
          : null,
        ...(s.importedFromMachine && !s.upstreamSessionId
          ? [
              el(
                "span",
                {
                  class: "badge imported",
                  title: `Passive mirror imported from ${s.importedFromMachine} — attach to start working on it here.`,
                },
                `← ${s.importedFromMachine}`,
              ),
            ]
          : []),
        ...(s.remote
          ? [
              el(
                "span",
                {
                  class: "badge remote",
                  title: `Live on remote "${s.remote}" — attaching forwards through, nothing is copied here.`,
                },
                `⇄ ${s.remote}`,
              ),
            ]
          : []),
      ),
    ),
    showCwd
      ? el("div", { class: "row3" }, s.cwd ? shortenCwd(s.cwd) : "?")
      : null,
    // Pinned to the card's own top-right corner rather than living in
    // the badge row. In that row its position drifted with whichever
    // badges a given card happened to have, and an action styled to sit
    // among status chips read as a fourth status. Only for sessions that
    // are actually running — there is nothing to kill on a cold
    // (disk-only) one. Not gated on the "warm" badge, which is
    // suppressed while a session is busy or blocked (warm is implied by
    // both) — those are exactly the sessions worth stopping.
    s.status !== "cold"
      ? el(
          "button",
          {
            class: "card-kill",
            title: "Kill this session",
            ...tapHandler(() => void killSession(s)),
          },
          "×",
        )
      : null,
  );
}

async function killSession(s: SessionInfo): Promise<void> {
  if (
    !confirm(
      `Kill session ${s.title ? `"${s.title}" (${shortSessionId(s.sessionId)})` : shortSessionId(s.sessionId)}?`,
    )
  )
    return;
  try {
    await api("/api/kill", {
      method: "POST",
      body: JSON.stringify({ sessionId: s.sessionId }),
    });
    void pollSessions();
  } catch (err) {
    setState({
      banner: { kind: "bad", text: "kill failed: " + (err as Error).message },
    });
  }
}

// Click handler for the context-usage pill. A no-op while compaction is
// already running/queued (compactionPhase set) rather than re-prompting —
// onCompactionUpdate (acp.ts) clears it and toasts a banner once the
// daemon reports a terminal phase.
function requestCompact(c: ChatState): void {
  if (c.compactionPhase) return;
  if (!confirm("Compact this session's context now? The agent will summarize history and continue from the summary.")) {
    return;
  }
  sendCompactCommand();
}

// Navigate to the export endpoint to trigger the browser's native
// download flow. The proxy forwards the daemon's Content-Disposition
// header so the file lands with the right filename; the session
// cookie carries auth automatically. We use an off-screen anchor
// instead of window.location to avoid blowing away SPA state if the
// download is interrupted or rejected.
function triggerExportDownload(sessionId: string): void {
  const a = document.createElement("a");
  a.href = `/api/sessions/${encodeURIComponent(sessionId)}/export`;
  // Hint the browser that this is a download — the server-supplied
  // Content-Disposition filename still wins, but the empty string
  // is enough to suppress the "navigate away" fallback in some
  // browsers when the server is slow to respond.
  a.download = "";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Open a hidden file picker; on selection, parse the JSON, POST it
// to the import endpoint. Handle 409 (lineageId clash) by asking
// the user whether to retry with replace.
function openImportPicker(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".hydra,application/json";
  input.style.display = "none";
  input.onchange = () => {
    const file = input.files && input.files[0];
    document.body.removeChild(input);
    if (!file) return;
    void importBundleFromFile(file);
  };
  document.body.appendChild(input);
  input.click();
}

async function importBundleFromFile(file: File): Promise<void> {
  let bundle: unknown;
  try {
    const text = await file.text();
    bundle = JSON.parse(text);
  } catch (err) {
    setState({
      banner: {
        kind: "bad",
        text: "import: bundle is not valid JSON: " + (err as Error).message,
      },
    });
    return;
  }
  const first = await tryImportBundleWith409(bundle);
  if (first.ok) {
    const r = first.result;
    setState({
      banner: {
        kind: "good",
        text: r.replaced
          ? `Replaced ${shortSessionId(r.sessionId)} from bundle`
          : `Imported as ${shortSessionId(r.sessionId)}`,
      },
    });
    void pollSessions();
    return;
  }
  if (first.status === 409 && first.existingSessionId) {
    const existing = first.existingSessionId;
    const ok = confirm(
      `This session is already imported locally as ${shortSessionId(existing)}.\n\nReplace it? (Any live attach will be closed.)`,
    );
    if (!ok) {
      setState({
        banner: { kind: "warn", text: "Import cancelled." },
      });
      return;
    }
    try {
      const result = await importBundle(bundle, { replace: true });
      setState({
        banner: {
          kind: "good",
          text: `Replaced ${shortSessionId(result.sessionId)} from bundle`,
        },
      });
      void pollSessions();
    } catch (err) {
      setState({
        banner: {
          kind: "bad",
          text: "import failed: " + (err as Error).message,
        },
      });
    }
    return;
  }
  setState({
    banner: { kind: "bad", text: "import failed: " + first.message },
  });
}

// ---- New-session modal -------------------------------------------

const LAST_CWD_KEY = "hydra-acp-browser:lastCwd";
const CWD_HISTORY_KEY = "hydra-acp-browser:cwdHistory";
const CWD_HISTORY_LIMIT = 20;

// Most-recent-first, deduplicated. Seeded from the older single-value
// lastCwd key on first read so upgrading doesn't lose the one cwd
// someone already had remembered.
function loadCwdHistory(): string[] {
  try {
    const raw = localStorage.getItem(CWD_HISTORY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((v) => typeof v === "string");
    }
    const legacy = localStorage.getItem(LAST_CWD_KEY);
    return legacy ? [legacy] : [];
  } catch {
    return [];
  }
}

function loadLastCwd(): string | null {
  return loadCwdHistory()[0] ?? null;
}

function saveLastCwd(cwd: string): void {
  try {
    const history = loadCwdHistory().filter((v) => v !== cwd);
    history.unshift(cwd);
    localStorage.setItem(
      CWD_HISTORY_KEY,
      JSON.stringify(history.slice(0, CWD_HISTORY_LIMIT)),
    );
    localStorage.removeItem(LAST_CWD_KEY);
  } catch {
    // Private browsing / quota — the field just won't persist.
  }
}

function openSessionModal(): void {
  setState({
    modal: {
      kind: "session",
      cwd: loadLastCwd() ?? state.defaultCwd ?? "",
      // Empty means "let the daemon pick its default" — see the
      // `if (m.agentId)` guard in createSession, which omits the field
      // entirely rather than sending a resolved id.
      agentId: "",
      name: "",
      prompt: "",
      err: null,
      busy: false,
      // "" = local, the default.
      remote: "",
    },
  });
}

function renderSessionModal(m: SessionModalData): HTMLElement {
  return el(
    "div",
    {
      class: "modal-bg",
      ...tapHandler((e) => {
        if ((e.target as HTMLElement).classList.contains("modal-bg")) closeModal();
      }),
    },
    el(
      "div",
      { class: "modal" },
      el("h2", null, "New session"),
      ...(state.remotes.length > 0
        ? [
            el(
              "div",
              { class: "field" },
              el("label", { for: "f-remote" }, "create on"),
              renderRemoteSelect(m),
            ),
          ]
        : []),
      el(
        "div",
        { class: "field" },
        el("label", { for: "f-cwd" }, m.remote ? "cwd (optional)" : "cwd"),
        el("input", {
          id: "f-cwd",
          "data-focus-key": "session-modal-cwd",
          value: m.cwd,
          // A remote create's cwd resolves against the peer's own
          // filesystem — this box can't offer meaningful history/
          // defaults for it, so the field is just a plain optional
          // override in that case rather than the usual local-history
          // autocomplete.
          placeholder: m.remote
            ? "leave blank to use the remote's default"
            : "/home/you/dev/project",
          ...(m.remote ? {} : { list: "f-cwd-history" }),
          autocomplete: "off",
          oninput: (e: Event) => {
            m.cwd = (e.target as HTMLInputElement).value;
          },
        }),
        m.remote
          ? null
          : el(
              "datalist",
              { id: "f-cwd-history" },
              ...loadCwdHistory().map((cwd) => el("option", { value: cwd })),
            ),
      ),
      // state.agents is *this* daemon's agent list — meaningless for a
      // remote create, where the peer has its own registered agents
      // and will apply its own default. Hide the field rather than
      // offer a choice that may not even exist on the target.
      m.remote
        ? null
        : el(
            "div",
            { class: "field" },
            el("label", { for: "f-agent" }, "agent"),
            renderAgentSelect(m),
          ),
      el(
        "div",
        { class: "field" },
        el("label", { for: "f-name" }, "name (optional)"),
        el("input", {
          id: "f-name",
          "data-focus-key": "session-modal-name",
          value: m.name,
          placeholder: "feature-x",
          oninput: (e: Event) => {
            m.name = (e.target as HTMLInputElement).value;
          },
        }),
      ),
      el(
        "div",
        { class: "field" },
        el("label", { for: "f-prompt" }, "first prompt (optional)"),
        el(
          "textarea",
          {
            id: "f-prompt",
            "data-focus-key": "session-modal-prompt",
            rows: "4",
            placeholder: "What should the agent do first?",
            autocapitalize: "off",
            oninput: (e: Event) => {
              m.prompt = (e.target as HTMLTextAreaElement).value;
            },
          },
          m.prompt,
        ),
      ),
      m.err ? el("div", { class: "err" }, m.err) : null,
      el(
        "div",
        { class: "actions" },
        // Deliberately NOT disabled while busy: a create that stalls
        // would otherwise leave no way out but a reload.
        el("button", { ...tapHandler(closeModal) }, "Cancel"),
        el(
          "button",
          { class: "primary", ...tapHandler(createSession), disabled: m.busy },
          m.busy ? "Creating…" : "Create",
        ),
      ),
    ),
  );
}

function renderRemoteSelect(m: SessionModalData): HTMLElement {
  const sel = el("select", {
    id: "f-remote",
    "data-focus-key": "session-modal-remote",
    onchange: (e: Event) => {
      const next = (e.target as HTMLSelectElement).value;
      // The cwd field is pre-filled with *this* box's last-used local
      // path (see openSessionModal) or left over from a prior local
      // fill-in. That's meaningless — worse, actively wrong — on a
      // different machine, so it must not silently ride along into a
      // remote create: it either resolves to some unrelated directory
      // there or 500s the peer's session spawn outright. Switching
      // into remote mode clears it (peer applies its own default);
      // switching back to local restores the usual pre-fill.
      if (next && !m.remote) {
        m.cwd = "";
      } else if (!next && m.remote) {
        m.cwd = loadLastCwd() ?? state.defaultCwd ?? "";
      }
      m.remote = next;
      // Toggling this also changes the cwd field's label/placeholder
      // and whether the agent field shows at all, so — unlike the
      // other fields here — this needs an explicit re-render.
      render();
    },
  });
  const localOpt = el("option", { value: "" }, "local");
  if (m.remote === "") localOpt.setAttribute("selected", "");
  sel.appendChild(localOpt);
  for (const r of state.remotes) {
    const opt = el(
      "option",
      { value: r.name },
      r.status && r.status !== "ok" ? `${r.name} (${r.status})` : r.name,
    );
    if (r.name === m.remote) opt.setAttribute("selected", "");
    sel.appendChild(opt);
  }
  return sel;
}

function renderAgentSelect(m: SessionModalData): HTMLElement {
  const sel = el("select", {
    id: "f-agent",
    "data-focus-key": "session-modal-agent",
    onchange: (e: Event) => {
      m.agentId = (e.target as HTMLSelectElement).value;
    },
  });
  const defaultOpt = el("option", { value: "" }, "<default>");
  if (m.agentId === "") defaultOpt.setAttribute("selected", "");
  sel.appendChild(defaultOpt);
  for (const a of state.agents) {
    const opt = el("option", { value: a.id }, a.id);
    if (a.id === m.agentId) opt.setAttribute("selected", "");
    sel.appendChild(opt);
  }
  return sel;
}

async function createSession(): Promise<void> {
  const m = state.modal as SessionModalData | null;
  if (!m || m.kind !== "session") return;
  // cwd resolves against the peer's own filesystem for a remote
  // create, and the peer applies its own default when it's omitted —
  // same as a local create omitting cwd, just not this box's default.
  if (!m.remote && !m.cwd) {
    m.err = "cwd is required";
    render();
    return;
  }
  m.busy = true;
  m.err = null;
  render();
  try {
    const body: Record<string, unknown> = {};
    if (m.cwd) body.cwd = m.cwd;
    if (m.remote) {
      body.remote = m.remote;
    } else if (m.agentId) {
      // agentId is *this* daemon's agent id — meaningless to a peer,
      // which has its own agents and applies its own default.
      body.agentId = m.agentId;
    }
    if (m.name) body.name = m.name;
    if (m.prompt) body.prompt = m.prompt;
    // Generous, because this spawns an agent — but bounded, so a stalled
    // request surfaces as an error the user can act on instead of a
    // dialog wedged on "Creating…" forever.
    const data = await api<{ sessionId?: string }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify(body),
      timeoutMs: 60_000,
    });
    if (!m.remote && m.cwd) {
      saveLastCwd(m.cwd);
    }
    void pollSessions();
    // The dialog is dismissable while this is in flight, so it may
    // already be gone. If the user gave up on it, don't yank them into
    // a session they stopped waiting for — it's in the list either way.
    if (state.modal !== m) return;
    closeModal();
    if (data && data.sessionId) {
      openChat(data.sessionId, false);
    }
  } catch (err) {
    if (state.modal !== m) return;
    m.err = (err as Error).message;
    m.busy = false;
    render();
  }
}

export function closeModal(): void {
  setState({ modal: null });
}

// ---- Model picker --------------------------------------------------

function openModelPicker(): void {
  if (!state.current?.models || state.current.models.length === 0) return;
  setState({ modal: { kind: "models" } });
}

interface PickerItem {
  id: string;
  name?: string;
}

function renderListModal(
  title: string,
  items: PickerItem[],
  selectedId: string | null,
  onPick: (item: PickerItem) => void,
): HTMLElement {
  return el(
    "div",
    {
      class: "modal-bg",
      ...tapHandler((e) => {
        if ((e.target as HTMLElement).classList.contains("modal-bg")) closeModal();
      }),
    },
    el(
      "div",
      { class: "modal" },
      el("h2", null, title),
      ...items.map((it) =>
        el(
          "div",
          {
            class: "card",
            ...tapHandler(() => {
              onPick(it);
              closeModal();
            }),
          },
          el(
            "div",
            { class: "meta" },
            el("div", { class: "row1" }, it.name || it.id),
            el("div", { class: "row2" }, it.id),
          ),
          it.id === selectedId ? el("span", { class: "badge warm" }, "current") : null,
        ),
      ),
      el(
        "div",
        { class: "actions" },
        el("button", { ...tapHandler(closeModal) }, "Cancel"),
      ),
    ),
  );
}

// Mirrors the TUI's tasksGadget (cli/src/tui/sidebar/gadgets.ts): a list of
// background jobs the agent armed (Monitor, backgrounded Bash) that outlive
// their turn and can wake the session up on their own. REPLACE semantics —
// there's no "done" state, an entry simply stops appearing in the next
// armed_tasks_updated payload once it resolves.
const ARMED_TASKS_PAGE_SIZE = 5;

function renderArmedTasksBlock(c: ChatState): Node {
  const tasks = c.armedTaskList;
  if (!tasks || tasks.length === 0) return document.createTextNode("");
  const shown = tasks.slice(0, ARMED_TASKS_PAGE_SIZE);
  const now = Date.now();
  return el(
    "div",
    { class: "armed-tasks" },
    ...shown.map((t: ArmedTask) =>
      el(
        "div",
        { class: "armed-task" },
        el("span", { class: "dot" }, "◐"),
        el(
          "span",
          { class: "label" },
          t.label.length > 0 ? t.label : (t.taskType ?? "background task"),
        ),
        el("span", { class: "elapsed" }, formatDuration(now - t.since)),
      ),
    ),
    tasks.length > ARMED_TASKS_PAGE_SIZE
      ? el(
          "div",
          { class: "armed-tasks-more" },
          `+${tasks.length - ARMED_TASKS_PAGE_SIZE} more`,
        )
      : null,
  );
}

// ---- Chat view ---------------------------------------------------

// A long-running session's full log can run into the thousands of
// items, each markdown-rendered into DOM on attach — building all of it
// synchronously in one render() is what makes entering a big session
// feel frozen with scrolling unresponsive. Cap the initial paint to the
// recent tail; "show earlier" (renderAllHistory) opts back into the
// full log for the rest of this ChatState's life.
// How many log items are in the DOM at once.
//
// Tried at 70 on narrow screens on the theory that tearing down a large
// chat subtree was what froze the UI on mobile after Back. On-device
// timing showed render cost unchanged (~140ms either way), so log size
// is not what makes a render expensive, and the smaller window only cost
// reachable history. Left at 200 until something measured says otherwise.
const CHAT_LOG_RENDER_WINDOW = 200;

// Persistent per-session chat scaffolding. The full-teardown render model
// destroyed and recreated .chat-body (and every bubble in it) on every
// repaint — up to 10x/s while streaming. Each teardown killed in-flight
// scroll momentum and yanked tap targets out from under fingers, which on
// a phone reads as "the app is frozen" for as long as the streaming burst
// lasts, even though the main thread is mostly idle (confirmed via the
// perf overlay: no long tasks during the freezes). So the chat view keeps
// ONE .chat-body element alive for the life of the ChatState and
// reconciles its children in place; the light chrome around it (header,
// details, armed block, composer) still rebuilds each render into
// display:contents slots so it stays dumb and cheap.
interface ChatView {
  root: HTMLElement;
  body: HTMLElement;
  jump: HTMLDivElement;
  headerSlot: HTMLElement;
  detailsSlot: HTMLElement;
  armedSlot: HTMLElement;
  composerSlot: HTMLElement;
  // Follow-the-stream flag, owned by the body's scroll listener. Repaints
  // must NOT re-measure "is the user near the bottom?" themselves: during
  // streaming a repaint lands every ~100ms, and a user who just started
  // dragging up is still within the proximity threshold, so measure-and-pin
  // snapped them back down on every repaint — native scrolling lost the
  // fight for the whole turn ("can't scroll, but taps work, and the
  // thinking pill still pulses"). Scroll events are the user's voice:
  // any event away from the bottom unsticks, reaching the bottom
  // re-sticks, and reconcile only pins while stuck.
  stickToBottom: boolean;
  // True while at least one finger is on the scroller. A programmatic
  // scrollTop assignment landing during an active iOS touch-drag KILLS
  // the native gesture (the finger keeps moving, the browser has given
  // up on the scroll) — and repaints happen often enough (streaming
  // chunks in a turn, session polls outside one) that a drag started
  // from the bottom, while stickToBottom was still true, almost always
  // died to a mid-gesture pin. So the pin is deferred entirely while
  // touching.
  touchActive: boolean;
  // When the last touch lifted. Pinning right AT release is as bad as
  // mid-drag: a release at the bottom edge typically overscrolls into
  // the rubber-band, and a programmatic scroll colliding with the
  // bounce-back animation can wedge the WebKit scroller for seconds
  // (scrolling dead, taps fine). All pins hold off until the bounce has
  // settled (PIN_HOLDOFF_MS past this stamp).
  lastTouchEndAt: number;
  // When the scroller last emitted a scroll event. Momentum and the
  // rubber-band keep emitting these the whole time the scroller is
  // physically moving, so "quiet for SCROLL_QUIET_MS" is the ground
  // truth for "actually settled" — a fixed post-release delay isn't,
  // because back-to-back flicks stack momentum well past any constant
  // (observed: two quick scrolls to the bottom wedged it again). Our own
  // pins also emit scroll events, so this doubles as a self-debounce on
  // pin frequency.
  lastScrollAt: number;
  // Until this stamp, scroll events are treated as reflow, not as the
  // user scrolling. A full-replay swap replaces every node in the
  // scroller: scrollHeight collapses as they're removed and grows as
  // they're re-added, and the browser emits scroll events throughout.
  // The handler below reads those as "scrolled away from the bottom"
  // and clears stickToBottom, so the pin that should have followed the
  // swap never fires and the transcript settles near the bottom but not
  // at it. The pins are also self-debounced on lastScrollAt, which a
  // swap can never satisfy — it is emitting scroll events at the exact
  // moment the pin wants to run. Neither is a user gesture, so during
  // the swap both inferences are simply wrong.
  reflowUntil: number;
  // "Turn N of M" readout, live-updated as the current scroll position
  // crosses turn boundaries (see updateTurnToast) — not just after a
  // scrollToTurn jump. Visibility rides on the same .jump-to-latest
  // parent as the prev/next buttons, so it only needs its own text kept
  // current, no separate show/hide of its own.
  turnToast: HTMLDivElement;
  // The composer's textarea, built once and reused for this chat's whole
  // lifetime. Rebuilding it per render tore down the browser's native
  // IME/autocorrect session mid-word — see renderChat.
  composerTextarea?: HTMLTextAreaElement;
}

const PIN_HOLDOFF_MS = 450;
const SCROLL_QUIET_MS = 250;

// Pin to the bottom only when following, no finger is down, the scroller
// has been quiet long enough to be truly settled, and the position would
// actually change — a same-position assignment still disturbs iOS
// gesture state.
// Pin now, ignoring the settle heuristics. Only for app-driven rebuilds
// where there is no gesture to collide with — pinIfDue's guards exist to
// avoid writing scrollTop into a live iOS rubber-band, and a replay swap
// is not that. Re-asserted across a few frames because markdown and
// syntax highlighting change bubble heights after the first layout, and
// a single pin lands short of the real bottom.
function pinToBottomNow(view: ChatView): void {
  const body = view.body;
  if (Math.abs(body.scrollTop - (body.scrollHeight - body.clientHeight)) > 1) {
    body.scrollTop = body.scrollHeight;
  }
}

function pinAfterSwap(view: ChatView): void {
  view.stickToBottom = true;
  view.reflowUntil = performance.now() + 700;
  pinToBottomNow(view);
  requestAnimationFrame(() => pinToBottomNow(view));
  setTimeout(() => pinToBottomNow(view), 120);
  setTimeout(() => {
    pinToBottomNow(view);
    view.reflowUntil = 0;
    // Nothing re-evaluates the pill until the next scroll event, which
    // may never come if the swap left us settled at the bottom — so set
    // it from where we actually ended up.
    const body = view.body;
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 50;
    view.jump.classList.toggle("visible", !atBottom);
    updateTurnToast(body, view.turnToast);
  }, 450);
}

function pinIfDue(view: ChatView): void {
  if (!view.stickToBottom || view.touchActive) {
    return;
  }
  const now = performance.now();
  if (now - view.lastTouchEndAt < PIN_HOLDOFF_MS) {
    return;
  }
  if (now - view.lastScrollAt < SCROLL_QUIET_MS) {
    return;
  }
  const body = view.body;
  const target = body.scrollHeight - body.clientHeight;
  if (Math.abs(body.scrollTop - target) > 1) {
    body.scrollTop = body.scrollHeight;
  }
}

const chatViews = new WeakMap<ChatState, ChatView>();

// For swipe-nav.ts's list→chat drag-reveal: if the caller still holds a
// reference to a ChatState (routing.ts's lastClosedChat stashes the one
// just closed), its view — the real, already-rendered `.chat` DOM node,
// full transcript and scroll position intact — is still sitting right
// here in the WeakMap, just detached from #app since closeChat()'s
// teardown removed it. Reusing it beats building a fresh preview from
// scratch when swiping right back into the session you just left.
export function peekChatViewRoot(c: ChatState): HTMLElement | null {
  return chatViews.get(c)?.root ?? null;
}

// Companion to peekChatViewRoot — routing.ts's closeChat() calls this
// synchronously, before its own teardown runs, to capture the scroll
// position while the node is still attached and correctly laid out.
// Re-reading .chat-body.scrollTop later (once the node has been
// detached and possibly reattached elsewhere for the drag preview) is
// NOT equivalent: some browsers reset a scrolled element's scrollTop
// to 0 across a detach/reattach cycle, and every reinsertion is exactly
// that. Capturing once at the authoritative moment and threading the
// number through sidesteps the question of how many times the node
// gets moved before (or whether) it's ever shown again.
export function peekChatScrollTop(c: ChatState): number {
  return chatViews.get(c)?.body.scrollTop ?? 0;
}

function ensureChatView(c: ChatState): ChatView {
  let view = chatViews.get(c);
  if (view) {
    return view;
  }
  const body = el("div", { class: "chat-body" });
  // Sticky as the last flex item so it floats at the bottom of the
  // visible scroll area without needing to track the composer's
  // (variable) height. Toggled on scroll directly — not through a full
  // render(), which would tank scroll responsiveness. Three buttons:
  // prev/next-turn (touch equivalent of Cmd/Ctrl+PageUp/PageDown, no
  // modifier keys on a phone keyboard — see scrollToTurn) alongside the
  // original jump-to-bottom, all sharing this same "only while scrolled
  // away from the bottom" visibility instead of being permanently on
  // screen.
  const jumpBottomBtn = el(
    "button",
    {
      class: "jump-to-latest-btn",
      ...tapHandler(() => {
        body.scrollTop = body.scrollHeight;
        jump.classList.remove("visible");
      }),
    },
    "↓ Bottom",
  );
  const turnPrevBtn = el(
    "button",
    {
      class: "jump-to-latest-btn icon",
      ...tapHandler(() => scrollToTurn("prev")),
      title: "Previous turn (Cmd/Ctrl+PageUp)",
    },
    "▲",
  );
  const turnNextBtn = el(
    "button",
    {
      class: "jump-to-latest-btn icon",
      ...tapHandler(() => scrollToTurn("next")),
      title: "Next turn (Cmd/Ctrl+PageDown)",
    },
    "▼",
  );
  // "Turn N of M" readout — see the ChatView.turnToast comment. Sits
  // between the two turn buttons so it reads as "what those buttons
  // just did," and shares their parent's show/hide (no opacity/timer
  // of its own — see updateTurnToast).
  const turnToast = el("div", { class: "turn-toast" }) as HTMLDivElement;
  const jump = el(
    "div",
    { class: "jump-to-latest" },
    turnPrevBtn,
    turnToast,
    turnNextBtn,
    jumpBottomBtn,
  ) as HTMLDivElement;
  let jumpVisibilityRaf = 0;
  body.addEventListener(
    "scroll",
    () => {
      view!.lastScrollAt = performance.now();
      const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 50;
      // Programmatic pins only ever scroll TO the bottom, so any event
      // away from it is the user scrolling — stop following until they
      // come back down. Except while the scroller is being rebuilt under
      // us, when the events are the rebuild's own and mean nothing about
      // where the user wants to be (see reflowUntil).
      if (performance.now() >= view!.reflowUntil) {
        view!.stickToBottom = atBottom;
      }
      // jump toggles `display` (index.html), which is layout-affecting.
      // Flipping it synchronously from inside this handler lands the
      // mutation on the exact frame a touch-driven scroll settles at
      // the bottom edge — a DOM write right there is what wedged
      // WebKit's momentum/rubber-band compositor state for the
      // scroller (scrolling dead, taps fine, until another gesture
      // reset it). Defer to the next frame so it never lands inside
      // the scroll event's own call stack.
      if (jumpVisibilityRaf) cancelAnimationFrame(jumpVisibilityRaf);
      jumpVisibilityRaf = requestAnimationFrame(() => {
        jumpVisibilityRaf = 0;
        // Same reflow rule as stickToBottom above. A swap's mid-rebuild
        // scroll events read as "not at bottom", which flashed the
        // turn-navigator pill on for a frame or two before the pin put
        // it away again. pinAfterSwap sets the honest value once the
        // rebuild has settled.
        if (performance.now() < view!.reflowUntil) {
          return;
        }
        jump.classList.toggle("visible", !atBottom);
        updateTurnToast(body, turnToast);
      });
    },
    { passive: true },
  );
  let scrollHeightAtTouchStart = 0;
  body.addEventListener(
    "touchstart",
    () => {
      view!.touchActive = true;
      scrollHeightAtTouchStart = body.scrollHeight;
    },
    { passive: true },
  );
  const touchDone = (e: TouchEvent): void => {
    if (e.touches.length > 0) {
      return;
    }
    view!.touchActive = false;
    view!.lastTouchEndAt = performance.now();
    // If nothing grew while we were holding pins off, there's nothing to
    // catch up to — a plain manual drag-to-bottom with no streaming in
    // flight lands here with scrollHeight unchanged. Scheduling the
    // pins anyway means writing scrollTop into iOS's own rubber-band
    // settle animation for no reason, which is exactly what wedges the
    // scroller (scrolling dead, taps still fine, until another gesture
    // resets it). Any growth that happens AFTER release is already
    // caught by the ordinary render-driven pinIfDue call in
    // reconcileChatBody, so skipping here only drops the narrow case
    // these timers exist for: content that grew DURING the touch.
    if (body.scrollHeight === scrollHeightAtTouchStart) {
      return;
    }
    // Content may have grown while the pin was held off; catch up once
    // the rubber-band settle window has passed (pinning INTO the bounce
    // is what wedged the scroller). Timers, not immediate — the second
    // covers a release whose momentum outlasts the first attempt's
    // quiet check.
    setTimeout(() => pinIfDue(view!), PIN_HOLDOFF_MS + 50);
    setTimeout(() => pinIfDue(view!), PIN_HOLDOFF_MS + 900);
  };
  body.addEventListener("touchend", touchDone, { passive: true });
  body.addEventListener("touchcancel", touchDone, { passive: true });
  // Tapping anywhere in the history dismisses the keyboard (same
  // pattern as most chat apps, and as the composer's own swipe-down
  // gesture above). Commits on pointerup only, gated by a move
  // threshold to tell a tap from the start of a scroll drag — blurring
  // on pointerdown (or mid-drag) would kick off viewport.ts's height
  // recovery loop while a scroll gesture might still be starting,
  // which is the same class of mid-gesture DOM mutation that wedges
  // the scroller elsewhere in this file. No preventDefault or
  // stopPropagation, so a tap landing on an interactive bubble (a
  // thought toggle, a tool card) still runs its own handler normally —
  // this only adds the blur as a side effect.
  let dismissStartX = 0;
  let dismissStartY = 0;
  body.addEventListener(
    "pointerdown",
    (e: PointerEvent) => {
      dismissStartX = e.clientX;
      dismissStartY = e.clientY;
    },
    { passive: true },
  );
  body.addEventListener(
    "pointerup",
    (e: PointerEvent) => {
      if (isFormControl(e.target)) return;
      if (Math.hypot(e.clientX - dismissStartX, e.clientY - dismissStartY) > TAP_MOVE_THRESHOLD) {
        return;
      }
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
        active.blur();
      }
    },
    { passive: true },
  );
  const headerSlot = el("div", { class: "chat-slot" });
  const detailsSlot = el("div", { class: "chat-slot" });
  const armedSlot = el("div", { class: "chat-slot" });
  const composerSlot = el("div", { class: "chat-slot" });
  // Swipe down anywhere in the composer to dismiss the keyboard.
  // Attached to composerSlot (persistent for the ChatState's lifetime,
  // like body above) rather than the textarea itself — the textarea is
  // rebuilt on every render (renderChat's "light chrome" comment), so a
  // render landing mid-swipe (an incoming agent chunk, a poll, anything)
  // used to discard the in-progress gesture's listeners and state
  // along with the old node, and the swipe would just silently die.
  // Resolves the target dynamically via document.activeElement at
  // commit time instead of a captured textarea reference, for the same
  // reason: it may have been replaced since the gesture started.
  //
  // Entirely passive — no preventDefault anywhere — so it can never
  // block the textarea's own native caret/selection touch handling; a
  // downward drag just also calls blur() once it clearly reads as
  // "dismiss" rather than "position the caret." Direction-locked the
  // same way as swipe-nav.ts's list gesture: undecided until the drag
  // clears a small deadzone, then committed to whichever axis
  // dominated.
  //
  // blur() only fires on touchend, never from inside touchmove: calling
  // it while the finger is still down defers iOS's own visualViewport
  // resize reporting (viewport.ts's apply()/settle()) until the touch
  // sequence ends anyway, so the keyboard visually closes but #app's
  // height doesn't catch up until release. Same class of "don't mutate
  // mid-gesture" issue as the scroll-wedge fix elsewhere in this file.
  {
    const DISMISS_THRESHOLD_PX = 50;
    const DIRECTION_LOCK_PX = 10;
    let startX: number | null = null;
    let startY: number | null = null;
    let locked = false;
    let committed = false;
    const finish = (): void => {
      const active = document.activeElement;
      if (committed && (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement)) {
        active.blur();
      }
      startX = null;
      startY = null;
      locked = false;
      committed = false;
    };
    composerSlot.addEventListener(
      "touchstart",
      (e: TouchEvent) => {
        startX = null;
        startY = null;
        locked = false;
        committed = false;
        const active = document.activeElement;
        if (!(active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement)) return;
        const touch = e.touches[0];
        if (!touch) return;
        startX = touch.clientX;
        startY = touch.clientY;
      },
      { passive: true },
    );
    composerSlot.addEventListener(
      "touchmove",
      (e: TouchEvent) => {
        if (startX === null || startY === null) return;
        const touch = e.touches[0];
        if (!touch) return;
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;
        if (!locked) {
          if (Math.abs(dx) < DIRECTION_LOCK_PX && Math.abs(dy) < DIRECTION_LOCK_PX) {
            return;
          }
          if (Math.abs(dx) > Math.abs(dy) || dy < 0) {
            startX = null;
            startY = null;
            return;
          }
          locked = true;
        }
        committed = dy >= DISMISS_THRESHOLD_PX;
      },
      { passive: true },
    );
    composerSlot.addEventListener("touchend", finish, { passive: true });
    composerSlot.addEventListener("touchcancel", finish, { passive: true });
  }
  const root = el(
    "div",
    { class: "chat" },
    headerSlot,
    detailsSlot,
    armedSlot,
    body,
    composerSlot,
  );
  view = {
    root,
    body,
    jump,
    headerSlot,
    detailsSlot,
    armedSlot,
    composerSlot,
    stickToBottom: true,
    touchActive: false,
    lastTouchEndAt: 0,
    lastScrollAt: 0,
    reflowUntil: 0,
    turnToast,
  };
  chatViews.set(c, view);
  return view;
}

// Per-item node cache: a bubble whose inputs haven't changed keeps its
// exact DOM node across renders, so reconciliation leaves it untouched.
// The sig array snapshots every input renderLogItem reads for that item
// kind; element-wise === is enough because text strings are only replaced
// (never mutated), so an unchanged bubble compares by reference in O(1).
// Kinds that return null (spinner, perm, plan) are volatile or read
// external state — they rebuild every render and get swapped in place.
const logNodeCache = new WeakMap<object, { node: Node; sig: unknown[] }>();

function logItemSig(item: ChatState["log"][number]): unknown[] | null {
  if (item.kind === "stream") {
    const qe = item.queueEntry;
    return [
      item.text,
      item.role,
      item.synthetic ?? false,
      item.closed ?? false,
      collapsedThoughts.has(item),
      qe?.status,
      qe?.amendedByMessageId,
      qe?.amendsMessageId,
      item.attachments?.length ?? 0,
    ];
  }
  if (item.kind === "system" || item.kind === "error") {
    return [item.text];
  }
  if (item.kind === "edit-diff") {
    return [item.diff, item.expanded, item.status];
  }
  if (item.kind === "exit-plan-mode") {
    return [item.plan, item.status];
  }
  if (item.kind === "turn-stamp") {
    return [item.elapsedMs, item.toolCount, item.stopReason];
  }
  return null;
}

const SCROLLABLE_IN_BUBBLE = "pre, table";

function carryScrollAcross(oldNode: Node, newNode: Node): void {
  if (!(oldNode instanceof HTMLElement) || !(newNode instanceof HTMLElement)) return;
  const before = oldNode.querySelectorAll<HTMLElement>(SCROLLABLE_IN_BUBBLE);
  if (before.length === 0) return;
  const offsets: Array<[number, number]> = [];
  before.forEach((el_, i) => {
    if (el_.scrollLeft !== 0 || el_.scrollTop !== 0) {
      offsets.push([i, el_.scrollLeft]);
    }
  });
  if (offsets.length === 0) return;
  queueMicrotask(() => {
    const after = newNode.querySelectorAll<HTMLElement>(SCROLLABLE_IN_BUBBLE);
    for (const [i, left] of offsets) {
      const target = after[i];
      if (target) target.scrollLeft = left;
    }
  });
}

function cachedLogNode(item: ChatState["log"][number]): Node {
  const sig = logItemSig(item);
  if (sig === null) {
    return renderLogItem(item);
  }
  const hit = logNodeCache.get(item);
  if (hit && hit.sig.length === sig.length && hit.sig.every((v, i) => v === sig[i])) {
    bump("node-hit");
    return hit.node;
  }
  bump(hit ? "node-resig" : "node-new");
  const node = renderLogItem(item);
  // A rebuilt node starts scrolled to 0, which is right for its content
  // and wrong for the user: the bubble still streaming is exactly the one
  // being rebuilt every chunk, so a horizontally-scrolled code block
  // inside it snapped back constantly while its own message was still
  // arriving. The text is new; where the reader had scrolled to is not.
  //
  // Matched by position rather than identity — the old and new trees are
  // built by the same code from the same item, so the nth scrollable in
  // one is the nth in the other. Restored after the caller has attached
  // it, since scrollLeft doesn't stick on a detached node.
  if (hit) {
    carryScrollAcross(hit.node, node);
  }
  logNodeCache.set(item, { node, sig });
  return node;
}

// Minimal child sync: walks the desired list, moving/inserting only
// nodes that differ from what's already at that position, then trims
// leftovers. Unchanged nodes are identity-stable (cachedLogNode), so a
// typical streaming repaint touches exactly one child — the growing
// bubble — and the scroll container itself is never rebuilt.
function syncChildren(parent: HTMLElement, desired: Node[]): void {
  // Drop anything no longer wanted BEFORE walking positions. Otherwise a
  // single replaced node cascades: the new node is inserted ahead of the
  // stale one, the stale one still occupies a slot, and every node after
  // it is then one position out and gets insertBefore'd back into place.
  // Those are moves of nodes that never changed — visually identical, so
  // nothing looks wrong, but a move resets DOM-held state, and a code
  // block's horizontal scroll is DOM-held state.
  //
  // It fires constantly rather than rarely: the spinner's signature is
  // null (it re-renders by design, to tick its elapsed time), so it is a
  // fresh node every render, and it sits directly above the whole of the
  // current turn's output. Every streamed chunk was therefore moving
  // every bubble below it — measured as node-hit:8819 against
  // node-resig:18, i.e. the nodes were being reused correctly and then
  // shuffled anyway.
  const wanted = new Set(desired);
  for (let i = parent.childNodes.length - 1; i >= 0; i--) {
    const node = parent.childNodes[i]!;
    if (!wanted.has(node)) {
      parent.removeChild(node);
    }
  }
  for (let i = 0; i < desired.length; i++) {
    const want = desired[i]!;
    const have = parent.childNodes[i] ?? null;
    if (have !== want) {
      parent.insertBefore(want, have);
    }
  }
  while (parent.childNodes.length > desired.length) {
    parent.removeChild(parent.lastChild!);
  }
}

function reconcileChatBody(c: ChatState, view: ChatView): void {
  const body = view.body;
  const capped = !c.renderAllHistory && c.log.length > CHAT_LOG_RENDER_WINDOW;
  // Snap the cut back to a turn boundary. A flat "last N items" slice
  // lands wherever it lands, and a long turn (dozens of thought chunks
  // and tool calls before its first message) can easily be bigger than
  // the window on its own — so the prompt falls above the cut while its
  // own output stays below, and the turn renders headless. That reads
  // exactly like the prompt was lost. Bounded at twice the window so a
  // single enormous turn can't drag an unbounded amount into view.
  let start = capped ? c.log.length - CHAT_LOG_RENDER_WINDOW : 0;
  if (capped) {
    const floor = Math.max(0, c.log.length - CHAT_LOG_RENDER_WINDOW * 2);
    for (let i = start; i >= floor; i--) {
      const item = c.log[i];
      if (item && item.kind === "stream" && item.role === "user") {
        start = i;
        break;
      }
    }
  }
  const visibleLog = capped ? c.log.slice(start) : c.log;
  const desired: Node[] = [];
  // Only once the user has scrolled past everything locally available
  // (the DOM window AND the cache-seeded log itself) — this is the true
  // top, not just the render-window boundary "show earlier" handles.
  if (c.historyIsPartial && !capped) {
    desired.push(
      el(
        "button",
        {
          class: "show-earlier",
          ...tapHandler(() => requestFullHistory(c)),
        },
        "Load full history",
      ),
    );
  }
  if (capped) {
    // Counts what's actually above the cut, which the turn-boundary snap
    // above may have moved earlier than the raw window size.
    const hiddenCount = start;
    desired.push(
      el(
        "button",
        {
          class: "show-earlier",
          ...tapHandler(() => {
            c.renderAllHistory = true;
            render();
          }),
        },
        `Show ${hiddenCount} earlier message${hiddenCount === 1 ? "" : "s"}`,
      ),
    );
  }
  for (const item of visibleLog) {
    // hideThoughts skips agent_thought_chunk bubbles at render time
    // only — they stay in c.log so toggling the preference back on
    // (or exporting the session) still shows/keeps them.
    if (state.hideThoughts && item.kind === "stream" && item.role === "thought") {
      continue;
    }
    desired.push(cachedLogNode(item));
  }
  desired.push(view.jump);
  syncChildren(body, desired);
  if (c.pinAfterReplaySwap) {
    c.pinAfterReplaySwap = false;
    pinAfterSwap(view);
    return;
  }
  pinIfDue(view);
}

// In-place repaint for the common case: already showing this chat, no
// banner/modal/overlay in play. Skips the renderer's full teardown so
// .chat-body (and scroll momentum, and any in-progress tap) survives.
// Returns false when the situation calls for the teardown path.
// requestFullHistory's landing spot (see ChatState.scrollRestoreMessageId
// and routing.ts). Finds the bubble carrying the remembered wire
// messageId and scrolls it into view, clearing the anchor on success.
// Returns false (leaving the anchor set, untouched) when the message
// hasn't rendered yet, so the caller falls back to its own default and
// the NEXT render — teardown or patched, see the two call sites below —
// tries again.
//
// Has to be called from both: chatViews reuses the same view.root node
// identity across a history reset (only ChatState.log gets cleared, not
// the WeakMap entry), so once the freshly-reset (empty) chat matches
// tryPatchChat's structural check — which can be as early as the very
// next render, before any replay content has even arrived — every
// following render takes the patch path and skips renderer.ts's
// teardown branch entirely. An anchor hook living only in the teardown
// branch silently never fires, and the reload lands whichever way
// oldScrollTop happens to settle — the bug this exists to fix.
export function tryRestoreScrollAnchor(chatBody: HTMLElement): boolean {
  const anchorId = state.current?.scrollRestoreMessageId;
  if (!anchorId) return false;
  const anchor = chatBody.querySelector<HTMLElement>(
    `[data-message-id="${CSS.escape(anchorId)}"]`,
  );
  if (!anchor) return false;
  anchor.scrollIntoView({ block: "start" });
  state.current!.scrollRestoreMessageId = undefined;
  return true;
}

export function tryPatchChat(root: HTMLElement, s: AppState): boolean {
  if (s.view !== "chat" || !s.current) {
    return false;
  }
  if (s.banner || s.modal || s.current.fileOverlay) {
    return false;
  }
  const view = chatViews.get(s.current);
  if (!view) {
    return false;
  }
  if (isWideLayout()) {
    // Split layout: root -> .split -> [.rail, .split-detail -> view.root].
    // The rail is a sibling of the chat's own subtree, so patching the
    // chat here never touches it — refreshRailInPlace (cheap, dirty-
    // gated) is what keeps it current instead.
    if (root.childNodes.length !== 1) {
      return false;
    }
    const split = root.firstElementChild;
    if (!split || !split.classList.contains("split")) {
      return false;
    }
    const rail = split.querySelector<HTMLElement>(":scope > .rail");
    const detail = split.querySelector<HTMLElement>(":scope > .split-detail");
    if (!rail || !detail) {
      return false;
    }
    if (detail.childNodes.length !== 1 || detail.firstChild !== view.root) {
      return false;
    }
    refreshRailInPlace(rail);
    renderChat(s.current);
    tryRestoreScrollAnchor(view.body);
    return true;
  }
  if (root.childNodes.length !== 1 || root.firstChild !== view.root) {
    return false;
  }
  renderChat(s.current);
  tryRestoreScrollAnchor(view.body);
  return true;
}

// Called by renderer.ts's teardown path (banner/modal/file-overlay cases,
// where tryPatchChat bails and .chat-body gets detached-then-reattached
// within the same render) AFTER the reattach, once layout metrics are
// valid again. renderChat's own internal reconcileChatBody call happens
// mid-teardown while the node is still detached — scrollHeight/
// clientHeight both read 0 there, so its pin attempt is a no-op. This is
// the one that actually runs the gated pin (same touch/quiet checks as
// every other path) once the DOM is real again. Auto-triggered banners
// (compaction finishing, a reconnect notice) can land mid-scroll same as
// anything else, so this path needs the same protection or it reproduces
// the exact wedge the gating exists to prevent.
export function resyncChatScroll(c: ChatState): void {
  const view = chatViews.get(c);
  if (view) {
    pinIfDue(view);
  }
}

// Re-arm sticky-follow and immediately try to pin to the bottom.
// Called from queue.ts whenever the user sends a prompt — reading
// history and then firing one off should always bring you back down
// to see it land, the same way sending a message does in any other
// chat app, regardless of where stickToBottom's own scroll-driven
// tracking last left it. Still goes through the normal gated pin
// (touch/quiet checks), not a raw scrollTop write, so it can't collide
// with an in-progress touch the same way every other pin path avoids —
// in practice that only matters if send is somehow fired mid-drag,
// which the composer's tapHandler doesn't allow.
export function jumpToBottom(c: ChatState): void {
  const view = chatViews.get(c);
  if (!view) return;
  view.stickToBottom = true;
  pinIfDue(view);
}

// Live "Turn N of M" position readout, recomputed on every scroll event
// (see the .chat-body scroll listener in ensureChatView) so it tracks
// manual scrolling the same as it tracks scrollToTurn jumps — not a
// one-shot toast. Turn N is the last user-prompt bubble at or above the
// viewport's top edge; "Start" once scrolled above the first one
// entirely. Visibility itself isn't this function's job — it shares
// jump's own show/hide, which is already gated on scroll position.
export function updateTurnToast(chatBody: HTMLElement, toast: HTMLElement): void {
  const stops = Array.from(chatBody.querySelectorAll<HTMLElement>(".msg.user"));
  if (stops.length === 0) {
    toast.textContent = "";
    return;
  }
  const containerTop = chatBody.getBoundingClientRect().top;
  const EPSILON = 1;
  let idx = -1;
  for (let i = stops.length - 1; i >= 0; i--) {
    if (stops[i]!.getBoundingClientRect().top < containerTop + EPSILON) {
      idx = i;
      break;
    }
  }
  toast.textContent = idx === -1 ? "Start" : `Turn ${idx + 1} of ${stops.length}`;
}

// Cmd/Ctrl+PageUp/PageDown: jump by TURN instead of by screen — same
// idea as the TUI's Alt+PageUp/PageDown (screen.ts's scrollToPrevTurn/
// scrollToNextTurn), one stop per press, landing each prompt flush with
// the top of the viewport. Stops are exactly the user-prompt bubbles
// currently in the DOM (any status — sent, queued, cancelled, all
// count); past the oldest, land at the very top; past the newest, fall
// through to the live tail (jumpToBottom's .chat-body scroll listener
// re-arms stickToBottom on its own once the scroll settles there, same
// as any other scroll-to-bottom). A log with no prompts at all (a bare
// agent-initiated replay) has nothing to step between, so this falls
// back to a plain page.
export function scrollToTurn(direction: "prev" | "next"): void {
  const chatBody = document.querySelector<HTMLElement>(".chat-body");
  if (!chatBody) return;
  const stops = Array.from(chatBody.querySelectorAll<HTMLElement>(".msg.user"));
  if (stops.length === 0) {
    const delta = chatBody.clientHeight * 0.9;
    chatBody.scrollBy({ top: direction === "next" ? delta : -delta, behavior: "smooth" });
    return;
  }
  const view = state.current ? chatViews.get(state.current) : undefined;
  const containerTop = chatBody.getBoundingClientRect().top;
  const EPSILON = 1;
  let target: HTMLElement | null = null;
  let targetIdx = -1;
  if (direction === "prev") {
    for (let i = stops.length - 1; i >= 0; i--) {
      if (stops[i]!.getBoundingClientRect().top < containerTop - EPSILON) {
        target = stops[i]!;
        targetIdx = i;
        break;
      }
    }
    if (target) {
      target.scrollIntoView({ block: "start", behavior: "smooth" });
      // Smooth scrolling hasn't moved yet on this same tick, so
      // updateTurnToast would still read the OLD position — set the
      // known answer directly for instant feedback; the scroll listener
      // takes over (and stays in sync) once the animation is underway.
      if (view) view.turnToast.textContent = `Turn ${targetIdx + 1} of ${stops.length}`;
    } else {
      chatBody.scrollTo({ top: 0, behavior: "smooth" });
      if (view) view.turnToast.textContent = "Start";
    }
    return;
  }
  for (let i = 0; i < stops.length; i++) {
    if (stops[i]!.getBoundingClientRect().top > containerTop + EPSILON) {
      target = stops[i]!;
      targetIdx = i;
      break;
    }
  }
  if (target) {
    target.scrollIntoView({ block: "start", behavior: "smooth" });
    if (view) view.turnToast.textContent = `Turn ${targetIdx + 1} of ${stops.length}`;
  } else {
    // Landing at the live tail hides jump (and the toast with it) once
    // the scroll settles — nothing to set here.
    chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: "smooth" });
  }
}

function renderChat(c: ChatState): HTMLElement {
  // Pull fresh metadata from the session list each render so a
  // deep-link reload (where the SPA opened the chat before any poll
  // landed) gets the real title/cwd once polling completes.
  const live = state.sessions.find((s) => s.sessionId === c.sessionId);
  const title = live?.title || c.title || fallbackTitle(c.sessionId);
  const cwd = live?.cwd || c.cwd;
  const toggleDetails = (): void => {
    c.headerExpanded = !c.headerExpanded;
    render();
  };
  const header = el(
    "div",
    { class: "chat-header" },
    el(
      "div",
      { class: "chat-title-row" },
      // Split view has the list on screen already, so there is nowhere
      // to go "back" to — the arrow only ever moved keyboard focus, and
      // Ctrl-P / Escape already do that. Narrow mode still needs it as
      // real navigation.
      isWideLayout()
        ? null
        : el(
            "button",
            {
              class: "chat-back",
              title: "Back to session list",
              ...tapHandler(() => closeChat()),
            },
            "←",
          ),
      el(
        "div",
        {
          class: "chat-title clickable",
          title: "Click for session details",
          ...tapHandler(toggleDetails),
        },
        title,
      ),
    ),
    el(
      "div",
      { class: "chat-header-row" },
      !c.ready && c.cold
        ? el(
            "span",
            {
              class: "pill cold clickable",
              title: "Session closed cold — sending a prompt will resurrect it",
              ...tapHandler(toggleDetails),
            },
            "cold",
          )
        : !c.ready
        ? el(
            "span",
            {
              class: "pill clickable",
              title: "Click for session details",
              ...tapHandler(toggleDetails),
            },
            "connecting…",
          )
        : c.inTurn
        ? el(
            "span",
            {
              class: "pill working clickable",
              title: "Agent is working",
              ...tapHandler(toggleDetails),
            },
            el("span", { class: "dot" }, "●"),
            "thinking",
          )
        : c.armedTasks && c.armedTasks > 0
        ? el(
            "span",
            {
              class: "pill waiting clickable",
              title: c.armedSince
                ? `Agent has a background task running (armed ${Math.max(1, Math.floor((Date.now() - c.armedSince) / 60000))}m ago). It may resume on its own.`
                : "Agent has a background task running. It may resume on its own.",
              ...tapHandler(toggleDetails),
            },
            el("span", { class: "dot" }, "●"),
            "waiting",
          )
        : el(
            "span",
            {
              class: "pill ready clickable",
              title: "Ready for a prompt",
              ...tapHandler(toggleDetails),
            },
            el("span", { class: "dot" }, "●"),
            "ready",
          ),
      live?.workspace
        ? el(
            "span",
            {
              class: "pill clickable",
              title: `In workspace "${live.workspace.label}" (source: ${shortenCwd(live.workspace.sourceCwd)})`,
              ...tapHandler(toggleDetails),
            },
            "⎇ " + live.workspace.label,
          )
        : null,
      c.model
        ? el(
            "span",
            {
              class: "pill clickable",
              title: "Model (click to change)",
              ...tapHandler(openModelPicker),
            },
            c.model,
          )
        : null,
      c.contextUsed != null && c.contextSize
        ? el(
            "span",
            {
              class: c.compactionPhase ? "pill clickable compacting" : "pill clickable",
              title: c.compactionPhase
                ? c.compactionPhase === "deferred"
                  ? "Compaction queued — will run once the session is idle."
                  : "Compacting…"
                : `${c.contextUsed.toLocaleString()} / ${c.contextSize.toLocaleString()} context tokens — click to compact`,
              ...tapHandler(() => requestCompact(c)),
            },
            c.compactionPhase
              ? c.compactionPhase === "deferred"
                ? "⏳ queued"
                : "◐ compacting…"
              : `${fmtTokens(c.contextUsed)}/${fmtTokens(c.contextSize)}`,
          )
        : null,
      fmtCost(c.cost)
        ? el(
            "span",
            { class: "pill", title: "Session cost so far" },
            fmtCost(c.cost) as string,
          )
        : null,
      // The rail's own topbar carries a gear in split view, and two of
      // them a few hundred pixels apart opening the same modal is just
      // noise. Narrow mode never shows the topbar alongside a chat, so
      // this is the only one there.
      isWideLayout()
        ? null
        : el("button", { ...tapHandler(openOptionsModal), title: "Options" }, "⚙"),
      el("button", { ...tapHandler(openFiles), title: "Files" }, "📁"),
      el(
        "button",
        {
          title: "Export this session as a *.hydra bundle",
          ...tapHandler(() => triggerExportDownload(c.sessionId)),
        },
        "⬇",
      ),
      el("div", {
        class: "info clickable",
        title: "Click for session details",
        ...tapHandler(toggleDetails),
      }),
    ),
  );

  const details = c.headerExpanded
    ? el(
        "div",
        { class: "chat-details" },
        detailRow("title", title),
        detailRow("session", shortSessionId(c.sessionId)),
        detailRow("directory", cwd || "?"),
        priorityRow(c.sessionId, live?.priority),
        workspaceRow(live?.workspace),
        ...c.configOptions.map(configOptionRow),
      )
    : null;

  const view = ensureChatView(c);

  const autosize = (t: HTMLTextAreaElement): void => {
    t.style.height = "auto";
    t.style.height = t.scrollHeight + "px";
  };
  const setComposer = (t: HTMLTextAreaElement, text: string): void => {
    t.value = text;
    c.composerValue = text;
    queueDraftWrite(c.sessionId, text);
    autosize(t);
    t.setSelectionRange(text.length, text.length);
  };
  const composerOnKey = (e: KeyboardEvent): void => {
    if (e.isComposing) return;
    // Wide (split) layout: Escape hands focus back to the rail, landing
    // on this session's own card — the reverse of handleListKeydown's
    // Escape-from-the-rail branch, which sends focus back here. Keeps
    // Escape a consistent "leave whichever pane you're in" toggle.
    // stopPropagation is load-bearing: this handler runs first (it's on
    // the textarea itself) and moves focus to the rail synchronously,
    // but the same event then keeps bubbling to window's
    // handleListKeydown — which re-reads document.activeElement, now
    // sees the rail *already* focused, and immediately calls
    // focusComposer() right back, undoing this in the same keystroke.
    // Stand down when a modal is open (main.ts owns Escape then, to
    // close it) — an edge case, but without this guard the composer
    // would still have DOM focus underneath the modal overlay and
    // would swallow the Escape for itself first, before main.ts's
    // window-level handler ever sees it.
    if (e.key === "Escape" && isWideLayout() && !state.modal) {
      e.preventDefault();
      e.stopPropagation();
      focusListRail();
      return;
    }
    const t = e.target as HTMLTextAreaElement;
    // Up/Down history recall. Trigger only at the boundaries so caret
    // navigation inside multi-line drafts still works normally. Plain
    // arrow only — modifiers (shift/alt/ctrl/meta) fall through so the
    // browser handles selection extension, jump-to-end, etc.
    if (
      e.key === "ArrowUp" &&
      !e.shiftKey &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      t.selectionStart === 0 &&
      t.selectionEnd === 0 &&
      c.history.length > 0
    ) {
      const nextIdx =
        c.historyIndex === null
          ? 0
          : Math.min(c.history.length - 1, c.historyIndex + 1);
      if (c.historyIndex === null) {
        c.historyDraft = c.composerValue;
      }
      c.historyIndex = nextIdx;
      e.preventDefault();
      setComposer(t, c.history[nextIdx]!);
      return;
    }
    if (
      e.key === "ArrowDown" &&
      !e.shiftKey &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      t.selectionStart === t.value.length &&
      t.selectionEnd === t.value.length &&
      c.historyIndex !== null
    ) {
      e.preventDefault();
      if (c.historyIndex > 0) {
        c.historyIndex -= 1;
        setComposer(t, c.history[c.historyIndex]!);
      } else {
        const draft = c.historyDraft ?? "";
        c.historyIndex = null;
        c.historyDraft = null;
        setComposer(t, draft);
      }
      return;
    }
    if (e.key !== "Enter") return;
    // Shift+Enter — let the browser insert \n natively.
    if (e.shiftKey) return;
    // Alt/Ctrl/Cmd + Enter — manually insert \n at the caret because
    // browsers don't do that by default for those modifiers.
    if (e.altKey || e.ctrlKey || e.metaKey) {
      e.preventDefault();
      insertAtCaret(t, "\n");
      return;
    }
    e.preventDefault();
    sendPrompt();
  };
  const buildTextarea = (): HTMLTextAreaElement =>
    el(
    "textarea",
    {
      "data-focus-key": "composer",
      placeholder: c.ready
        ? "Message…"
        : c.cold
        ? "Message… (wakes the session)"
        : "Connecting…",
      rows: "1",
      // Mobile keyboards auto-capitalize the first letter of a
      // "sentence", which includes the start of the field — so
      // `/hydra ...` becomes `/Hydra ...` and silently fails to match
      // the (case-sensitive) command.
      autocapitalize: "off",
      onkeydown: composerOnKey,
      onpaste: (e: ClipboardEvent) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        const files: File[] = [];
        for (const it of items) {
          if (it.kind !== "file" || !it.type.startsWith("image/")) continue;
          const file = it.getAsFile();
          if (file) files.push(file);
        }
        // No image items — let the browser handle a normal text paste.
        if (files.length === 0) return;
        e.preventDefault();
        addPastedImages(c, files);
      },
      oninput: (e: Event) => {
        noteTypingActivity();
        const t = e.target as HTMLTextAreaElement;
        c.composerValue = t.value;
        queueDraftWrite(c.sessionId, t.value);
        // User typed — they're off the history rail. Drop the nav
        // cursor so the next Up starts a fresh walk and Down doesn't
        // surprise them by restoring an old draft.
        if (c.historyIndex !== null) {
          c.historyIndex = null;
          c.historyDraft = null;
        }
        autosize(t);
        // Dim/undim the send/enqueue/amend buttons directly rather than
        // going through a full render() — a full teardown on every
        // keystroke tanks typing responsiveness and resets the textarea
        // node out from under the browser's native spellcheck session.
        //
        // A class, NOT the disabled property. A disabled button swallows
        // a tap silently, so any moment this state lags reality — a tap
        // landing between keystroke and sync, a re-render carrying a
        // stale value, a layout shift as the mobile keyboard dismisses —
        // costs a press with no feedback, which is what made Send need
        // two or three taps. sendPrompt already no-ops on an empty
        // composer, so leaving it enabled is safe.
        const nowHasContent = t.value.trim().length > 0 || c.attachments.length > 0;
        const buttons =
          t.closest(".composer")?.querySelectorAll<HTMLButtonElement>(".content-gated") ?? [];
        for (const btn of buttons) {
          btn.classList.toggle("empty", !nowHasContent);
        }
      },
    },
    c.composerValue,
  ) as HTMLTextAreaElement;

  // Reuse the existing node rather than building a new one. A render
  // triggered by streaming would otherwise replace the textarea the user
  // is typing into, which destroys the browser's IME/autocorrect session
  // mid-word — dropped characters and useless suggestions while a turn is
  // in flight. The typing holdoff can't prevent this: after a rebuild,
  // focus is restored asynchronously, so document.activeElement briefly
  // isn't the textarea and isActivelyTyping() reports false, letting the
  // next rebuild through too.
  //
  // oninput keeps c.composerValue in step with the element, so the two
  // only diverge when something else changed it (a send clearing it,
  // history navigation, a restored draft) — which makes an unconditional
  // sync safe rather than something that would fight the user's typing.
  let textarea = view.composerTextarea;
  const isNewTextarea = !textarea;
  if (!textarea) {
    textarea = buildTextarea();
    view.composerTextarea = textarea;
  }
  textarea.placeholder = c.ready
    ? "Message…"
    : c.cold
    ? "Message… (wakes the session)"
    : "Connecting…";
  if (textarea.value !== c.composerValue) {
    textarea.value = c.composerValue;
    const ta = textarea;
    queueMicrotask(() => autosize(ta));
  } else if (isNewTextarea && c.composerValue.length > 0) {
    // First mount with a pre-filled value (a restored draft) — the node
    // was just built at its resting height and needs sizing once. This
    // used to run on every render whenever composerValue was non-empty,
    // not just on mount. autosize() collapses the box to height:auto and
    // back, which resets a scrolled textarea's internal scrollTop — so
    // during a streaming turn (a render every ~100ms) it kept snapping a
    // long composer's viewport back to the caret's line (usually the
    // end) even though nothing about the text had changed, fighting
    // anyone trying to scroll up and edit mid-prompt. Scoping this to
    // the one render where the node is new avoids that while still
    // sizing a restored draft correctly on open.
    const ta = textarea;
    queueMicrotask(() => autosize(ta));
  }
  // Desktop only, and only the chat's first render — see composerAutoFocused
  // in types.ts for why this can't just run on every renderChat call.
  // Deferred a tick: the textarea isn't attached to the document yet at
  // element-construction time, and focusing a detached node is a no-op.
  if (!c.composerAutoFocused && isDesktopPointer()) {
    c.composerAutoFocused = true;
    queueMicrotask(() => textarea.focus());
  }

  // While a turn is in flight, split the lone Send button into two:
  //   - Amend: cancel the in-flight head and submit the typed text as
  //     its replacement (only when the daemon advertises prompt.amending).
  //   - Enqueue: behave like the idle-case Send — sit in the FIFO until
  //     the agent finishes.
  // When idle, a single Send button covers both behaviors.
  // tapHandler acts on pointerup instead of click: on mobile Chrome the
  // "click" fired for a button in this composer can land a frame or
  // more after the physical tap release, by which point a WS-driven
  // render() may have already torn down and rebuilt this button's DOM
  // node, silently dropping the event (the tap highlight still flashes
  // regardless, so the button looks like it registered).
  const hasContent = c.composerValue.trim().length > 0 || c.attachments.length > 0;
  const sendButtons: Node[] = [];
  if (c.inTurn) {
    if (c.daemonSupportsAmend && c.currentHeadMessageId !== undefined) {
      sendButtons.push(
        el(
          "button",
          {
            class: `content-gated${hasContent ? "" : " empty"}`,
            ...tapHandler(amendPrompt),
            title: "Cancel the current turn and replace its prompt",
          },
          "Amend",
        ),
      );
    }
    sendButtons.push(
      el(
        "button",
        {
          class: `primary content-gated${hasContent ? "" : " empty"}`,
          ...tapHandler(sendPrompt),
          title: "Queue this prompt to run after the current turn",
        },
        "Enqueue",
      ),
    );
  } else {
    sendButtons.push(
      el(
        "button",
        { class: `primary content-gated${hasContent ? "" : " empty"}`, ...tapHandler(sendPrompt) },
        "Send",
      ),
    );
  }
  const composer = el(
    "div",
    { class: "composer" },
    renderAttachmentChips(c),
    textarea,
    el(
      "div",
      { class: "composer-buttons" },
      el(
        "button",
        {
          class: "stop",
          disabled:
            !c.inTurn && !c.promptQueue.some((e) => e.status === "queued" || e.status === "pending"),
          ...tapHandler(sendCancel),
          title: "Cancel current turn",
        },
        "Stop",
      ),
      ...sendButtons,
    ),
  );

  // Chrome subtrees rebuild wholesale into their display:contents slots
  // (small and cheap); the body reconciles in place so the scroll
  // container and unchanged bubbles survive the repaint. In the
  // teardown path the renderer still captures/restores scroll around
  // this; in the patch path (tryPatchChat) scroll is simply never
  // disturbed.
  view.headerSlot.replaceChildren(header);
  // Don't rebuild the details panel out from under an interacting user:
  // a focused <select> with its native picker open dies silently if its
  // node is replaced (the picker is anchored to the element), and
  // streaming/poll renders land often enough to hit that window nearly
  // every time. The panel refreshes on the next render after blur.
  const detailsActive =
    details !== null &&
    document.activeElement !== null &&
    view.detailsSlot.contains(document.activeElement);
  if (!detailsActive) {
    if (details) {
      view.detailsSlot.replaceChildren(details);
    } else {
      view.detailsSlot.replaceChildren();
    }
  }
  view.armedSlot.replaceChildren(renderArmedTasksBlock(c));
  view.composerSlot.replaceChildren(composer);
  reconcileChatBody(c, view);
  return view.root;
}

// render() rebuilds every visible bubble from scratch, which re-ran the
// markdown parser over every message's full text on every repaint — for a
// 200-item window during streaming that's the same few hundred KB of text
// re-parsed up to 10x a second, almost all of it for closed bubbles whose
// text can never change again. Keyed by the log item, validated by text:
// a streaming bubble whose text grew misses and re-parses (correct), an
// unchanged one hits.
const markdownHtmlCache = new WeakMap<object, { text: string; html: string }>();

function cachedMarkdown(key: object, text: string): string {
  const hit = markdownHtmlCache.get(key);
  if (hit && hit.text === text) {
    return hit.html;
  }
  const html = renderMarkdown(text);
  markdownHtmlCache.set(key, { text, html });
  return html;
}

function renderLogItem(item: ChatState["log"][number]): Node {
  if (item.kind === "stream") {
    const isThought = item.role === "thought";
    const cls =
      item.role === "user"
        ? "msg user"
        : isThought
        ? "msg system thought"
        : "msg agent";
    const isCollapsed = isThought && collapsedThoughts.has(item);
    // Survives a full-history reload (new LogItem objects, same wire
    // messageId) — see requestFullHistory's scroll-restore anchor below.
    const node = el("div", {
      class: isCollapsed ? cls + " collapsed" : cls,
      "data-message-id": item.messageId,
    });
    if (isThought) {
      node.addEventListener("click", () => {
        const collapsing = !collapsedThoughts.has(item);
        if (!collapsing) {
          collapsedThoughts.delete(item);
          render();
          return;
        }

        const chatBody = document.querySelector<HTMLElement>(".chat-body");
        const bodyRect = chatBody?.getBoundingClientRect();
        const bubbleRect = node.getBoundingClientRect();
        // bubbleAbsoluteTop: distance from scroll container's top edge to bubble top
        const bubbleAbsoluteTop = bubbleRect.top - (bodyRect?.top ?? 0) + (chatBody?.scrollTop ?? 0);
        const bubbleTopInView = !bodyRect ||
          (bubbleRect.top >= bodyRect.top && bubbleRect.top < bodyRect.bottom);
        // Keep bubble top at same visual position if it was visible; otherwise
        // scroll so the collapsed bubble appears at the top of the chat area.
        const desiredScrollTop = bubbleTopInView
          ? (chatBody?.scrollTop ?? 0)
          : bubbleAbsoluteTop;

        collapsedThoughts.add(item);
        render();
        // Override renderer's scroll after its rAF completes.
        requestAnimationFrame(() => {
          const newBody = document.querySelector<HTMLElement>(".chat-body");
          if (newBody) newBody.scrollTop = desiredScrollTop;
        });
      });
    }
    const qe = item.queueEntry;
    // Dim the M1 bubble of an amend pair so the eye lands on the M2.
    // The dim is purely visual — the bubble body and chip both stay
    // readable. We only mark "amended-target" once the cancellation
    // actually landed so an in-flight amend doesn't pre-emptively dim
    // the live response above it.
    if (qe && qe.amendedByMessageId !== undefined && qe.status === "amended") {
      node.classList.add("amended-target");
    }
    // Only show a chip while the prompt is still waiting locally
    // (queued / editing / offline) or ended in cancellation / amend.
    // Once it's sent ("processing" or "done"), the bubble looks like a
    // normal user message. The running turn's × lives on the spinner
    // instead so it works for sibling-originated prompts too.
    if (
      qe &&
      (qe.status === "queued" ||
        qe.status === "pending" ||
        qe.status === "cancelled" ||
        qe.status === "editing" ||
        qe.status === "amended" ||
        qe.status === "offline")
    ) {
      node.appendChild(renderQueueChip(qe));
    }
    // "+" badge on the M2 bubble. Tooltip nods at the M1's role so a
    // user new to the marker can hover to discover what it means.
    if (qe && qe.amendsMessageId !== undefined) {
      node.appendChild(
        el(
          "span",
          {
            class: "amend-badge",
            title: "Merged amend — replaces the previous, cancelled prompt",
          },
          "+",
        ),
      );
    }
    if (qe && qe.status === "editing") {
      // A user bubble is a shrink-to-fit flex item sized by its text, so
      // swapping that text for a textarea collapses it to the textarea's
      // intrinsic width (~20 cols) — width:100% on the textarea can't
      // recover it, since the parent it's 100% OF has already collapsed.
      // This pins the bubble at its normal max width while editing.
      node.classList.add("bubble-editing");
      // Inline editor over the queued bubble. Pre-fills with the
      // current text; Enter commits via hydra-acp/prompt/update,
      // Escape reverts. Disabled (and the entry returns to queued)
      // once the prompt actually starts processing.
      node.appendChild(
        renderQueueEditor(qe, (next) => {
          item.text = next;
        }),
      );
    } else {
      if (item.attachments && item.attachments.length > 0) {
        node.appendChild(
          el(
            "div",
            { class: "attachment-thumbs" },
            ...item.attachments.map((a) =>
              el("img", { class: "attachment-thumb", src: dataUri(a) }),
            ),
          ),
        );
      }
      const body = el("div", { class: item.synthetic ? "body raw" : "body" });
      if (item.synthetic) {
        body.textContent = item.text;
      } else {
        body.innerHTML = cachedMarkdown(item, item.text);
      }
      if (qe && qe.status === "cancelled") {
        body.style.textDecoration = "line-through";
        body.style.opacity = "0.6";
      }
      // Amended bubbles dim via the .amended-target class on the
      // wrapper — we deliberately don't strike them through. The
      // user's intent carried forward into the M2; the M1 was just a
      // draft that got superseded, not an abandoned thought.
      node.appendChild(body);
    }
    return node;
  }
  if (item.kind === "system") {
    return el("div", { class: "msg system" }, item.text);
  }
  if (item.kind === "error") {
    return el("div", { class: "msg error" }, item.text);
  }
  if (item.kind === "spinner") {
    return renderSpinner(item.spinner);
  }
  if (item.kind === "turn-stamp") {
    return renderTurnStamp(item);
  }
  if (item.kind === "perm") {
    if (!state.current) return document.createTextNode("");
    const entry = state.current.pendingPermissions.get(item.toolCallId);
    if (!entry) return document.createTextNode("");
    return renderPermission(entry);
  }
  if (item.kind === "plan") {
    return renderPlan(item.entries);
  }
  if (item.kind === "exit-plan-mode") {
    return renderExitPlan(item);
  }
  if (item.kind === "edit-diff") {
    return renderEditDiff(item);
  }
  return document.createTextNode("");
}

function diffLineClass(op: DiffDisplayLine["op"]): string {
  if (op === "+") return "diff-line hljs-addition";
  if (op === "-") return "diff-line hljs-deletion";
  if (op === "gap") return "diff-line diff-gap";
  return "diff-line";
}

// "+ "/"- " markers so added/removed/context lines stay distinguishable by
// more than background color alone.
function diffLinePrefix(op: DiffDisplayLine["op"]): string {
  if (op === "+") return "+ ";
  if (op === "-") return "- ";
  if (op === "gap") return "";
  return "  ";
}

// The LCS diff behind countDiffChanges/buildDiffDisplayLines is quadratic,
// and render() rebuilds every visible log item from scratch — without this
// cache every repaint (up to 10/s while streaming) re-diffed every visible
// edit card, collapsed or not, which was a main-thread hog on sessions with
// big edits. Keyed by the EditDiff object itself: acp.ts replaces item.diff
// wholesale when a tool_call_update revises it, so object identity is a
// correct (and free) invalidation signal.
const diffComputeCache = new WeakMap<
  EditDiff,
  { counts: { added: number; removed: number }; lines?: DiffDisplayLine[] }
>();

function diffCacheFor(diff: EditDiff): {
  counts: { added: number; removed: number };
  lines?: DiffDisplayLine[];
} {
  let hit = diffComputeCache.get(diff);
  if (!hit) {
    hit = { counts: countDiffChanges(diff) };
    diffComputeCache.set(diff, hit);
  }
  return hit;
}

function renderEditDiff(item: EditDiffLogItem): HTMLElement {
  const cached = diffCacheFor(item.diff);
  const counts = cached.counts;
  const shownPath = item.diff.path ? shortenCwd(item.diff.path) : "file";
  const summary: HTMLElement[] = [];
  if (counts.added > 0) {
    summary.push(el("span", { class: "add" }, `+${counts.added}`));
  }
  if (counts.removed > 0) {
    summary.push(el("span", { class: "del" }, `-${counts.removed}`));
  }
  const head = el(
    "div",
    {
      class: "head",
      ...tapHandler(() => {
        item.expanded = !item.expanded;
        render();
      }),
    },
    el("span", null, item.expanded ? "▾" : "▸"),
    el("span", { class: "title" }, `Edited ${shownPath}`),
    summary.length > 0 ? el("span", { class: "kind edit-summary" }, summary) : null,
  );
  const node = el(
    "div",
    { class: item.expanded ? "toolcard open" : "toolcard" },
    head,
  );
  if (item.expanded) {
    const lines = cached.lines ?? (cached.lines = buildDiffDisplayLines(item.diff));
    node.appendChild(
      el(
        "div",
        { class: "body" },
        el(
          "pre",
          null,
          el(
            "code",
            { class: "diff-body" },
            lines.map((l) =>
              el("div", { class: diffLineClass(l.op) }, diffLinePrefix(l.op) + l.text),
            ),
          ),
        ),
      ),
    );
  }
  return node;
}

function renderExitPlan(item: {
  toolCallId: string;
  plan: string;
  status?: string;
}): HTMLElement {
  const node = el("div", { class: "msg agent plan-markdown" });
  node.appendChild(el("div", { class: "plan-header" }, "📋 Plan"));
  const body = el("div", { class: "body" });
  body.innerHTML = cachedMarkdown(item, item.plan);
  node.appendChild(body);
  const footer = exitPlanFooter(item.status);
  if (footer !== null) node.appendChild(footer);
  return node;
}

function exitPlanFooter(status: string | undefined): HTMLElement | null {
  if (status === undefined) return null;
  switch (status) {
    case "completed":
    case "succeeded":
    case "ok":
      return el("div", { class: "plan-status plan-status-ok" }, "✓ Approved");
    case "failed":
    case "error":
    case "rejected":
      return el(
        "div",
        { class: "plan-status plan-status-fail" },
        "✗ Rejected",
      );
    case "cancelled":
      return el(
        "div",
        { class: "plan-status plan-status-cancelled" },
        "⊝ Cancelled",
      );
    case "pending":
    case "in_progress":
    case "running":
    case "updated":
      return el(
        "div",
        { class: "plan-status plan-status-pending" },
        "awaiting approval…",
      );
    default:
      return null;
  }
}

function renderQueueChip(entry: QueueEntry): Node {
  if (entry.status === "queued" || entry.status === "pending") {
    // "pending" means sent but not yet acknowledged (no queue position
    // exists yet) — say that, rather than the old Math.max(1, ...)
    // floor that dressed it up as "queued · 1 ahead". Besides being
    // wrong on its face for a prompt about to run immediately, the
    // floor masked a real bug: an entry stuck unbound forever (the
    // bind stolen by a stale straggler, see onPromptQueueAdded) showed
    // a plausible queue position instead of a visibly-stuck "sending…".
    const label =
      entry.status === "pending"
        ? "sending…"
        : `queued · ${Math.max(1, entry.aheadAtEnqueue)} ahead` +
          (entry.held ? " · held: agent resumed" : "");
    // "Changed my mind — send it NOW as an amendment to the running
    // turn" escape hatch for an accidental enqueue. Same gates as the
    // composer's Amend button, plus a bound messageId (the server-side
    // slot has to exist before it can be traded for a steer).
    const canAmendNow =
      entry.status === "queued" &&
      entry.messageId !== undefined &&
      state.current !== null &&
      state.current.daemonSupportsAmend &&
      state.current.currentHeadMessageId !== undefined &&
      state.current.inTurn;
    return el(
      "div",
      { class: "queue-chip queue-queued" },
      el("span", null, label),
      canAmendNow
        ? el(
            "button",
            {
              class: "queue-edit",
              ...tapHandler(() => amendQueuedPrompt(entry)),
              // "+" matches the amend badge the bubble gains once
              // promoted (.amend-badge), so the button previews its
              // own effect.
              title: "Send now — amends the running turn instead of waiting",
            },
            el("span", { class: "queue-btn-glyph" }, "+"),
          )
        : null,
      el(
        "button",
        {
          class: "queue-edit",
          ...tapHandler(() => {
            entry.status = "editing";
            render();
          }),
          title: "Edit before sending",
        },
        el("span", { class: "queue-btn-glyph" }, "✎"),
      ),
      el(
        "button",
        {
          class: "queue-cancel",
          ...tapHandler(() => cancelQueuedPrompt(entry)),
          title: "Cancel before sending",
        },
        el("span", { class: "queue-btn-glyph" }, "×"),
      ),
    );
  }
  if (entry.status === "editing") {
    return el(
      "div",
      { class: "queue-chip queue-editing" },
      el("span", null, "editing — Save or Cancel below"),
    );
  }
  if (entry.status === "processing") {
    return el(
      "div",
      { class: "queue-chip queue-processing" },
      el("span", { class: "dot" }),
      el("span", null, "processing"),
    );
  }
  if (entry.status === "cancelled") {
    return el(
      "div",
      { class: "queue-chip queue-cancelled" },
      el("span", null, "cancelled"),
    );
  }
  if (entry.status === "amended") {
    return el(
      "div",
      { class: "queue-chip queue-amended" },
      el("span", null, "amended — merged into the next prompt"),
    );
  }
  if (entry.status === "offline") {
    return el(
      "div",
      { class: "queue-chip queue-offline" },
      el("span", null, "pending"),
      el(
        "button",
        {
          class: "queue-edit",
          ...tapHandler(() => {
            // Must be set before flipping to "editing", which clobbers
            // the status the editor needs to restore afterwards.
            entry.editReturnStatus = "offline";
            entry.status = "editing";
            render();
          }),
          title: "Edit before sending",
        },
        el("span", { class: "queue-btn-glyph" }, "✎"),
      ),
      el(
        "button",
        {
          class: "queue-cancel",
          ...tapHandler(() => cancelQueuedPrompt(entry)),
          title: "Discard, this was never sent",
        },
        el("span", { class: "queue-btn-glyph" }, "×"),
      ),
    );
  }
  return document.createTextNode("");
}

// Inline edit-while-queued textarea. Enter (without shift) commits via
// hydra-acp/prompt/update and reverts the chip to "queued"; Escape
// reverts without sending. Save/Cancel buttons do the same two things
// by tap — a phone keyboard has no Escape key, and relying on it as
// the only way to back out of an edit left mobile with no way to
// cancel at all. The commit may be rejected by hydra if the prompt has
// already started — the chip status will get overwritten shortly after
// by the daemon's broadcasts in either case.
//
// onCommit lets the caller patch the surrounding LogItem's text so the
// bubble reflects the edit optimistically (the same value lands again
// when the daemon's prompt_queue_updated echo arrives, but applying it
// here avoids a visible round-trip flicker).
function renderQueueEditor(
  entry: QueueEntry,
  onCommit: (next: string) => void,
): HTMLElement {
  const textarea = el("textarea", {
    class: "queue-edit-area",
    // rows=1 is a floor, not the intended size — autosize below grows it
    // to fit. A fixed rows=3 made editing a long queued prompt happen
    // through a 3-line porthole, much smaller than the bubble it
    // replaced, with the surrounding text scrolled out of sight.
    rows: "1",
    autocapitalize: "off",
  }) as HTMLTextAreaElement;
  textarea.value = entry.text;
  // Same trick the composer uses: collapse, then adopt scrollHeight.
  const autosize = (): void => {
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  };
  textarea.addEventListener("input", autosize);
  // Restore whatever the entry was before editing, not a hardcoded
  // "queued": an offline (held, never sent) entry promoted to "queued"
  // here would stop matching flushOfflineQueue and never get sent.
  const restoreStatus = (): void => {
    entry.status = entry.editReturnStatus ?? "queued";
    entry.editReturnStatus = undefined;
  };
  const commit = (): void => {
    const next = textarea.value;
    entry.text = next;
    onCommit(next);
    restoreStatus();
    updateQueuedPrompt(entry, next);
    render();
  };
  const cancel = (): void => {
    restoreStatus();
    render();
  };
  textarea.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      commit();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      cancel();
    }
  });
  // Autofocus + place caret at end. Done in a microtask so the
  // textarea is in the DOM by the time we touch it.
  queueMicrotask(() => {
    // Must run once attached — scrollHeight reads 0 while detached, so
    // sizing here rather than at construction is load-bearing.
    autosize();
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  });
  return el(
    "div",
    { class: "queue-editor" },
    textarea,
    el(
      "div",
      { class: "queue-editor-actions" },
      el("button", { class: "ghost", ...tapHandler(cancel) }, "Cancel"),
      el("button", { class: "primary", ...tapHandler(commit) }, "Save"),
    ),
  );
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// The frozen remains of a turn's spinner (see acp.ts finalizeTurn) —
// a dim, permanent marker under the prompt recording how long the turn
// took, TUI-style. A non-natural end ("cancelled", "refusal", …) stamps
// loudly instead so an interrupted turn can't be misread as a finished
// one.
function renderTurnStamp(item: {
  elapsedMs: number;
  toolCount: number;
  stopReason?: string;
}): HTMLElement {
  const bad = item.stopReason !== undefined && item.stopReason !== "end_turn";
  const label = bad
    ? `stopped (${item.stopReason}) · ${formatElapsed(item.elapsedMs)}`
    : item.toolCount > 0
    ? `${item.toolCount} tool${item.toolCount === 1 ? "" : "s"} · took ${formatElapsed(item.elapsedMs)}`
    : `thought · ${formatElapsed(item.elapsedMs)}`;
  return el("div", { class: bad ? "turn-stamp bad" : "turn-stamp" }, label);
}

function renderSpinner(spinner: SpinnerState): HTMLElement {
  const cancelBtn = el(
    "button",
    {
      class: "queue-cancel",
      ...tapHandler(() => cancelProcessingPrompt()),
      title: "Cancel this turn",
    },
    el("span", { class: "queue-btn-glyph" }, "×"),
  );
  const elapsed = formatElapsed(Date.now() - spinner.startedAt);
  if (!spinner.expanded) {
    return el(
      "div",
      {
        class: "spinner",
        ...tapHandler(() => {
          spinner.expanded = true;
          render();
        }),
      },
      el(
        "div",
        { class: "head" },
        el("span", { class: "dot" }),
        el(
          "span",
          null,
          spinner.sending
            ? "sending…"
            : spinner.toolCallIds.length === 0
            ? `thinking · ${elapsed}`
            : `working — ${spinner.toolCallIds.length} tool call${
                spinner.toolCallIds.length === 1 ? "" : "s"
              } · ${elapsed}`,
        ),
        cancelBtn,
      ),
    );
  }
  const items = spinner.toolCallIds.map((id) => {
    const tc = state.current?.toolCalls.get(id);
    if (!tc) return null;
    const icon =
      tc.status === "completed" || tc.status === "success"
        ? "✅"
        : tc.status === "failed" || tc.status === "error"
        ? "❌"
        : "▶";
    return el(
      "li",
      null,
      el("span", { class: "icon" }, icon),
      document.createTextNode(" " + tc.title),
    );
  });
  return el(
    "div",
    {
      class: "spinner expanded",
      ...tapHandler(() => {
        spinner.expanded = false;
        render();
      }),
    },
    el(
      "div",
      { class: "head" },
      el("span", { class: "dot" }),
      el("span", null, spinner.sending ? "sending…" : `working · ${elapsed}`),
      cancelBtn,
    ),
    el("ul", null, items),
  );
}

// Best-effort extraction of what a tool call wants to touch, so the
// permission card shows the path / command / url instead of leaning on a
// terse title like "external_directory". Agents populate these fields
// inconsistently; an empty array means "nothing beyond the title".
function permissionDetailRows(tc: Record<string, unknown>): HTMLElement[] {
  const asStr = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;
  const rows: HTMLElement[] = [];
  const row = (label: string, value: string): HTMLElement =>
    el(
      "div",
      { class: "detail" },
      el("span", { class: "k" }, label),
      el("code", null, value),
    );

  const kind = asStr(tc.kind);
  if (kind) {
    rows.push(row("kind", kind));
  }

  const seen = new Set<string>();
  const paths: string[] = [];
  const addPath = (v: unknown): void => {
    const s = asStr(v);
    if (s && !seen.has(s)) {
      seen.add(s);
      paths.push(s);
    }
  };
  const locations = tc.locations;
  if (Array.isArray(locations)) {
    for (const loc of locations) {
      if (loc && typeof loc === "object") {
        addPath((loc as Record<string, unknown>).path);
      }
    }
  }
  const rawInput =
    tc.rawInput && typeof tc.rawInput === "object"
      ? (tc.rawInput as Record<string, unknown>)
      : undefined;
  if (rawInput) {
    addPath(rawInput.file_path);
    addPath(rawInput.filePath);
    addPath(rawInput.path);
  }
  for (const p of paths) {
    rows.push(row("path", p));
  }

  if (rawInput) {
    const command = asStr(rawInput.command);
    if (command) {
      rows.push(row("command", command));
    }
    const url = asStr(rawInput.url);
    if (url) {
      rows.push(row("url", url));
    }
    const description = asStr(rawInput.description);
    if (description) {
      rows.push(el("div", { class: "detail note" }, description));
    }
  }

  return rows;
}

function renderPermission(entry: PermissionEntry): HTMLElement {
  const tc = entry.toolCall || {};
  return el(
    "div",
    { class: "perm" },
    el("div", { class: "title" }, "🔒 Permission requested"),
    el("div", { class: "desc" }, tc.title || tc.name || "tool call"),
    permissionDetailRows(tc as Record<string, unknown>),
    el(
      "div",
      { class: "opts" },
      ...entry.options.map((o) =>
        el(
          "button",
          {
            class: o.kind?.startsWith("allow")
              ? "primary"
              : o.kind?.startsWith("reject")
              ? "danger"
              : "",
            ...tapHandler(() => respondPermission(entry.toolCallId, o.optionId)),
          },
          o.name || o.optionId,
        ),
      ),
      el(
        "button",
        { ...tapHandler(() => respondPermission(entry.toolCallId, "__cancel__")) },
        "Cancel",
      ),
    ),
  );
}

function renderPlan(plan: unknown): Node {
  if (!Array.isArray(plan)) return document.createTextNode("");
  return el(
    "div",
    { class: "msg agent" },
    el("div", { class: "body" }, el("strong", null, "Plan")),
    el(
      "ul",
      null,
      ...(plan as Array<Record<string, unknown>>).map((p) =>
        el(
          "li",
          null,
          `${
            p.status === "completed"
              ? "✓"
              : p.status === "in_progress"
              ? "▸"
              : "·"
          } ${(p.content as string) || (p.title as string) || ""}`,
        ),
      ),
    ),
  );
}

// ---- File overlay -----------------------------------------------

function openFiles(): void {
  if (!state.current) return;
  state.current.fileOverlay = { path: "", entries: [], preview: null, err: null };
  render();
  void listFiles("");
}

async function listFiles(p: string): Promise<void> {
  if (!state.current) return;
  try {
    const data = await api<{ path: string; entries?: FileEntry[] }>(
      "/api/files/list",
      {
        method: "POST",
        body: JSON.stringify({ sessionId: state.current.sessionId, path: p }),
      },
    );
    state.current.fileOverlay = {
      path: data.path,
      entries: data.entries ?? [],
      preview: null,
      err: null,
    };
    render();
  } catch (err) {
    state.current.fileOverlay = {
      path: p,
      entries: [],
      preview: null,
      err: (err as Error).message,
    };
    render();
  }
}

async function readFile(p: string): Promise<void> {
  if (!state.current) return;
  try {
    const data = await api<{ content: string }>("/api/files/read", {
      method: "POST",
      body: JSON.stringify({ sessionId: state.current.sessionId, path: p }),
    });
    const fo = state.current.fileOverlay!;
    state.current.fileOverlay = {
      path: fo.path,
      entries: fo.entries,
      preview: { path: p, content: data.content },
      err: null,
    };
    render();
  } catch (err) {
    if (state.current.fileOverlay) {
      state.current.fileOverlay = {
        ...state.current.fileOverlay,
        err: (err as Error).message,
      };
    }
    render();
  }
}

function closeFiles(): void {
  if (!state.current) return;
  state.current.fileOverlay = null;
  render();
}

function navigateFile(entry: FileEntry): void {
  if (!state.current?.fileOverlay) return;
  const fo = state.current.fileOverlay;
  const childPath = fo.path ? `${fo.path}/${entry.name}` : entry.name;
  if (entry.kind === "dir") {
    void listFiles(childPath);
  } else if (entry.kind === "file") {
    void readFile(childPath);
  }
}

function fileBreadcrumb(path: string): HTMLElement {
  const parts = path ? path.split("/").filter(Boolean) : [];
  const crumbs: Node[] = [
    el("span", { class: "crumb", ...tapHandler(() => listFiles("")) }, "."),
  ];
  let acc = "";
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    const target = acc;
    crumbs.push(document.createTextNode(" / "));
    crumbs.push(el("span", { class: "crumb", ...tapHandler(() => listFiles(target)) }, p));
  }
  return el("div", { class: "crumbs" }, crumbs);
}

function addLineRef(path: string, line: number): void {
  if (!state.current) return;
  const ref = `${path}:${line}`;
  const cur = state.current.composerValue;
  state.current.composerValue = cur ? `${cur} ${ref}` : ref;
  queueDraftWrite(state.current.sessionId, state.current.composerValue);
  render();
}

function closeFilePreview(): void {
  if (!state.current?.fileOverlay) return;
  state.current.fileOverlay.preview = null;
  render();
}

function renderFileOverlay(c: ChatState): Node {
  const fo = c.fileOverlay;
  if (!fo) return document.createTextNode("");
  let body: HTMLElement;
  if (fo.preview) {
    const { path, content } = fo.preview;
    const highlighted = highlightCode(content, path) ?? escapeHtml(content);
    const lineCount = content.split("\n").length;
    const gutter = el("div", { class: "code-gutter" });
    for (let i = 1; i <= lineCount; i++) {
      const ln = i;
      gutter.appendChild(
        el("div", { class: "ln", ...tapHandler(() => addLineRef(path, ln)) }, String(ln)),
      );
    }
    body = el(
      "div",
      { class: "preview" },
      el(
        "div",
        { class: "crumbs" },
        el("span", { class: "crumb", ...tapHandler(() => closeFilePreview()) }, "← back to listing"),
        document.createTextNode(`  ${path}`),
      ),
      el(
        "div",
        { class: "code-view" },
        gutter,
        el("pre", {}, el("code", { class: "hljs", html: highlighted })),
      ),
    );
  } else {
    body = el(
        "div",
        { class: "body" },
        fo.err ? el("div", { class: "msg error" }, fo.err) : null,
        fo.path
          ? el(
              "div",
              {
                class: "entry",
                ...tapHandler(() => listFiles(fo.path.split("/").slice(0, -1).join("/"))),
              },
              el("span", { class: "icon" }, "▸"),
              el("span", { class: "name" }, ".."),
              el("span", { class: "size" }, ""),
            )
          : null,
        ...fo.entries.map((e) =>
          el(
            "div",
            { class: "entry", ...tapHandler(() => navigateFile(e)) },
            el("span", { class: "icon" }, e.kind === "dir" ? "▸" : "·"),
            el("span", { class: "name" }, e.name),
            el("span", { class: "size" }, e.kind === "file" ? `${e.size}b` : ""),
          ),
        ),
      );
  }
  return el(
    "div",
    {
      class: "modal-bg",
      ...tapHandler((ev) => {
        if ((ev.target as HTMLElement).classList.contains("modal-bg")) closeFiles();
      }),
    },
    el(
      "div",
      {
        class: "modal file-modal",
      },
      el(
        "div",
        { class: "topbar", style: "border-bottom:1px solid var(--border)" },
        el("span", { class: "title" }, "Files"),
        el("span", { class: "pill" }, c.cwd),
        el("span", { class: "spacer" }),
        el("button", { ...tapHandler(closeFiles) }, "×"),
      ),
      fileBreadcrumb(fo.path),
      el(
        "div",
        {
          class: "files",
        },
        body,
      ),
    ),
  );
}

// ---- Composer helpers --------------------------------------------

// Insert text at the current caret in a textarea, replacing any
// selection. Dispatches an `input` event so the existing oninput
// handler updates state.composerValue and the auto-grow recalculates.
// Tries execCommand first so the browser's undo stack stays intact;
// falls back to direct mutation if execCommand is unavailable.
function insertAtCaret(textarea: HTMLTextAreaElement, text: string): void {
  textarea.focus();
  let inserted = false;
  if (typeof document.execCommand === "function") {
    try {
      inserted = document.execCommand("insertText", false, text);
    } catch {
      inserted = false;
    }
  }
  if (!inserted) {
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    textarea.value = before + text + after;
    const caret = start + text.length;
    textarea.setSelectionRange(caret, caret);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }
}
