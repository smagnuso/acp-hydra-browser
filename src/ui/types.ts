// Shape definitions shared across UI modules. Kept loose where the wire
// data is variable (ACP notifications, agents, etc.) and tighter where
// behavior depends on it (queue entries, log items).

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  agentId?: string;
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
  requestId: string | number;
  toolCall: { title?: string; name?: string; [k: string]: unknown };
  options: Array<{ optionId: string; name?: string; kind?: string }>;
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
  | { kind: "perm"; requestId: string }
  | { kind: "plan"; entries: unknown };

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
  nextId?: number;
}

export interface SpawnModalData {
  kind: "spawn";
  cwd: string;
  agentId: string;
  name: string;
  prompt: string;
  err: string | null;
  busy: boolean;
}

export type ModalState =
  | SpawnModalData
  | { kind: "modes" }
  | { kind: "models" }
  | null;

export type Banner = { kind: "good" | "warn" | "bad"; text: string } | null;

export interface AppState {
  view: "list" | "chat";
  sessions: SessionInfo[];
  agents: AgentInfo[];
  groupBy: "project" | "recent";
  showCold: boolean;
  banner: Banner;
  modal: ModalState;
  current: ChatState | null;
}
