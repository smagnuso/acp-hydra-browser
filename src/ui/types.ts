// Shape definitions shared across UI modules. Kept loose where the wire
// data is variable (ACP notifications, agents, etc.) and tighter where
// behavior depends on it (queue entries, log items).

// Spec shape for a session config option (ConfigOption) and its values,
// mirroring cli/src/core/hydra-commands.ts. Delivered on session/attach
// (top-level configOptions) and via config_option_update notifications.
// Always includes hydra's own model/mode/agent dimensions, plus whatever
// the underlying agent advertises on its own (e.g. claude-agent-acp's
// reasoning-effort picker, category "thought_level").
export interface ConfigOptionValue {
  value: string;
  name: string;
  description?: string;
}

export interface ConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: "select";
  currentValue: string;
  options: ConfigOptionValue[];
}

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  agentId?: string;
  // Last-known model id from the daemon's session list. Lets the card
  // subtitle render `agent(model)` without needing the session to be hot.
  currentModel?: string;
  title?: string;
  attachedClients?: number;
  updatedAt?: string;
  status?: "warm" | "cold";
  // Mid-turn flag (a prompt is in flight). See PROTOCOL.md's
  // SessionListEntry.
  busy?: boolean;
  // Any attention flag raised — a permission request or transformer flag
  // waiting on the user. Can be true on cold sessions too.
  awaitingInput?: boolean;
  // Hostname of the machine that exported the bundle this session was
  // imported from. Undefined for sessions created on this host.
  importedFromMachine?: string;
  // Local ACP agent's session id once an agent has bound this session
  // here. An imported session with no upstreamSessionId is a passive
  // mirror; once the user attaches and an agent binds, the field is
  // populated and the session is treated as local-ish (showing up in
  // the "host: local" filter, getting a Slack thread, etc.).
  upstreamSessionId?: string;
  // Count of background tasks (Monitor, backgrounded Bash) the agent
  // has armed and not yet been seen to resolve. Nonzero means the
  // session may restart itself with no prompt even while otherwise
  // idle. See PROTOCOL.md's "Armed tasks (the third session state)".
  armedTasks?: number;
  // Present only for a session running in an isolated workspace. Named
  // `workspace` on the wire, not `workspaceInfo` (that name belongs to
  // the separate ACP `_meta["hydra-acp"]` surface). See PROTOCOL.md's
  // "Workspace isolation". sourceCwd is the tree it was derived from
  // (this session's own `cwd` is the workspace path).
  workspace?: {
    path: string;
    sourceCwd: string;
    label: string;
    provider: string;
    snapshot?: string;
    vcs?: { kind: string; branch?: string };
    clean?: boolean;
  };
  // Present when isolation was requested and fell back to the source
  // tree. Live-only.
  workspaceError?: string;
}

export interface AgentInfo {
  id: string;
  name?: string;
  description?: string;
}

export type QueueStatus =
  | "queued"
  | "pending"
  | "processing"
  | "done"
  | "cancelled"
  | "editing"
  // Terminal state used when this entry's turn was cancelled by an
  // amend pointed at it. Rendered like a soft completion (no
  // strikethrough, no red banner) — the replacement carries the
  // user's intent forward, so the M1 bubble just gets a chip noting
  // it was merged into the next prompt.
  | "amended";

export interface QueueEntry {
  // Local id assigned at submit time. Stable for the lifetime of the
  // bubble; used as a UI key (e.g. to scope an inline editor).
  id: string;
  text: string;
  status: QueueStatus;
  // Snapshot of how many entries were ahead of us when this one was
  // submitted. Kept stable after enqueue so the "waiting on N turns"
  // chip doesn't tick down distractingly as the queue drains.
  aheadAtEnqueue: number;
  // Server-assigned id from hydra-acp/prompt_queue/added. Undefined
  // briefly between the user's submit and the daemon's accept; once
  // bound, used to target hydra-acp/prompt/cancel and update_prompt
  // for this entry.
  messageId?: string;
  // Set when this entry is the M2 of an amend: the messageId of the
  // M1 (cancelled) prompt it superseded. Drives the "+" marker on the
  // bubble.
  amendsMessageId?: string;
  // Set when this entry's turn was cancelled by an amend pointed at
  // it (i.e. the M1 of an amend pair). Drives the "amended" chip.
  amendedByMessageId?: string;
  // True while hydra-acp/prompt_queue/held is in effect for this entry
  // (an agent-initiated turn is running and this entry is the head
  // waiting to be dispatched). Cleared by the matching .../released.
  // The entry stays "queued" in status the whole time: this only
  // changes how the chip reads.
  held?: boolean;
}

export interface ToolCallState {
  toolCallId: string;
  title: string;
  kind: string;
  status: string;
  content: string;
}

export interface SpinnerState {
  toolCallIds: string[];
  expanded: boolean;
}

export interface PermissionEntry {
  // Original JSON-RPC request id from the agent — kept so reply() can echo it
  // verbatim. Correlation across hydra (sibling-resolve, fan-out cleanup) is by
  // toolCallId per RFD #533.
  requestId: string | number;
  toolCallId: string;
  toolCall: { title?: string; name?: string; [k: string]: unknown };
  options: Array<{ optionId: string; name?: string; kind?: string }>;
}

export interface PlanLogItem {
  kind: "plan";
  entries: unknown;
}

// Bubble for Claude's ExitPlanMode tool. The plan markdown rides in
// rawInput.plan on the wire and we render it as its own message in the
// log; the permission card lands below it as a separate "perm" item.
// Mutated in place by tool_call_update so the status footer flips when
// the user approves / rejects.
export interface ExitPlanLogItem {
  kind: "exit-plan-mode";
  toolCallId: string;
  plan: string;
  status?: string;
}

// Wire payload for an edit-style tool call, extracted from either the
// canonical ACP content[] diff carrier or Claude's rawInput fallback
// shapes (see src/ui/edit-diff.ts). Deliberately doesn't model the CLI's
// oldRef/newRef blob-ref transport — out of scope here.
export interface EditDiff {
  path?: string;
  oldText: string;
  newText: string;
}

// Persistent "Edited <path>" block. Unlike the ephemeral spinner tool-call
// list, this survives finalizeTurn() so file edits stay visible after the
// turn ends. Mutated in place by tool_call_update so a later update amends
// the diff rather than duplicating the block.
export interface EditDiffLogItem {
  kind: "edit-diff";
  toolCallId: string;
  diff: EditDiff;
  status?: string;
  expanded: boolean;
}

export type LogItem =
  | {
      kind: "stream";
      role: "user" | "agent" | "thought";
      text: string;
      closed?: boolean;
      queueEntry?: QueueEntry;
      // Set for structured CLI-style output injected as an agent
      // message (e.g. `_meta["hydra-acp"].synthetic` frames like
      // `/hydra workspace start`'s status block) rather than LLM
      // prose. Rendered preformatted instead of through markdown so
      // line breaks and indentation survive.
      synthetic?: boolean;
    }
  | { kind: "system"; text: string }
  | { kind: "error"; text: string }
  | { kind: "spinner"; spinner: SpinnerState }
  | { kind: "perm"; toolCallId: string }
  | PlanLogItem
  | ExitPlanLogItem
  | EditDiffLogItem;

export interface FileEntry {
  name: string;
  kind: "file" | "dir" | "other";
  size: number;
  mtimeMs?: number;
}

export interface FileOverlayState {
  path: string;
  entries: FileEntry[];
  preview: { path: string; content: string } | null;
  err: string | null;
}

export interface ChatState {
  sessionId: string;
  title: string;
  cwd: string;
  agentId: string;
  ws: WebSocket | null;
  ready: boolean;
  log: LogItem[];
  toolCalls: Map<string, ToolCallState>;
  pendingPermissions: Map<string, PermissionEntry>;
  pendingRequestById: Map<string, unknown>;
  // Per-id callbacks registered by call sites (e.g. amendPrompt) that
  // need the JSON-RPC response value, not just the side-effects of
  // the notifications hydra emits.
  responseHandlers: Map<string, (frame: { result?: unknown; error?: unknown }) => void>;
  spinner: SpinnerState | null;
  plan: unknown;
  mode: string | null;
  model: string | null;
  modes: Array<{ id: string; name?: string }>;
  models: Array<{ id: string; name?: string }>;
  contextUsed: number | null;
  contextSize: number | null;
  cost: unknown;
  fileOverlay: FileOverlayState | null;
  composerValue: string;
  busy: boolean;
  recentOwnPrompts: Array<{ text: string; at: number }>;
  // Shell-style up/down history. `history` is most-recent-first and
  // capped at a small N. `historyIndex` is the current nav position
  // (0 = newest), or null when the composer isn't being walked.
  // `historyDraft` snapshots whatever was in the composer when nav
  // started so Down-past-newest can restore the user's draft.
  history: string[];
  historyIndex: number | null;
  historyDraft: string | null;
  _lastMetaFp: string;
  // Own queue entries in submit order (FIFO). Unbound entries — those
  // whose messageId is still undefined — are the front-of-FIFO waiting
  // for hydra-acp/prompt_queue/added to bind them. Bound entries have
  // their messageId set and are findable via queueByMessageId.
  promptQueue: QueueEntry[];
  // messageId → entry for O(1) lookup when prompt_queue_updated /
  // prompt_queue_removed arrives for a specific messageId.
  queueByMessageId: Map<string, QueueEntry>;
  // Captured from the bridge/ready notification (passed through from
  // the upstream session/attach response). Used to recognize our own
  // prompt_queue_added events.
  ownClientId?: string;
  ownPromptIds: Set<string>;
  inTurn: boolean;
  idleListeners: Array<() => void>;
  readyListeners: Array<() => void>;
  // Pointer into log[] for the active turn's plan card. onPlanUpdate
  // mutates this in place (so the same card grows / ticks off items
  // as the agent revises). Cleared at turn end so the next turn pushes
  // a fresh card.
  currentPlanEntry: PlanLogItem | null;
  nextId?: number;
  // Set from bridge/ready _meta["hydra-acp"].prompt.amending. Gates
  // the Amend button — older daemons that don't advertise this fall
  // back to a single Send button.
  daemonSupportsAmend: boolean;
  // The messageId of the prompt currently driving the agent's turn,
  // or undefined when idle. Captured from prompt_queue_removed{started}
  // (the universal signal that reaches the originator too, unlike
  // prompt_received). Used as targetMessageId for hydra-acp/prompt/amend.
  currentHeadMessageId?: string;
  // Active backoff timer for reconnect, or undefined when not pending.
  // Cleared by closeChat / openChat so navigation cancels the loop.
  reconnectTimer?: ReturnType<typeof setTimeout>;
  // Count of consecutive failed reconnect attempts; reset to 0 by
  // bridge.ts when bridge/ready arrives. Drives backoff and the
  // "still disconnected" banner threshold.
  reconnectAttempt?: number;
  // Whether the load=true query param was used on the initial open.
  // Reconnects should not re-send it: load=true is the cold-start
  // hint for session/load and is harmless but wasted on a hot session.
  loadOnConnect?: boolean;
  // Whether the chat-header's detail panel (full title/cwd/agent/model,
  // untruncated) is expanded. Toggled by clicking the header's info block.
  headerExpanded: boolean;
  // messageIds of agent-initiated (unsolicited) turns currently open
  // server-side: the agent restarted itself off a finished background
  // task, not a session/prompt we sent. Keyed by messageId (turn_started's
  // messageId, matched against turn_ended's startedMessageId) rather than
  // a single boolean so overlapping unsolicited turns (e.g. several
  // onceIdle-swap retries firing in quick succession during an agent
  // switch) don't drop or misfire each other's open/close. A replayed or
  // unpaired turn_ended (e.g. after a daemon restart) that doesn't match
  // any open id is simply ignored rather than double-closing or closing a
  // turn we never saw open. Mirrors cli's tui/app.ts and slack's
  // acp/session.ts, adapted for the multi-turn case.
  unsolicitedTurnOpen: Set<string>;
  // Count of background tasks armed but not yet resolved, and when the
  // oldest of them was armed. Seeded from bridge/ready's forwarded
  // session/attach _meta and kept live by
  // hydra-acp/session/armed_tasks_updated (REPLACE semantics, see
  // onArmedTasksUpdated).
  armedTasks?: number;
  armedSince?: number;
  // Full config-option snapshot (model/mode/agent plus whatever the
  // agent advertises, e.g. effort). See config_option_update handling
  // in acp.ts. Empty until the first snapshot arrives.
  configOptions: ConfigOption[];
}

export interface SessionModalData {
  kind: "session";
  cwd: string;
  agentId: string;
  name: string;
  prompt: string;
  err: string | null;
  busy: boolean;
}

export type ModalState =
  | SessionModalData
  | { kind: "modes" }
  | { kind: "models" }
  | null;

export type Banner = { kind: "good" | "warn" | "bad"; text: string } | null;

export interface AppState {
  view: "list" | "chat";
  sessions: SessionInfo[];
  agents: AgentInfo[];
  defaultCwd: string | null;
  groupBy: "project" | "recent";
  showCold: boolean;
  // Hide agent_thought_chunk bubbles across every chat. Persisted
  // globally (not per-session) since it's a display preference, not
  // session state — thought chunks are still received and kept in
  // the log, just skipped at render time, so toggling it back on
  // doesn't require a reload or re-fetch.
  hideThoughts: boolean;
  // Host filter selection for the session list. "__local" hides every
  // imported session; "__all" hides nothing; any other value filters
  // to sessions whose importedFromMachine matches.
  hostFilter: string;
  banner: Banner;
  modal: ModalState;
  current: ChatState | null;
}
