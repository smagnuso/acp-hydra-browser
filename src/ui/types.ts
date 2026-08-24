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

// One pasted image, ready to be sent as an ACP image content block. data is
// base64-encoded raw bytes; mimeType matches. name/sizeBytes are
// display-only — the outgoing wire block only carries data + mimeType.
export interface Attachment {
  mimeType: string;
  data: string;
  name?: string;
  sizeBytes: number;
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

// One background job the agent is running right now (Monitor, backgrounded
// Bash), as the daemon reports it via hydra-acp/session/armed_tasks_updated.
// Outlives the turn that armed it — see PROTOCOL.md "Armed tasks (the third
// session state)". Level-sourced entries (claude-acp) carry taskId/taskType
// but no toolCallId; edge-inferred entries (other agents) carry toolCallId
// but taskId only once an update reveals it. Always REPLACE, never merge.
export interface ArmedTask {
  label: string;
  taskId?: string;
  taskType?: string;
  toolCallId?: string;
  since: number;
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
  | "amended"
  // The WS wasn't open at submit time, so this was never actually sent
  // — held locally (see offline-queue.ts) and persisted so it survives
  // a relaunch, not just a reconnect. queue.ts's flushOfflineQueue
  // dispatches it for real the next time the socket comes up, at which
  // point it transitions to "queued"/"pending" like any other send.
  | "offline";

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
  // Images submitted alongside `text`. Carried on the entry (not just the
  // log item) so amend/steer resends and rollback can rebuild the same
  // content blocks without re-threading them through every call site.
  attachments?: Attachment[];
  // Status to restore when an inline edit is saved or abandoned. Set
  // when entering "editing", which overwrites the real status and would
  // otherwise be unrecoverable. Defaults to "queued" when unset, which
  // is what the server-side queued/pending chip wants; an "offline"
  // entry must set it, or saving an edit would silently promote it to
  // "queued" and flushOfflineQueue (which only looks for "offline")
  // would never send it.
  editReturnStatus?: QueueStatus;
  // Set on an entry flushed out of the offline hold *while a turn was
  // still streaming*. That turn can keep appending new log items (tool
  // calls, a fresh bubble after one) below the flushed prompt, so its
  // bubble needs a second re-seat once that turn finishes. Fired from
  // finalizeTurn, deliberately not from this prompt's own "started"
  // notification: "started" can arrive after the agent has already begun
  // replying, and re-seating then drops the bubble below its own answer.
  reseatAfterCurrentTurn?: boolean;
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
      // Images attached at submit time (pasted into the composer). Kept on
      // the log item so the sent bubble shows what was actually attached,
      // independent of the composer's current draft.
      attachments?: Attachment[];
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
  // Images pasted into the composer, waiting to go out with the next send.
  // Cleared on submit; restored by rollbackAmend if an amend is rejected.
  attachments: Attachment[];
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
  // Application-level heartbeat (see bridge.ts's startHeartbeat/sendPing).
  // readyState and navigator.onLine can both keep reporting "fine" for a
  // while after the connection is actually dead (observed on iOS Safari:
  // navigator.onLine is well known to be unreliable there, especially in
  // standalone PWA mode) — connectionHealthy is the signal queue.ts's
  // offline detection actually trusts, flipped false the moment a ping
  // goes unanswered rather than waiting on the socket to notice on its
  // own. heartbeatTimer schedules the next ping; heartbeatDeadline is
  // the "no pong in time" timeout, cleared the moment a pong lands.
  connectionHealthy: boolean;
  heartbeatTimer?: ReturnType<typeof setTimeout>;
  heartbeatDeadline?: ReturnType<typeof setTimeout>;
  // Whether the chat-header's detail panel (full title/cwd/agent/model,
  // untruncated) is expanded. Toggled by clicking the header's info block.
  headerExpanded: boolean;
  // Whether renderChat has already tried auto-focusing the composer for
  // this ChatState. One-shot so it fires on the chat's first render
  // (nothing else has had a chance to take focus yet) and never again —
  // renderChat runs on nearly every render while a turn streams, and
  // refocusing every time would rip focus away from anything else the
  // user clicked into (a modal, a queue chip's inline editor). See
  // dom.ts's isDesktopPointer: only desktop gets this, since a virtual
  // keyboard popping up unasked is a real cost mobile doesn't have.
  composerAutoFocused?: boolean;
  // Whether to render the full log rather than just the most recent
  // window (see CHAT_LOG_RENDER_WINDOW in views.ts). A long-running
  // session's full history is thousands of markdown-rendered DOM nodes,
  // and building all of it synchronously on attach is what made entering
  // a big session feel frozen with scrolling unresponsive — capping the
  // initial paint to the recent tail avoids that; "show earlier" flips
  // this to true for the rest of the ChatState's life.
  renderAllHistory?: boolean;
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
  // The armed set itself (names, per-task elapsed), not just the count.
  // Same seeding/replace rules as armedTasks/armedSince. Undefined means
  // "no list known yet" (daemon too old, or not seeded); [] means "seeded,
  // nothing armed".
  armedTaskList?: ArmedTask[];
  // Live hydra_compaction phase, from session/update notifications. Mirrors
  // the TUI's persistent compactionIndicator (app.ts handleCompactionUpdate):
  // set on "started"/"iteration" ("running") and "deferred" ("deferred"),
  // cleared on "swapped"/"failed"/"rolled_back" — deliberately NOT on
  // "converged", which can arrive before or after the terminal swap.
  // Undefined means "not compacting".
  compactionPhase?: "running" | "deferred";
  // Full config-option snapshot (model/mode/agent plus whatever the
  // agent advertises, e.g. effort). See config_option_update handling
  // in acp.ts. Empty until the first snapshot arrives.
  configOptions: ConfigOption[];
  // messageId of the last recordable (non state-kind) session/update we
  // processed. Sent back as afterMessageId on the next reconnect so the
  // bridge can ask the daemon for a delta replay instead of a full one —
  // see routing.ts's connectChatSocket and bridge.ts's handling of
  // bridge/replay_policy. Undefined until the first recordable update
  // arrives, which also means the very first attach always gets "full".
  lastSeenMessageId?: string;
  // True when log[] was seeded from the local history-cache.ts cache
  // rather than a full session/attach replay — meaning there may be
  // older history on the daemon that we don't have, since the cache is
  // itself capped (see history-cache.ts's MAX_BYTES_PER_SESSION). Drives
  // the "load full history" button views.ts shows once the user has
  // scrolled to the top of what's locally available. Cleared by
  // routing.ts's requestFullHistory once a genuine full replay lands.
  historyIsPartial?: boolean;
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
  | { kind: "options" }
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
  // Fire a system notification when a turn THIS tab submitted finishes
  // while the tab isn't visible/focused. Persisted globally like
  // hideThoughts. See notifications.ts — gated on Notification
  // permission, which the checkbox requests when first turned on.
  notifyOnTurnEnd: boolean;
  // Host filter selection for the session list. "__local" hides every
  // imported session; "__all" hides nothing; any other value filters
  // to sessions whose importedFromMachine matches.
  hostFilter: string;
  // Keyboard-nav cursor for the session list (Up/Down + Enter). By id
  // rather than index so it survives a reorder/poll refresh instead of
  // silently pointing at whatever session happens to now be in that
  // slot. Null means no keyboard selection is active.
  listHighlightedSessionId: string | null;
  banner: Banner;
  modal: ModalState;
  current: ChatState | null;
  // sessionId of the chat most recently backed out of via closeChat().
  // Lets the list view's swipe-back gesture (swipe-nav.ts) jump straight
  // back in without the user hunting for the card again. Not persisted —
  // resets on reload same as any other in-memory nav state.
  lastSessionId: string | null;
}
