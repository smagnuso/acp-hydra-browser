// All render functions and the top-level renderApp(root, state)
// composer. Imports are kept at the top for readability; this is the
// largest module by design — keeping all the DOM-shaping code together
// makes UX iteration easier than chasing pieces across files.

import { state, setState } from "./state.js";
import { render } from "./renderer.js";
import { el, tapHandler } from "./dom.js";
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
  sendPrompt,
  sendSetConfigOption,
  sendSetMode,
  sendSetModel,
  sendWorkspaceCommand,
  updateQueuedPrompt,
} from "./queue.js";
import { openChat } from "./routing.js";
import { buildDiffDisplayLines, countDiffChanges } from "./edit-diff.js";
import type { DiffDisplayLine } from "./edit-diff.js";
import type {
  AppState,
  ChatState,
  ConfigOption,
  EditDiffLogItem,
  FileEntry,
  PermissionEntry,
  QueueEntry,
  SessionInfo,
  SessionModalData,
  SpinnerState,
} from "./types.js";

// Tracks which thought bubbles the user has collapsed. Keyed by log item
// object reference, which is stable across re-renders (mutated in place).
const collapsedThoughts = new WeakSet<object>();

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

// Abbreviated "time since" hint for the subtitle row. Matches the
// CLI/TUI style: "<1m", "12m", "3h", "2d", "5w", "11mo", "2y".
function formatRelativeAge(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "?";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "?";
  const diff = Math.max(0, now - t);
  const sec = Math.floor(diff / 1000);
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
        onclick: () =>
          setState({ groupBy: state.groupBy === "project" ? "recent" : "project" }),
      },
      state.groupBy,
    ),
    el(
      "span",
      {
        class: "pill clickable",
        title: "Click to toggle showing disk-only sessions",
        onclick: () => {
          setState({ showCold: !state.showCold });
        },
      },
      state.showCold ? "all" : "warm",
    ),
    renderHostFilter(),
    el("span", { class: "spacer" }),
    el(
      "button",
      {
        onclick: openImportPicker,
        title: "Import a *.hydra bundle from disk",
      },
      "📥",
    ),
    el("button", { onclick: openSessionModal, title: "New Session" }, "＋"),
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

function compareSessions(a: SessionInfo, b: SessionInfo): number {
  const warmDiff = (b.status === "warm" ? 1 : 0) - (a.status === "warm" ? 1 : 0);
  if (warmDiff !== 0) {
    return warmDiff;
  }
  return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
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
  return el(
    "div",
    {
      class: "card",
      onclick: (e: Event) => {
        const target = e.target as HTMLElement;
        if (target.closest("button")) return;
        openChat(s.sessionId, s.status === "cold");
      },
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
        el(
          "span",
          {
            class: `badge ${s.status === "cold" ? "cold" : "warm"}`,
            title:
              s.status === "cold"
                ? "Disk-only — opening will resurrect the session"
                : "Live in-memory session",
          },
          s.status === "cold" ? "cold" : "warm",
        ),
        s.busy || s.awaitingInput
          ? el(
              "span",
              {
                class: "badge busy",
                title: s.busy
                  ? "Agent is working"
                  : "Waiting on you — a permission request or other prompt is pending",
              },
              s.busy ? "busy" : "needs input",
            )
          : null,
        // A session with armed background tasks but no turn in flight is
        // idle right now but may restart itself with no prompt: worth a
        // distinct badge from "busy" (working right now) so a user
        // browsing the list can tell it isn't fully at rest.
        !s.busy && (s.armedTasks ?? 0) > 0
          ? el(
              "span",
              {
                class: "badge armed",
                title: "Agent has a background task running. It may resume on its own.",
              },
              "armed",
            )
          : null,
        el("span", { class: "badge" }, `${s.attachedClients ?? 0} attached`),
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
            onclick: (e: Event) => {
              e.stopPropagation();
              triggerExportDownload(s.sessionId);
            },
          },
          "↓",
        ),
        el(
          "button",
          {
            class: "danger",
            onclick: (e: Event) => {
              e.stopPropagation();
              void killSession(s);
            },
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
      onclick: (e: Event) => {
        if ((e.target as HTMLElement).classList.contains("modal-bg")) closeModal();
      },
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
        el("button", { onclick: closeModal, disabled: m.busy }, "Cancel"),
        el(
          "button",
          { class: "primary", onclick: createSession, disabled: m.busy },
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
      onclick: (e: Event) => {
        if ((e.target as HTMLElement).classList.contains("modal-bg")) closeModal();
      },
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
            onclick: () => {
              onPick(it);
              closeModal();
            },
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

// ---- Chat view ---------------------------------------------------

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
      {
        class: "chat-title clickable",
        title: "Click for session details",
        onclick: toggleDetails,
      },
      title,
    ),
    el(
      "div",
      { class: "chat-header-row" },
      !c.ready
        ? el(
            "span",
            { class: "pill clickable", title: "Click for session details", onclick: toggleDetails },
            "connecting…",
          )
        : c.inTurn
        ? el(
            "span",
            {
              class: "pill working clickable",
              title: "Agent is working",
              onclick: toggleDetails,
            },
            el("span", { class: "dot" }, "●"),
            "busy",
          )
        : el(
            "span",
            {
              class: "pill ready clickable",
              title: "Ready for a prompt",
              onclick: toggleDetails,
            },
            el("span", { class: "dot" }, "●"),
            "ready",
          ),
      c.armedTasks && c.armedTasks > 0
        ? el(
            "span",
            {
              class: "pill armed clickable",
              title: c.armedSince
                ? `Agent has a background task running (armed ${Math.max(1, Math.floor((Date.now() - c.armedSince) / 60000))}m ago). It may resume on its own.`
                : "Agent has a background task running. It may resume on its own.",
              onclick: toggleDetails,
            },
            "armed",
          )
        : null,
      live?.workspace
        ? el(
            "span",
            {
              class: "pill clickable",
              title: `In workspace "${live.workspace.label}" (source: ${shortenCwd(live.workspace.sourceCwd)})`,
              onclick: toggleDetails,
            },
            "⎇ " + live.workspace.label,
          )
        : null,
      c.model
        ? el(
            "span",
            { class: "pill clickable", title: "Model (click to change)", onclick: openModelPicker },
            c.model,
          )
        : null,
      c.contextUsed != null && c.contextSize
        ? el(
            "span",
            {
              class: "pill",
              title: `${c.contextUsed.toLocaleString()} / ${c.contextSize.toLocaleString()} context tokens`,
            },
            `${fmtTokens(c.contextUsed)}/${fmtTokens(c.contextSize)}`,
          )
        : null,
      fmtCost(c.cost)
        ? el(
            "span",
            { class: "pill", title: "Session cost so far" },
            fmtCost(c.cost) as string,
          )
        : null,
      el("button", { onclick: openFiles, title: "Files" }, "📁"),
      el(
        "button",
        {
          title: "Export this session as a *.hydra bundle",
          onclick: () => triggerExportDownload(c.sessionId),
        },
        "⬇",
      ),
      el("div", {
        class: "info clickable",
        title: "Click for session details",
        onclick: toggleDetails,
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
      )
    : null;

  const body = el("div", { class: "chat-body" });
  for (const item of c.log) {
    // hideThoughts skips agent_thought_chunk bubbles at render time
    // only — they stay in c.log so toggling the preference back on
    // (or exporting the session) still shows/keeps them.
    if (state.hideThoughts && item.kind === "stream" && item.role === "thought") {
      continue;
    }
    body.appendChild(renderLogItem(item));
  }

  const autosize = (t: HTMLTextAreaElement): void => {
    t.style.height = "auto";
    t.style.height = t.scrollHeight + "px";
  };
  const setComposer = (t: HTMLTextAreaElement, text: string): void => {
    t.value = text;
    c.composerValue = text;
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
      oninput: (e: Event) => {
        const t = e.target as HTMLTextAreaElement;
        c.composerValue = t.value;
        // User typed — they're off the history rail. Drop the nav
        // cursor so the next Up starts a fresh walk and Down doesn't
        // surprise them by restoring an old draft.
        if (c.historyIndex !== null) {
          c.historyIndex = null;
          c.historyDraft = null;
        }
        autosize(t);
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
  const sendButtons: Node[] = [];
  if (c.inTurn) {
    if (c.daemonSupportsAmend && c.currentHeadMessageId !== undefined) {
      sendButtons.push(
        el(
          "button",
          {
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
          class: "primary",
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
        { class: "primary", ...tapHandler(sendPrompt) },
        "Send",
      ),
    );
  }
  const composer = el(
    "div",
    { class: "composer" },
    textarea,
    el(
      "div",
      { class: "composer-buttons" },
      el(
        "button",
        { class: "stop", ...tapHandler(sendCancel), title: "Cancel current turn" },
        "Stop",
      ),
      ...sendButtons,
    ),
  );

  // Auto-scroll is owned by renderer.ts now (it captures the previous
  // chat-body's scroll state and restores synchronously on the new
  // one) so we don't get a one-frame "scroll-from-zero" flash. The
  // renderer also respects the user's scrollTop when they're not at
  // the bottom.

  return el("div", { class: "chat" }, header, details, body, composer);
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
      const body = el("div", { class: item.synthetic ? "body raw" : "body" });
      if (item.synthetic) {
        body.textContent = item.text;
      } else {
        body.innerHTML = renderMarkdown(item.text);
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

function renderEditDiff(item: EditDiffLogItem): HTMLElement {
  const counts = countDiffChanges(item.diff);
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
      onclick: () => {
        item.expanded = !item.expanded;
        render();
      },
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
    const lines = buildDiffDisplayLines(item.diff);
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
  body.innerHTML = renderMarkdown(item.plan);
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
          onclick: () => {
            entry.status = "editing";
            render();
          },
          title: "Edit before sending",
        },
        "✎",
      ),
      el(
        "button",
        {
          class: "queue-cancel",
          onclick: () => cancelQueuedPrompt(entry),
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
      el("span", null, "editing · enter to save · esc to cancel edit"),
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
// reverts without sending. The commit may be rejected by hydra if the
// prompt has already started — the chip status will get overwritten
// shortly after by the daemon's broadcasts in either case.
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
  textarea.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      const next = textarea.value;
      entry.text = next;
      onCommit(next);
      entry.status = "queued";
      updateQueuedPrompt(entry, next);
      render();
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      entry.status = "queued";
      render();
    }
  });
  // Autofocus + place caret at end. Done in a microtask so the
  // textarea is in the DOM by the time we touch it.
  queueMicrotask(() => {
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  });
  return el("div", { class: "queue-editor" }, textarea);
}

function renderSpinner(spinner: SpinnerState): HTMLElement {
  const cancelBtn = el(
    "button",
    {
      class: "queue-cancel",
      onclick: (e: Event) => {
        e.stopPropagation();
        cancelProcessingPrompt();
      },
      title: "Cancel this turn",
    },
    "×",
  );
  if (!spinner.expanded) {
    return el(
      "div",
      {
        class: "spinner",
        onclick: () => {
          spinner.expanded = true;
          render();
        },
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
      onclick: () => {
        spinner.expanded = false;
        render();
      },
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
            onclick: () => respondPermission(entry.toolCallId, o.optionId),
          },
          o.name || o.optionId,
        ),
      ),
      el(
        "button",
        { onclick: () => respondPermission(entry.toolCallId, "__cancel__") },
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
    el("span", { class: "crumb", onclick: () => listFiles("") }, "."),
  ];
  let acc = "";
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    const target = acc;
    crumbs.push(document.createTextNode(" / "));
    crumbs.push(el("span", { class: "crumb", onclick: () => listFiles(target) }, p));
  }
  return el("div", { class: "crumbs" }, crumbs);
}

function addLineRef(path: string, line: number): void {
  if (!state.current) return;
  const ref = `${path}:${line}`;
  const cur = state.current.composerValue;
  state.current.composerValue = cur ? `${cur} ${ref}` : ref;
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
        el("div", { class: "ln", onclick: () => addLineRef(path, ln) }, String(ln)),
      );
    }
    body = el(
      "div",
      { class: "preview" },
      el(
        "div",
        { class: "crumbs" },
        el("span", { class: "crumb", onclick: () => closeFilePreview() }, "← back to listing"),
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
                onclick: () => listFiles(fo.path.split("/").slice(0, -1).join("/")),
              },
              el("span", { class: "icon" }, "▸"),
              el("span", { class: "name" }, ".."),
              el("span", { class: "size" }, ""),
            )
          : null,
        ...fo.entries.map((e) =>
          el(
            "div",
            { class: "entry", onclick: () => navigateFile(e) },
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
      onclick: (ev: Event) => {
        if ((ev.target as HTMLElement).classList.contains("modal-bg")) closeFiles();
      },
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
        el("button", { onclick: closeFiles }, "×"),
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
