// All render functions and the top-level renderApp(root, state)
// composer. Imports are kept at the top for readability; this is the
// largest module by design — keeping all the DOM-shaping code together
// makes UX iteration easier than chasing pieces across files.

import { state, setState } from "./state.js";
import { render } from "./renderer.js";
import { el, tapHandler, isFormControl, TAP_MOVE_THRESHOLD } from "./dom.js";
import { renderMarkdown, escapeHtml } from "./markdown.js";
import { highlightCode } from "./hljs.js";
import {
  api,
  importBundle,
  pollSessions,
  tryImportBundleWith409,
} from "./api.js";
import { respondPermission } from "./bridge.js";
import {
  amendPrompt,
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
import { requestNotificationPermission } from "./notifications.js";
import { buildDiffDisplayLines, countDiffChanges } from "./edit-diff.js";
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
  if (s.view === "list") {
    root.appendChild(renderTopbar());
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
    }
  }
}

// ---- Topbar ------------------------------------------------------

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

// Build the host-filter dropdown. Options are computed live from the
// current session list so newly-imported peer hosts appear without
// page reload. Sentinels:
//   "__local" — sessions created here OR imported and bound to a local
//               agent.
//   "__all"   — every session.
//   <host>    — passive mirrors imported from <host> that haven't been
//               attached locally yet.
// A peer host with no passive mirrors (all its sessions have been
// attached locally) drops out of the option list — its filter would
// render empty.
function renderHostFilter(): HTMLElement {
  const hostsSeen = new Set<string>();
  for (const s of state.sessions) {
    if (s.importedFromMachine && !s.upstreamSessionId) {
      hostsSeen.add(s.importedFromMachine);
    }
  }
  const hosts = [...hostsSeen].sort();
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
  for (const h of hosts) {
    addOption(h, h);
  }
  addOption("__all", "all");
  // If the current filter points at a host that no longer appears in
  // any session, the select would render with nothing selected. Pin
  // the rendered value to the state explicitly so this stays sane.
  if (
    state.hostFilter !== "__local" &&
    state.hostFilter !== "__all" &&
    !hosts.includes(state.hostFilter)
  ) {
    select.value = state.hostFilter;
  }
  return select;
}

// ---- Session list -----------------------------------------------

function renderList(): HTMLElement {
  // Daemon always returns everything now; the "show cold" toggle and
  // the host filter are client-side passes — apply them in order.
  let visible = state.showCold
    ? state.sessions
    : state.sessions.filter((s) => s.status !== "cold");
  if (state.hostFilter === "__local") {
    visible = visible.filter(
      (s) => !s.importedFromMachine || !!s.upstreamSessionId,
    );
  } else if (state.hostFilter !== "__all") {
    visible = visible.filter(
      (s) =>
        s.importedFromMachine === state.hostFilter && !s.upstreamSessionId,
    );
  }
  // Count cold-filtered sessions separately so the empty-state message
  // for the "warm" toggle isn't muddied by host-filter hits.
  const hiddenCold = state.showCold
    ? 0
    : state.sessions.filter((s) => s.status === "cold").length;
  const groups = groupSessions(visible, state.groupBy);
  const list = el("div", { class: "list" });
  if (visible.length === 0) {
    let msg: string;
    if (state.sessions.length === 0) {
      msg = "No sessions. Use + to create one, or run `hydra-acp launch <agent>` from your editor.";
    } else if (state.hostFilter === "__local") {
      msg = "No local sessions. Switch the host filter to see imported sessions.";
    } else if (state.hostFilter !== "__all") {
      msg = `No sessions from ${state.hostFilter}. Try a different host.`;
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

// Same tiering as the TUI picker's sortSessions (picker.ts), minus the
// priority-pin tiers the browser has no equivalent for: a mid-turn agent
// blocked on a question (busy + awaiting-input) is the most urgent row
// there is, plain busy comes next, then a stale awaiting-input flag on a
// turn that's already over (often just an uncleared flag rather than an
// agent actually standing by), then idle-warm, then cold. Tiebreak is
// updatedAt at minute precision so per-chunk mtime churn doesn't
// reshuffle the list between polls.
function compareSessions(a: SessionInfo, b: SessionInfo): number {
  const tier = (s: SessionInfo): number => {
    const isWarm = s.status === "warm";
    if (isWarm && s.busy && s.awaitingInput) return 4;
    if (isWarm && s.busy) return 3;
    if (isWarm && s.awaitingInput) return 2;
    if (isWarm) return 1;
    return 0;
  };
  const dt = tier(b) - tier(a);
  if (dt !== 0) {
    return dt;
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
// bubbles render at all. Lives in the expanded chat-details panel next
// to the config-option dropdowns since it's the same "session settings"
// area, even though the preference itself isn't per-session.
function hideThoughtsRow(): HTMLElement {
  return el(
    "div",
    { class: "detail" },
    el("span", { class: "k" }, "thoughts"),
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
      "hide",
    ),
  );
}

// Global toggle for a system notification when a turn THIS tab
// submitted finishes while the tab isn't visible/focused. Turning it on
// requests Notification permission (and registers the notification
// service worker) right away rather than waiting for the first turn to
// finish, so a denial surfaces immediately instead of silently.
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
          });
        },
      }),
      "on turn end",
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

function groupSessions(sessions: SessionInfo[], mode: "project" | "recent"): SessionGroup[] {
  if (mode === "recent") {
    const sorted = sessions.slice().sort(compareSessions);
    return [{ label: null, sessions: sorted }];
  }
  const map = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const key = s.cwd || "(unknown)";
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(s);
  }
  const out: SessionGroup[] = [];
  for (const [cwd, items] of [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    items.sort(compareSessions);
    out.push({ label: shortenCwd(cwd), sessions: items });
  }
  return out;
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
      class: "card",
      ...tapHandler((e) => {
        const target = e.target as HTMLElement;
        if (target.closest("button")) return;
        openChat(s.sessionId, s.status === "cold");
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
      ),
      el(
        "div",
        { class: "actions" },
        el(
          "button",
          {
            class: "ghost",
            title: "Export session as *.hydra bundle",
            ...tapHandler(() => triggerExportDownload(s.sessionId)),
          },
          "↓",
        ),
        el(
          "button",
          {
            class: "danger",
            ...tapHandler(() => void killSession(s)),
          },
          "×",
        ),
      ),
    ),
    showCwd
      ? el("div", { class: "row3" }, s.cwd ? shortenCwd(s.cwd) : "?")
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

function loadLastCwd(): string | null {
  try {
    return localStorage.getItem(LAST_CWD_KEY);
  } catch {
    return null;
  }
}

function saveLastCwd(cwd: string): void {
  try {
    localStorage.setItem(LAST_CWD_KEY, cwd);
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
      el(
        "div",
        { class: "field" },
        el("label", { for: "f-cwd" }, "cwd"),
        el("input", {
          id: "f-cwd",
          "data-focus-key": "session-modal-cwd",
          value: m.cwd,
          placeholder: "/home/you/dev/project",
          oninput: (e: Event) => {
            m.cwd = (e.target as HTMLInputElement).value;
          },
        }),
      ),
      el(
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
        el("button", { ...tapHandler(closeModal), disabled: m.busy }, "Cancel"),
        el(
          "button",
          { class: "primary", ...tapHandler(createSession), disabled: m.busy },
          m.busy ? "Creating…" : "Create",
        ),
      ),
    ),
  );
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
  if (!m.cwd) {
    m.err = "cwd is required";
    render();
    return;
  }
  m.busy = true;
  m.err = null;
  render();
  try {
    const body: Record<string, unknown> = { cwd: m.cwd };
    if (m.agentId) body.agentId = m.agentId;
    if (m.name) body.name = m.name;
    if (m.prompt) body.prompt = m.prompt;
    const data = await api<{ sessionId?: string }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify(body),
    });
    saveLastCwd(m.cwd);
    closeModal();
    void pollSessions();
    if (data && data.sessionId) {
      openChat(data.sessionId, false);
    }
  } catch (err) {
    m.err = (err as Error).message;
    m.busy = false;
    render();
  }
}

function closeModal(): void {
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
  jump: HTMLButtonElement;
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
}

const PIN_HOLDOFF_MS = 450;
const SCROLL_QUIET_MS = 250;

// Pin to the bottom only when following, no finger is down, the scroller
// has been quiet long enough to be truly settled, and the position would
// actually change — a same-position assignment still disturbs iOS
// gesture state.
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

function ensureChatView(c: ChatState): ChatView {
  let view = chatViews.get(c);
  if (view) {
    return view;
  }
  const body = el("div", { class: "chat-body" });
  // Sticky as the last flex item so it floats at the bottom of the
  // visible scroll area without needing to track the composer's
  // (variable) height. Toggled on scroll directly — not through a full
  // render(), which would tank scroll responsiveness.
  const jump = el(
    "button",
    {
      class: "jump-to-latest",
      ...tapHandler(() => {
        body.scrollTop = body.scrollHeight;
        jump.classList.remove("visible");
      }),
    },
    "↓ Jump to latest",
  ) as HTMLButtonElement;
  let jumpVisibilityRaf = 0;
  body.addEventListener(
    "scroll",
    () => {
      view!.lastScrollAt = performance.now();
      const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 50;
      // Programmatic pins only ever scroll TO the bottom, so any event
      // away from it is the user scrolling — stop following until they
      // come back down.
      view!.stickToBottom = atBottom;
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
        jump.classList.toggle("visible", !atBottom);
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
  return null;
}

function cachedLogNode(item: ChatState["log"][number]): Node {
  const sig = logItemSig(item);
  if (sig === null) {
    return renderLogItem(item);
  }
  const hit = logNodeCache.get(item);
  if (hit && hit.sig.length === sig.length && hit.sig.every((v, i) => v === sig[i])) {
    return hit.node;
  }
  const node = renderLogItem(item);
  logNodeCache.set(item, { node, sig });
  return node;
}

// Minimal child sync: walks the desired list, moving/inserting only
// nodes that differ from what's already at that position, then trims
// leftovers. Unchanged nodes are identity-stable (cachedLogNode), so a
// typical streaming repaint touches exactly one child — the growing
// bubble — and the scroll container itself is never rebuilt.
function syncChildren(parent: HTMLElement, desired: Node[]): void {
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
  const visibleLog = capped ? c.log.slice(c.log.length - CHAT_LOG_RENDER_WINDOW) : c.log;
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
    const hiddenCount = c.log.length - CHAT_LOG_RENDER_WINDOW;
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
  pinIfDue(view);
}

// In-place repaint for the common case: already showing this chat, no
// banner/modal/overlay in play. Skips the renderer's full teardown so
// .chat-body (and scroll momentum, and any in-progress tap) survives.
// Returns false when the situation calls for the teardown path.
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
  if (root.childNodes.length !== 1 || root.firstChild !== view.root) {
    return false;
  }
  renderChat(s.current);
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
      el(
        "button",
        {
          class: "chat-back",
          title: "Back to session list",
          ...tapHandler(closeChat),
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
      !c.ready
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
        detailRow("cwd", cwd || "?"),
        workspaceRow(live?.workspace),
        ...c.configOptions.map(configOptionRow),
        hideThoughtsRow(),
        notifyOnTurnEndRow(),
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
  const textarea = el(
    "textarea",
    {
      "data-focus-key": "composer",
      placeholder: c.ready ? "Message…" : "Connecting…",
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
        // Sync the send/enqueue/amend buttons' disabled state directly
        // rather than going through a full render() — a full teardown
        // on every keystroke tanks typing responsiveness and resets
        // the textarea node out from under the browser's native
        // spellcheck/autocorrect session.
        const nowHasContent = t.value.trim().length > 0 || c.attachments.length > 0;
        const buttons =
          t.closest(".composer")?.querySelectorAll<HTMLButtonElement>(".content-gated") ?? [];
        for (const btn of buttons) {
          btn.disabled = !nowHasContent;
        }
      },
    },
    c.composerValue,
  ) as HTMLTextAreaElement;
  if (c.composerValue && c.composerValue.length > 0) {
    queueMicrotask(() => autosize(textarea));
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
            class: "content-gated",
            disabled: !hasContent,
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
          class: "primary content-gated",
          disabled: !hasContent,
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
        { class: "primary content-gated", disabled: !hasContent, ...tapHandler(sendPrompt) },
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
        ? "msg system"
        : "msg agent";
    const isCollapsed = isThought && collapsedThoughts.has(item);
    const node = el("div", { class: isCollapsed ? cls + " collapsed" : cls });
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
    // (queued / editing) or ended in cancellation / amend. Once it's
    // sent ("processing" or "done"), the bubble looks like a normal
    // user message. The running turn's × lives on the spinner instead
    // so it works for sibling-originated prompts too.
    if (
      qe &&
      (qe.status === "queued" ||
        qe.status === "pending" ||
        qe.status === "cancelled" ||
        qe.status === "editing" ||
        qe.status === "amended")
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
    const ahead = Math.max(1, entry.aheadAtEnqueue);
    return el(
      "div",
      { class: "queue-chip queue-queued" },
      el(
        "span",
        null,
        (ahead === 1 ? "queued · waiting on 1 turn" : `queued · waiting on ${ahead} turns`) +
          (entry.held ? " · held: agent resumed" : ""),
      ),
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
        "✎",
      ),
      el(
        "button",
        {
          class: "queue-cancel",
          ...tapHandler(() => cancelQueuedPrompt(entry)),
          title: "Cancel before sending",
        },
        "×",
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
    rows: "3",
    autocapitalize: "off",
  }) as HTMLTextAreaElement;
  textarea.value = entry.text;
  const commit = (): void => {
    const next = textarea.value;
    entry.text = next;
    onCommit(next);
    entry.status = "queued";
    updateQueuedPrompt(entry, next);
    render();
  };
  const cancel = (): void => {
    entry.status = "queued";
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

function renderSpinner(spinner: SpinnerState): HTMLElement {
  const cancelBtn = el(
    "button",
    {
      class: "queue-cancel",
      ...tapHandler(() => cancelProcessingPrompt()),
      title: "Cancel this turn",
    },
    "×",
  );
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
          spinner.toolCallIds.length === 0
            ? "thinking…"
            : `working — ${spinner.toolCallIds.length} tool call${
                spinner.toolCallIds.length === 1 ? "" : "s"
              }`,
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
      el("span", null, "working"),
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
