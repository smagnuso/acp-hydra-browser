// Shape definitions shared across UI modules. Kept loose where the wire
// data is variable (ACP notifications, agents, etc.) and tighter where
// behavior depends on it (queue entries, log items).

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
  status?: "live" | "cold";
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
  // Server-assigned id from hydra-acp/prompt_queue_added. Undefined
  // briefly between the user's submit and the daemon's accept; once
  // bound, used to target hydra-acp/cancel_prompt and update_prompt
  // for this entry.
  messageId?: string;
  // Set when this entry is the M2 of an amend: the messageId of the
  // M1 (cancelled) prompt it superseded. Drives the "+" marker on the
  // bubble.
  amendsMessageId?: string;
  // Set when this entry's turn was cancelled by an amend pointed at
  // it (i.e. the M1 of an amend pair). Drives the "amended" chip.
  amendedByMessageId?: string;
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

export type LogItem =
  | {
      kind: "stream";
      role: "user" | "agent" | "thought";
      text: string;
      closed?: boolean;
      queueEntry?: QueueEntry;
    }
  | { kind: "system"; text: string }
  | { kind: "error"; text: string }
  | { kind: "spinner"; spinner: SpinnerState }
  | { kind: "perm"; toolCallId: string }
  | PlanLogItem;

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
  // for hydra-acp/prompt_queue_added to bind them. Bound entries have
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
  // Set from bridge/ready _meta["hydra-acp"].promptAmending. Gates
  // the Amend button — older daemons that don't advertise this fall
  // back to a single Send button.
  daemonSupportsAmend: boolean;
  // The messageId of the prompt currently driving the agent's turn,
  // or undefined when idle. Captured from prompt_queue_removed{started}
  // (the universal signal that reaches the originator too, unlike
  // prompt_received). Used as targetMessageId for hydra-acp/amend_prompt.
  currentHeadMessageId?: string;
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
  defaultAgent: string | null;
  defaultCwd: string | null;
  groupBy: "project" | "recent";
  showCold: boolean;
  banner: Banner;
  modal: ModalState;
  current: ChatState | null;
}
