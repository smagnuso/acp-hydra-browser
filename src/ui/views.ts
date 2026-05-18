// All render functions and the top-level renderApp(root, state)
// composer. Imports are kept at the top for readability; this is the
// largest module by design — keeping all the DOM-shaping code together
// makes UX iteration easier than chasing pieces across files.

import { state, setState } from "./state.js";
import { render } from "./renderer.js";
import { el } from "./dom.js";
import { renderMarkdown, escapeHtml } from "./markdown.js";
import {
  api,
  importBundle,
  pollSessions,
  tryImportBundleWith409,
} from "./api.js";
import { respondPermission } from "./bridge.js";
import {
  cancelProcessingPrompt,
  cancelQueuedPrompt,
  sendCancel,
  sendPrompt,
  sendSetMode,
  sendSetModel,
} from "./queue.js";
import { closeChat, openChat } from "./routing.js";
import type {
  AppState,
  ChatState,
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

// "agent(model)" when both are known, just the agent (or "?") otherwise.
function agentWithModel(
  agent: string | undefined,
  model: string | undefined,
): string {
  const a = agent || "?";
  const m = shortenModel(model);
  return m ? `${a}(${m})` : a;
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
    el("span", { class: "title" }, "hydra-acp-browser"),
    el(
      "span",
      {
        class: "pill clickable",
        onclick: () =>
          setState({ groupBy: state.groupBy === "project" ? "recent" : "project" }),
      },
      `group: ${state.groupBy}`,
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
      state.showCold ? "all" : "live",
    ),
    el("span", { class: "spacer" }),
    el(
      "button",
      {
        onclick: openImportPicker,
        title: "Import a *.hydra bundle from disk",
      },
      "Import",
    ),
    el("button", { onclick: openSessionModal }, "New Session"),
  );
}

// ---- Session list -----------------------------------------------

function renderList(): HTMLElement {
  // Daemon always returns everything now; the "show cold" toggle is
  // a client-side filter — hide cold cards when the toggle is off.
  const visible = state.showCold
    ? state.sessions
    : state.sessions.filter((s) => s.status !== "cold");
  const hiddenCold = state.sessions.length - visible.length;
  const groups = groupSessions(visible, state.groupBy);
  const list = el("div", { class: "list" });
  if (visible.length === 0) {
    const msg =
      state.sessions.length === 0
        ? "No sessions. Use + to create one, or run `hydra-acp launch <agent>` from your editor."
        : `No live sessions. ${hiddenCold} cold session${hiddenCold === 1 ? "" : "s"} hidden — click "live" to switch to "all".`;
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
  const liveDiff = (b.status === "live" ? 1 : 0) - (a.status === "live" ? 1 : 0);
  if (liveDiff !== 0) {
    return liveDiff;
  }
  return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
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
    out.push({ label: cwd, sessions: items });
  }
  return out;
}

function renderSessionCard(s: SessionInfo, showCwd: boolean): HTMLElement {
  const title = s.title || fallbackTitle(s.sessionId);
  const parts = [
    shortSessionId(s.sessionId),
    agentWithModel(s.agentId, s.currentModel),
    `age ${formatRelativeAge(s.updatedAt)}`,
  ];
  if (showCwd) {
    parts.push(s.cwd || "?");
  }
  const subtitle = parts.join(" · ");
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
    el(
      "div",
      { class: "meta" },
      el("div", { class: "row1" }, title),
      el("div", { class: "row2" }, subtitle),
    ),
    el(
      "div",
      { class: "badges" },
      el(
        "span",
        {
          class: `badge ${s.status === "cold" ? "cold" : "live"}`,
          title:
            s.status === "cold"
              ? "Disk-only — opening will resurrect the session"
              : "Live in-memory session",
        },
        s.status === "cold" ? "cold" : "live",
      ),
      el("span", { class: "badge" }, `${s.attachedClients ?? 0} attached`),
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

function openSessionModal(): void {
  const hasDefault =
    state.defaultAgent &&
    state.agents.some((a) => a.id === state.defaultAgent);
  setState({
    modal: {
      kind: "session",
      cwd: state.defaultCwd ?? "",
      agentId: hasDefault
        ? state.defaultAgent!
        : (state.agents[0]?.id ?? ""),
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
  if (state.agents.length === 0) {
    sel.appendChild(el("option", { value: "" }, "(default)"));
  }
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

// ---- Mode / model picker -----------------------------------------

function cycleMode(): void {
  const c = state.current;
  if (!c?.modes || c.modes.length === 0) return;
  const idx = c.modes.findIndex((m) => m.id === c.mode);
  const next = c.modes[(idx + 1) % c.modes.length];
  c.mode = next.id;
  render();
  sendSetMode(next.id);
}

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
          it.id === selectedId ? el("span", { class: "badge live" }, "current") : null,
        ),
      ),
    ),
  );
}

// ---- Chat view ---------------------------------------------------

function renderChat(c: ChatState): HTMLElement {
  // Pull fresh metadata from the session list each render so a
  // deep-link reload (where the SPA opened the chat before any poll
  // landed) gets the real title/cwd/agentId once polling completes.
  const live = state.sessions.find((s) => s.sessionId === c.sessionId);
  const title = live?.title || c.title || fallbackTitle(c.sessionId);
  const cwd = live?.cwd || c.cwd;
  const agentId = live?.agentId || c.agentId;
  // The chat's `c.model` is the live, WS-updated value (more current than
  // any session-list poll); fall back to the polled record so the row
  // isn't empty before the first current_model_update lands.
  const model = c.model || live?.currentModel;
  const header = el(
    "div",
    { class: "chat-header" },
    el("button", { class: "ghost", onclick: closeChat }, "←"),
    el(
      "div",
      { class: "info" },
      el("div", { class: "row1" }, title),
      el(
        "div",
        { class: "row2" },
        `${shortSessionId(c.sessionId)} · ${agentWithModel(agentId, model)} · ${cwd || "?"}`,
      ),
    ),
    !c.ready
      ? el("span", { class: "pill" }, "connecting…")
      : c.inTurn
      ? el(
          "span",
          { class: "pill working", title: "Agent is working" },
          el("span", { class: "dot" }, "●"),
          "working",
        )
      : el(
          "span",
          { class: "pill ready", title: "Ready for a prompt" },
          el("span", { class: "dot" }, "●"),
          "ready",
        ),
    c.mode
      ? el("span", { class: "pill clickable", onclick: cycleMode }, "mode: " + c.mode)
      : null,
    c.model
      ? el("span", { class: "pill clickable", onclick: openModelPicker }, "model: " + c.model)
      : null,
    c.contextUsed != null && c.contextSize
      ? el(
          "span",
          {
            class: "pill",
            title: `${c.contextUsed.toLocaleString()} / ${c.contextSize.toLocaleString()} context tokens`,
          },
          `${fmtTokens(c.contextUsed)}/${fmtTokens(c.contextSize)} tokens`,
        )
      : null,
    fmtCost(c.cost)
      ? el(
          "span",
          { class: "pill", title: "Session cost so far" },
          fmtCost(c.cost) as string,
        )
      : null,
    el("button", { onclick: openFiles }, "Files"),
    el(
      "button",
      {
        title: "Export this session as a *.hydra bundle",
        onclick: () => triggerExportDownload(c.sessionId),
      },
      "Export",
    ),
  );

  const body = el("div", { class: "chat-body" });
  for (const item of c.log) {
    body.appendChild(renderLogItem(item));
  }

  const composerOnKey = (e: KeyboardEvent): void => {
    if (e.key !== "Enter" || e.isComposing) return;
    // Shift+Enter — let the browser insert \n natively.
    if (e.shiftKey) return;
    // Alt/Ctrl/Cmd + Enter — manually insert \n at the caret because
    // browsers don't do that by default for those modifiers.
    if (e.altKey || e.ctrlKey || e.metaKey) {
      e.preventDefault();
      insertAtCaret(e.target as HTMLTextAreaElement, "\n");
      return;
    }
    e.preventDefault();
    sendPrompt();
  };
  const autosize = (t: HTMLTextAreaElement): void => {
    t.style.height = "auto";
    t.style.height = t.scrollHeight + "px";
  };
  const textarea = el(
    "textarea",
    {
      "data-focus-key": "composer",
      placeholder: c.ready ? "Message…" : "Connecting…",
      rows: "1",
      onkeydown: composerOnKey,
      oninput: (e: Event) => {
        const t = e.target as HTMLTextAreaElement;
        c.composerValue = t.value;
        autosize(t);
      },
    },
    c.composerValue,
  ) as HTMLTextAreaElement;
  if (c.composerValue && c.composerValue.length > 0) {
    queueMicrotask(() => autosize(textarea));
  }

  const composer = el(
    "div",
    { class: "composer" },
    textarea,
    el("button", { class: "stop", onclick: sendCancel, title: "Cancel current turn" }, "Stop"),
    el("button", { class: "primary", onclick: sendPrompt }, "Send"),
  );

  // Auto-scroll is owned by renderer.ts now (it captures the previous
  // chat-body's scroll state and restores synchronously on the new
  // one) so we don't get a one-frame "scroll-from-zero" flash. The
  // renderer also respects the user's scrollTop when they're not at
  // the bottom.

  return el("div", { class: "chat" }, header, body, composer);
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
    // Only show a chip while the prompt is still waiting locally
    // (queued) or ended in cancellation. Once it's sent ("processing"
    // or "done"), the bubble looks like a normal user message. The
    // running turn's × lives on the spinner instead so it works for
    // sibling-originated prompts too.
    if (qe && (qe.status === "queued" || qe.status === "cancelled")) {
      node.appendChild(renderQueueChip(qe));
    }
    const body = el("div", { class: "body" });
    body.innerHTML = renderMarkdown(item.text);
    if (qe && qe.status === "cancelled") {
      body.style.textDecoration = "line-through";
      body.style.opacity = "0.6";
    }
    node.appendChild(body);
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
  return document.createTextNode("");
}

function renderQueueChip(entry: QueueEntry): Node {
  if (entry.status === "queued") {
    const ahead = Math.max(1, entry.aheadAtEnqueue);
    return el(
      "div",
      { class: "queue-chip queue-queued" },
      el(
        "span",
        null,
        ahead === 1 ? "queued · waiting on 1 turn" : `queued · waiting on ${ahead} turns`,
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
  return document.createTextNode("");
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

function renderPermission(entry: PermissionEntry): HTMLElement {
  const tc = entry.toolCall || {};
  return el(
    "div",
    { class: "perm" },
    el("div", { class: "title" }, "🔒 Permission requested"),
    el("div", { class: "desc" }, tc.title || tc.name || "tool call"),
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

function closeFilePreview(): void {
  if (!state.current?.fileOverlay) return;
  state.current.fileOverlay.preview = null;
  render();
}

function renderFileOverlay(c: ChatState): Node {
  const fo = c.fileOverlay;
  if (!fo) return document.createTextNode("");
  const body = fo.preview
    ? el(
        "div",
        { class: "preview" },
        el(
          "div",
          { class: "crumbs" },
          el("span", { class: "crumb", onclick: () => closeFilePreview() }, "← back to listing"),
          document.createTextNode(`  ${fo.preview.path}`),
        ),
        el("pre", { html: escapeHtml(fo.preview.content) }),
      )
    : el(
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
