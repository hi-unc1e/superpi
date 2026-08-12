import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import type { AgentDescriptor, AgentKind } from '@shared/types'
import { AGENTS_FILE, APP_DIR, WORKTREE_SUBDIR } from './paths'
import { expectedSessionPaths, isManagedWorktreePath, isUuid } from './security'

/**
 * Persists all agents to ~/.superpi/agents.json and emits 'changed' for the
 * current workspace's agents whenever the set mutates.
 */
export class AgentStore extends EventEmitter {
  private agents = new Map<string, AgentDescriptor>()
  private workspace: string | null = null

  constructor() {
    super()
    mkdirSync(APP_DIR, { recursive: true })
    this.load()
  }

  /** Scopes list()/events to a workspace. Pass null to show none. */
  setWorkspace(path: string | null): void {
    this.workspace = path
    this.emit('changed', this.list())
  }

  private load(): void {
    if (!existsSync(AGENTS_FILE)) return
    try {
      const raw = JSON.parse(readFileSync(AGENTS_FILE, 'utf8'))
      if (!Array.isArray(raw)) return
      for (const entry of raw) {
        const validated = normalizeDescriptor(entry)
        if (validated) this.agents.set(validated.id, validated)
      }
    } catch {
      /* corrupt store — start fresh */
    }
  }

  private persist(): void {
    writeFileSync(AGENTS_FILE, JSON.stringify([...this.agents.values()], null, 2))
    this.emit('changed', this.list())
  }

  list(): AgentDescriptor[] {
    const all = [...this.agents.values()].sort((a, b) => a.createdAt - b.createdAt)
    return this.workspace ? all.filter((a) => a.workspacePath === this.workspace) : []
  }

  recentWorkspaces(): string[] {
    const seen = new Set<string>()
    for (const a of this.agents.values()) seen.add(a.workspacePath)
    return [...seen]
  }

  get(id: string): AgentDescriptor | undefined {
    return this.agents.get(id)
  }

  upsert(a: AgentDescriptor): void {
    const validated = normalizeDescriptor(a)
    if (!validated) throw new Error('Invalid agent descriptor.')
    this.agents.set(validated.id, validated)
    this.persist()
  }

  rename(id: string, name: string): AgentDescriptor | undefined {
    const a = this.agents.get(id)
    if (!a) return undefined
    a.name = name
    this.persist()
    return a
  }

  remove(id: string): AgentDescriptor | undefined {
    const a = this.agents.get(id)
    this.agents.delete(id)
    this.persist()
    return a
  }
}

/** Validate an untrusted/persisted agent descriptor at the JSON boundary.
 * Returns a clean descriptor with derived session paths, or null if invalid.
 * Never trusts persisted sessionDir/eventsFile/worktreePath values — they are
 * re-derived from the id/workspace and checked against the managed location. */
function normalizeDescriptor(input: unknown): AgentDescriptor | null {
  if (typeof input !== 'object' || input === null) return null
  const r = input as Record<string, unknown>
  // Primitive type checks.
  if (typeof r.id !== 'string' || !isUuid(r.id)) return null
  if (typeof r.name !== 'string') return null
  if (typeof r.configId !== 'string') return null
  if (typeof r.workspacePath !== 'string' || r.workspacePath === '') return null
  if (typeof r.worktreePath !== 'string' || r.worktreePath === '') return null
  if (typeof r.branch !== 'string') return null
  if (typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt)) return null
  // Kind: must be omp/terminal; missing normalizes to omp.
  let kind: AgentKind
  if (r.kind === undefined) kind = 'omp'
  else if (r.kind === 'omp' || r.kind === 'terminal') kind = r.kind
  else return null
  // Session paths are ALWAYS derived from the id — never trusted from disk.
  const { sessionDir, eventsFile } = expectedSessionPaths(r.id)
  // Worktree confinement per kind.
  const wsResolved = resolve(r.workspacePath)
  if (kind === 'omp') {
    if (!isManagedWorktreePath(r.workspacePath, r.id, r.worktreePath)) return null
    if (r.branch !== `superpi/${r.id.slice(0, 8)}`) return null
  } else {
    // Terminal cwd must be the workspace or live under its .superpi subdir.
    const wtResolved = resolve(r.worktreePath)
    const managedRoot = join(wsResolved, WORKTREE_SUBDIR)
    if (wtResolved !== wsResolved && !wtResolved.startsWith(managedRoot + '/')) return null
  }
  return {
    id: r.id,
    name: r.name,
    kind,
    configId: r.configId,
    workspacePath: r.workspacePath,
    worktreePath: r.worktreePath,
    branch: r.branch,
    sessionDir,
    eventsFile,
    createdAt: r.createdAt
  }
}
