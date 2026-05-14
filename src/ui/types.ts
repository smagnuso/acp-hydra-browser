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
  | "cancelled";

export interface QueueEntry {
  id: string;
  text: string;
  status: QueueStatus;
  aheadAtEnqueue: number;
  cancelled: boolean;
  started: boolean;
  waitResolver: (() => void) | null;
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
  _lastMetaFp: string;
  promptQueue: QueueEntry[];
  promptChain: Promise<void> | null;
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
