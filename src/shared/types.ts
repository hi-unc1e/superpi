// Shared IPC contract between main process, preload bridge, and renderer.

/** The folder the user opened as their workspace. May or may not be git. */
export interface WorkspaceInfo {
  path: string
  isGit: boolean
}

/** A worktree-backed agent running pi inside the workspace. */
export interface AgentDescriptor {
  id: string
  name: string
  /** Config preset used to launch this agent (empty for terminal agents). */
  configId: string
  /** Agent kind: omp coding agent or plain terminal shell. */
  kind: AgentKind
  /** Workspace folder the worktree belongs to. */
  workspacePath: string
  /** Absolute path of the worktree checkout. */
  worktreePath: string
  /** Branch checked out in the worktree. */
  branch: string
  /** App-managed pi --session-dir (holds session .jsonl). */
  sessionDir: string
  /** Monitor-hook output path (append-only JSONL events). */
  eventsFile: string
  createdAt: number
}

export type AgentKind = 'omp' | 'terminal'

export type AgentStatus = 'starting' | 'working' | 'idle' | 'stopped' | 'error'
/** Lifecycle status of a single todo task, mirroring omp's `todo` tool. */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'abandoned'

/** One task in an agent's todo list. */
export interface TodoItem {
  content: string
  status: TodoStatus
}

/** A named group of todo tasks — a phase/section of the agent's plan. */
export interface TodoPhase {
  name: string
  tasks: TodoItem[]
}

export interface AgentStatusInfo {
  agentId: string
  status: AgentStatus
  /** Last assistant text snippet, best-effort from the session file. */
  lastMessage?: string
  /** Last tool the agent invoked. */
  lastTool?: string
  model?: string
  contextUsagePct?: number
  /** Latest todo list, captured from omp's `todo` tool results (undefined until
   * the agent first invokes the `todo` tool in this session). */
  todoPhases?: TodoPhase[]
  updatedAt: number
}

/** A named launch preset for agents. */
export interface AgentConfig {
  id: string
  name: string
  /** pi --model pattern (provider/id or glob). */
  model?: string
  /** pi --thinking level. */
  thinking?: string
  /** Branch/commit the worktree starts from. */
  baseBranch?: string
  /** Extra pi args, space-separated and shell-safe on our side. */
  extraArgs?: string
  /** First prompt sent when the agent starts a fresh session (positional arg
   * to omp). Sent only on initial launch — never when reviving or resuming. */
  firstMessage?: string
  /** Exactly one config is the default used by +New. */
  isDefault?: boolean
}

/** A single git commit entry returned by gitLog. */
export interface GitLogEntry {
  hash: string
  author: string
  date: string
  message: string
  refs: string
}

/** A commit on the worktree branch ahead of main. */
export interface WorktreeCommit {
  hash: string
  subject: string
}

/** Position of a worktree branch relative to main, for the header graph. */
export interface WorktreeGraph {
  /** Branch checked out in the worktree (e.g. superpi/abc123). */
  branch: string
  /** Resolved integration target (main / master / …). */
  mainBranch: string
  /** Commits on the branch not on main, oldest → newest (last is HEAD). */
  ahead: WorktreeCommit[]
  /** Commits on main not on the branch. */
  behind: number
  /** Short hash of the merge-base (common ancestor), '' if none. */
  baseHash: string
}

/** Uncommitted line changes in the worktree (working tree vs HEAD). */
export interface WorktreeDiffStat {
  added: number
  deleted: number
  files: number
  /** True if anything is uncommitted (staged, unstaged, or untracked). */
  hasChanges: boolean
}

/** One line of a unified diff for a worktree file (working tree vs HEAD). */
export interface WorktreeDiffLine {
  type: 'add' | 'del' | 'context'
  oldNo?: number
  newNo?: number
  text: string
}

/** A contiguous `@@ ... @@` hunk inside a file diff. */
export interface WorktreeDiffHunk {
  header: string
  lines: WorktreeDiffLine[]
}

/** A single file's diff against HEAD, parsed for the IDE-style diff view. */
export interface WorktreeDiffFile {
  path: string
  added: number
  deleted: number
  binary: boolean
  hunks: WorktreeDiffHunk[]
}

/** Structured worktree changes vs HEAD for the diff panel. */
export interface WorktreeDiff {
  files: WorktreeDiffFile[]
}
/** Unmerged state of a worktree: paused rebase + conflicted paths. */
export interface ConflictInfo {
  /** True when a rebase is paused in this worktree (rebase-merge/rebase-apply exists). */
  rebasing: boolean
  /** Paths with unmerged index entries, relative to the worktree root. */
  files: string[]
}

/** How to resolve one conflicted file: keep a side wholesale, or provide the
 * final content (edited by hand in the Conflicts panel). */
export type ConflictResolution = 'ours' | 'theirs' | { content: string }

/** Snapshot of a worktree's git state for the terminal header. */
export interface WorktreeGitState {
  graph: WorktreeGraph
  diff: WorktreeDiffStat
  conflicts: ConflictInfo
}

/** Outcome of a worktree git action (commit/merge/rebase). The error is returned
 * rather than thrown so it surfaces in the UI without polluting the main log. */
export interface WorktreeActionResult {
  ok: boolean
  error?: string
}

/** Surface exposed on window.superpi via the preload contextBridge. */
export interface SuperpiAPI {
  // Workspace
  getWorkspace(): Promise<WorkspaceInfo | null>
  openFolder(): Promise<WorkspaceInfo | null>
  openPath(path: string): Promise<WorkspaceInfo>
  initGit(path: string): Promise<WorkspaceInfo>
  listRecentFolders(): Promise<string[]>
  gitLog(): Promise<GitLogEntry[]>
  onWorkspaceChanged(cb: (ws: WorkspaceInfo | null) => void): () => void

  // Agents (worktrees in the current workspace)
  listAgents(): Promise<AgentDescriptor[]>
  createAgent(opts: { configId?: string; name?: string; kind?: AgentKind; cwdPath?: string }): Promise<AgentDescriptor>
  removeAgent(id: string): Promise<void>
  renameAgent(id: string, name: string): Promise<void>
  onAgentListChanged(cb: (agents: AgentDescriptor[]) => void): () => void
  reviveAgent(id: string): Promise<void>

  // Configs
  listConfigs(): Promise<AgentConfig[]>
  saveConfig(cfg: AgentConfig): Promise<AgentConfig>
  deleteConfig(id: string): Promise<AgentConfig[]>
  getDefaultConfig(): Promise<AgentConfig>

  // Terminal + status
  terminalAttach(id: string): Promise<TerminalAttachResult | null>
  terminalInput(id: string, data: string): Promise<void>
  terminalResize(id: string, cols: number, rows: number): Promise<void>
  getStatus(id: string): Promise<AgentStatusInfo | null>
  onTerminalData(cb: (id: string, data: string) => void): () => void
  onStatusChanged(cb: (info: AgentStatusInfo) => void): () => void

  // Worktree git (graph + actions on the worktree branch)
  worktreeGitState(id: string): Promise<WorktreeGitState | null>
  getWorktreeDiff(id: string): Promise<WorktreeDiff>
  commitWorktree(id: string, message: string): Promise<WorktreeActionResult>
  mergeWorktreeToMain(id: string): Promise<WorktreeActionResult>
  rebaseWorktree(id: string): Promise<WorktreeActionResult>
  readWorktreeFile(id: string, path: string): Promise<string | null>
  resolveConflict(id: string, path: string, resolution: ConflictResolution): Promise<WorktreeActionResult>
  rebaseContinue(id: string): Promise<WorktreeActionResult>
  rebaseAbort(id: string): Promise<WorktreeActionResult>

  // Window controls
  windowMinimize(): Promise<void>
  windowMaximize(): Promise<void>
  windowClose(): Promise<void>
  windowIsMaximized(): Promise<boolean>
  onWindowMaximizedChanged(cb: (maximized: boolean) => void): () => void
}

/** Returned by terminalAttach. When `remote` is true, the PTY is owned by
 * another superpi instance and the terminal is unavailable here. */
export interface TerminalAttachResult {
  ring: string
  cols: number
  rows: number
  /** True when another superpi instance owns this agent's PTY. */
  remote: boolean
}
