import { app, type BrowserWindow, dialog, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import simpleGit from 'simple-git'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import type {
  AgentConfig,
  AgentDescriptor,
  ConflictResolution,
  CreateAgentOptions,
  GitLogEntry,
  TerminalAttachResult,
  WorktreeActionResult,
  WorktreeDiff,
  WorktreeGitState,
  WorkspaceInfo
} from '@shared/types'
import { sessionDirFor } from './paths'
import {
  abortRebase,
  commitWorktree,
  continueRebase,
  getConflictInfo,
  getLog,
  getWorktreeDiff,
  getWorktreeGraph,
  getWorktreeUnifiedDiff,
  initRepo,
  mergeWorktreeToMain,
  readWorktreeFile,
  rebaseWorktree,
  resolveConflictFile,
  resolveMainBranch
} from './git'
import type { AgentStore } from './agents'
import type { ConfigStore } from './configs'
import type { StatusWatcher } from './status'
import type { TerminalManager } from './terminal'
import { type WorktreeManager, linkNodeModules } from './worktree'
import type { WorkspaceController } from './workspace'
import { listModels } from './pi'
import { expectedSessionPaths, isAllowedDevRendererUrl, isManagedWorktreePath } from './security'

export interface Ctx {
  agents: AgentStore
  configs: ConfigStore
  worktrees: WorktreeManager
  terminals: TerminalManager
  status: StatusWatcher
  workspace: WorkspaceController
}

function requireWorkspace(c: Ctx): WorkspaceInfo {
  const ws = c.workspace.current
  if (!ws) throw new Error('No folder is open.')
  if (!ws.isGit) throw new Error('This folder is not a git repository. Initialize one first.')
  return ws
}

export function registerIpc(win: BrowserWindow, c: Ctx): void {
  /** Trust boundary: every IPC mutation must arrive from this window's main frame
   * and from the expected origin (bundled file: renderer in production, or an
   * allowed dev localhost URL in development). Stops a remote/child frame from
   * driving the privileged preload API if a window-loading bug ever reappears. */
  function assertTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): void {
    if (event.sender !== win.webContents) throw new Error('Rejected IPC from untrusted renderer.')
    const url = event.senderFrame?.url ?? ''
    if (app.isPackaged) {
      if (!url.startsWith('file://')) throw new Error('Rejected IPC from untrusted renderer.')
    } else {
      if (!url.startsWith('file://') && isAllowedDevRendererUrl(url) === null) {
        throw new Error('Rejected IPC from untrusted renderer.')
      }
    }
  }

  // ---- Workspace ----
  ipcMain.handle('workspace:get', (event) => {
    assertTrustedSender(event)
    return c.workspace.current
  })
  ipcMain.handle('workspace:recentFolders', (event) => {
    assertTrustedSender(event)
    return c.agents.recentWorkspaces()
  })

  ipcMain.handle('workspace:open', async (event): Promise<WorkspaceInfo | null> => {
    assertTrustedSender(event)
    const res = await dialog.showOpenDialog({ title: 'Open folder', properties: ['openDirectory'] })
    if (res.canceled || res.filePaths.length === 0) return null
    const path = res.filePaths[0]
    const ws = await c.workspace.set(path)
    c.agents.setWorkspace(path)
    return ws
  })

  ipcMain.handle('workspace:openPath', async (event, path: string): Promise<WorkspaceInfo> => {
    assertTrustedSender(event)
    const ws = await c.workspace.set(path)
    c.agents.setWorkspace(path)
    return ws
  })

  // initGit initializes ONLY the currently open workspace — the renderer path
  // argument is ignored entirely so a compromised renderer can't git-init (and
  // thus gain worktree-creation reach into) an arbitrary directory.
  ipcMain.handle('workspace:initGit', async (event): Promise<WorkspaceInfo> => {
    assertTrustedSender(event)
    const ws = c.workspace.current
    if (!ws) throw new Error('No workspace open')
    await initRepo(ws.path)
    const refreshed = await c.workspace.refresh()
    if (!refreshed) throw new Error('No workspace open')
    return refreshed
  })

  // ---- Git ----
  ipcMain.handle('git:log', async (event): Promise<GitLogEntry[]> => {
    assertTrustedSender(event)
    const ws = requireWorkspace(c)
    return getLog(ws.path)
  })

  // ---- Agents (worktrees in the current workspace) ----
  ipcMain.handle('agent:list', (event) => {
    assertTrustedSender(event)
    return c.agents.list()
  })

  ipcMain.handle(
    'agent:create',
    async (event, opts: CreateAgentOptions): Promise<AgentDescriptor> => {
      assertTrustedSender(event)
      if (typeof opts !== 'object' || opts === null) throw new Error('Invalid agent options.')
      const ws = requireWorkspace(c)
      const kind = opts.kind ?? 'omp'
      if (kind !== 'omp' && kind !== 'terminal') throw new Error('Invalid agent kind.')
      const isTerminal = kind === 'terminal'

      const config = isTerminal
        ? { id: '', name: 'Terminal', isDefault: false }
        : (opts.configId ? c.configs.get(opts.configId) : c.configs.default())
      if (!config && !isTerminal) throw new Error('No agent config available.')

      const id = randomUUID()
      const { sessionDir, eventsFile } = expectedSessionPaths(id)
      mkdirSync(sessionDir, { recursive: true })
      const shortId = id.slice(0, 6)
      const defaultName = isTerminal ? `sh-${shortId}` : `omp-${shortId}`
      const name = opts.name && opts.name.trim() ? opts.name.trim() : defaultName

      let worktreePath: string
      let branch: string
      if (isTerminal) {
        // Terminal cwd is resolved in main from a constrained enum — never from
        // a raw renderer path.
        if (opts.terminalTarget === undefined) throw new Error('Terminal agents require a terminal target.')
        if (opts.terminalTarget === 'workspace') {
          worktreePath = ws.path
        } else {
          const targetId = opts.terminalTarget.agentId
          const target = c.agents.list().find((a) => a.id === targetId)
          if (!target) throw new Error('Unknown terminal target agent.')
          worktreePath = target.worktreePath
        }
        // Informational branch for the header graph; best-effort read-only.
        try {
          const ref = (await simpleGit(worktreePath).revparse(['--abbrev-ref', 'HEAD'])).trim()
          branch = ref && ref !== 'HEAD' ? ref : 'main'
        } catch {
          branch = 'main'
        }
      } else {
        // OMP agents must not carry a terminal target; they always get a fresh
        // managed worktree under <workspace>/.superpi/<id>.
        if (opts.terminalTarget !== undefined) throw new Error('OMP agents do not accept a terminal target.')
        const info = await c.worktrees.create(ws.path, id, config?.baseBranch)
        worktreePath = info.worktreePath
        branch = info.branch
        linkNodeModules(ws.path, worktreePath)
      }
      const desc: AgentDescriptor = {
        id,
        name,
        kind,
        configId: config?.id ?? '',
        workspacePath: ws.path,
        worktreePath,
        branch,
        sessionDir,
        eventsFile,
        createdAt: Date.now()
      }
      if (!isTerminal) writeFileSync(desc.eventsFile, '')
      c.agents.upsert(desc)
      c.terminals.spawn(id, worktreePath, sessionDir, kind, config)
      if (!isTerminal) c.status.watch(id)
      return desc
    }
  )

  ipcMain.handle('agent:remove', async (event, id: string): Promise<void> => {
    assertTrustedSender(event)
    const a = c.agents.get(id)
    if (a) {
      c.terminals.kill(id)
      c.status.unwatch(id)
      // Only OMP agents that own a managed worktree may have it deleted — and
      // only when it is exactly <workspace>/.superpi/<id>. Terminals never
      // delete their cwd (which is the workspace or another agent's worktree).
      if (a.kind === 'omp' && isManagedWorktreePath(a.workspacePath, a.id, a.worktreePath)) {
        const others = c.agents.list().filter((x) => x.id !== id)
        if (!others.some((x) => x.worktreePath === a.worktreePath)) {
          await c.worktrees.remove(a.workspacePath, a.id, a.branch)
        }
      }
    }
    c.agents.remove(id)
    // Clean up the derived session directory (events, lock, session .jsonl).
    try { rmSync(sessionDirFor(id), { recursive: true, force: true }) } catch { /* ignore */ }
  })

  ipcMain.handle('agent:rename', async (event, id: string, name: string): Promise<void> => {
    assertTrustedSender(event)
    const a = c.agents.rename(id, name)
    if (!a) throw new Error(`Agent not found: ${id}`)
  })

  ipcMain.handle('agent:revive', async (event, id: string): Promise<void> => {
    assertTrustedSender(event)
    if (c.terminals.has(id) || c.terminals.isOwnedByOther(id)) return
    const a = c.agents.get(id)
    if (!a) throw new Error(`Agent not found: ${id}`)
    const config = c.configs.get(a.configId) ?? c.configs.default()
    c.terminals.spawn(id, a.worktreePath, a.sessionDir, a.kind, config, 100, 30, true)
    if (a.kind !== 'terminal') c.status.watch(id, { replay: true })
  })

  // ---- Configs ----
  ipcMain.handle('config:list', (event) => {
    assertTrustedSender(event)
    return c.configs.list()
  })
  ipcMain.handle('config:default', (event) => {
    assertTrustedSender(event)
    return c.configs.default()
  })
  ipcMain.handle('config:save', (event, cfg: AgentConfig) => {
    assertTrustedSender(event)
    return c.configs.save(cfg)
  })
  ipcMain.handle('config:delete', (event, id: string) => {
    assertTrustedSender(event)
    return c.configs.delete(id)
  })
  ipcMain.handle('models:list', (event) => {
    assertTrustedSender(event)
    return listModels()
  })

  // ---- Terminal + status ----
  ipcMain.on('terminal:input', (event, id: string, data: string) => {
    assertTrustedSender(event)
    c.terminals.write(id, data)
  })
  ipcMain.on('terminal:resize', (event, id: string, cols: number, rows: number) => {
    assertTrustedSender(event)
    c.terminals.resize(id, cols, rows)
  })
  ipcMain.handle('terminal:attach', (event, id: string): TerminalAttachResult | null => {
    assertTrustedSender(event)
    // Forwarding follows the viewed terminal: attaching switches it, and the
    // ring snapshot returned below covers everything sent so far.
    // Already have a PTY? Return current state.
    const size = c.terminals.size(id)
    if (size) {
      c.terminals.setAttached(id)
      return { ring: c.terminals.ring(id), cols: size.cols, rows: size.rows, remote: false }
    }

    // No PTY. Another instance owns it? Tell the renderer.
    if (c.terminals.isOwnedByOther(id)) {
      c.terminals.setAttached(null)
      return { ring: '', cols: 100, rows: 30, remote: true }
    }

    // No owner — respawn from the persisted descriptor. A descriptor whose
    // worktree no longer exists is a stale entry (removed elsewhere): don't
    // spawn a PTY into a missing cwd.
    const agent = c.agents.get(id)
    if (!agent || !existsSync(agent.worktreePath)) return null

    const config = c.configs.get(agent.configId)
    c.terminals.spawn(id, agent.worktreePath, agent.sessionDir, agent.kind, config)
    if (agent.kind !== 'terminal') c.status.watch(id, { replay: true })

    const sz = c.terminals.size(id)
    if (!sz) return null
    c.terminals.setAttached(id)
    return { ring: c.terminals.ring(id), cols: sz.cols, rows: sz.rows, remote: false }
  })
  ipcMain.handle('status:get', (event, id: string) => {
    assertTrustedSender(event)
    return c.status.snapshot(id)
  })

  // ---- Worktree git (graph + actions) ----
  ipcMain.handle('worktree:gitState', async (event, id: string): Promise<WorktreeGitState | null> => {
    assertTrustedSender(event)
    const a = c.agents.get(id)
    if (!a) return null
    try {
      const [graph, diff, conflicts] = await Promise.all([
        getWorktreeGraph(a.worktreePath, a.branch),
        getWorktreeDiff(a.worktreePath),
        getConflictInfo(a.worktreePath)
      ])
      return { graph, diff, conflicts }
    } catch {
      return null
    }
  })

  ipcMain.handle('worktree:diff', async (event, id: string): Promise<WorktreeDiff> => {
    assertTrustedSender(event)
    const a = c.agents.get(id)
    if (!a) return { files: [] }
    return getWorktreeUnifiedDiff(a.worktreePath)
  })

  ipcMain.handle('worktree:commit', async (event, id: string, message: string): Promise<WorktreeActionResult> => {
    assertTrustedSender(event)
    const a = c.agents.get(id)
    if (!a) return { ok: false, error: `Agent not found: ${id}` }
    try {
      await commitWorktree(a.worktreePath, message)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('worktree:merge', async (event, id: string): Promise<WorktreeActionResult> => {
    assertTrustedSender(event)
    const a = c.agents.get(id)
    if (!a) return { ok: false, error: `Agent not found: ${id}` }
    try {
      const main = await resolveMainBranch(a.workspacePath)
      if (!main) return { ok: false, error: 'No main/master branch found to merge into.' }
      await mergeWorktreeToMain(a.workspacePath, a.branch, main)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('worktree:rebase', async (event, id: string): Promise<WorktreeActionResult> => {
    assertTrustedSender(event)
    const a = c.agents.get(id)
    if (!a) return { ok: false, error: `Agent not found: ${id}` }
    try {
      const main = await resolveMainBranch(a.workspacePath)
      if (!main) return { ok: false, error: 'No main/master branch found to rebase onto.' }
      await rebaseWorktree(a.worktreePath, main)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('worktree:readFile', (event, id: string, path: string): string | null => {
    assertTrustedSender(event)
    const a = c.agents.get(id)
    if (!a) return null
    try {
      return readWorktreeFile(a.worktreePath, path)
    } catch {
      return null
    }
  })

  ipcMain.handle('worktree:resolveConflict', async (event, id: string, path: string, resolution: ConflictResolution): Promise<WorktreeActionResult> => {
    assertTrustedSender(event)
    const a = c.agents.get(id)
    if (!a) return { ok: false, error: `Agent not found: ${id}` }
    try {
      await resolveConflictFile(a.worktreePath, path, resolution)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('worktree:rebaseContinue', async (event, id: string): Promise<WorktreeActionResult> => {
    assertTrustedSender(event)
    const a = c.agents.get(id)
    if (!a) return { ok: false, error: `Agent not found: ${id}` }
    try {
      await continueRebase(a.worktreePath)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('worktree:rebaseAbort', async (event, id: string): Promise<WorktreeActionResult> => {
    assertTrustedSender(event)
    const a = c.agents.get(id)
    if (!a) return { ok: false, error: `Agent not found: ${id}` }
    try {
      await abortRebase(a.worktreePath)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ---- Window controls ----
  ipcMain.on('window:minimize', (event) => {
    assertTrustedSender(event)
    win.minimize()
  })
  ipcMain.on('window:maximize', (event) => {
    assertTrustedSender(event)
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('window:close', (event) => {
    assertTrustedSender(event)
    win.close()
  })
  ipcMain.handle('window:isMaximized', (event) => {
    assertTrustedSender(event)
    return win.isMaximized()
  })
}
