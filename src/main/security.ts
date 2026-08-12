/**
 * Centralized security-boundary helpers. Every privileged main-process mutation
 * (process launch, git init, worktree removal, file read/write, status watch)
 * routes its untrusted inputs through these pure validators so renderer-controlled
 * or persisted data can never escape the app-managed workspace/worktree sandbox.
 */
import { resolve, join } from 'node:path'
import { eventsFileFor, sessionDirFor, WORKTREE_SUBDIR } from './paths'
import type { AgentConfig } from '@shared/types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** True only for a canonical `randomUUID()` string — never a relative path or glob. */
export function isUuid(id: string): boolean {
  return UUID_RE.test(id)
}

/** Derives the app-managed session dir + events file for a UUID agent. Throws on
 * non-UUID so a poisoned persisted descriptor can never redirect status reads. */
export function expectedSessionPaths(id: string): { sessionDir: string; eventsFile: string } {
  if (!isUuid(id)) throw new Error(`Invalid agent id: ${id}`)
  return { sessionDir: sessionDirFor(id), eventsFile: eventsFileFor(id) }
}

/** The single legal worktree location: `<workspace>/.superpi/<id>`. Throws on
 * non-UUID so worktree removal can never be pointed elsewhere by persisted data. */
export function expectedWorktreePath(workspacePath: string, id: string): string {
  if (!isUuid(id)) throw new Error(`Invalid agent id: ${id}`)
  return join(resolve(workspacePath), WORKTREE_SUBDIR, id)
}

/** True only when the resolved worktree path is EXACTLY the managed location —
 * no prefix-only match, so `.superpi/<id>-evil` or a parent dir is rejected. */
export function isManagedWorktreePath(workspacePath: string, id: string, worktreePath: string): boolean {
  try {
    return resolve(worktreePath) === expectedWorktreePath(workspacePath, id)
  } catch {
    return false
  }
}

/** Returns the URL only for an http/https origin on the local loopback host;
 * null otherwise. This is the sole gate for dev-server renderer loading. */
export function isAllowedDevRendererUrl(raw: string | undefined): string | null {
  if (typeof raw !== 'string' || raw === '') return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.hostname
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') return null
  return raw
}

/** True only for plain http/https URLs — rejects file:, javascript:, custom
 * schemes, parse failures, and empty strings. Backs `shell.openExternal`. */
export function isAllowedExternalUrl(raw: string): boolean {
  if (raw === '') return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  return url.protocol === 'http:' || url.protocol === 'https:'
}

const THINKING_LEVELS: Record<string, true> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true
}

function optString(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined
  if (v.length > max) return undefined
  return v
}

/** Normalizes untrusted config JSON (persisted or renderer-supplied) into a clean
 * AgentConfig, or null if it is invalid. Drops legacy `extraArgs` and any unknown
 * field; bounds every string; validates thinking against the fixed level set. */
export function normalizeAgentConfig(input: unknown): AgentConfig | null {
  if (typeof input !== 'object' || input === null) return null
  const r = input as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id === '') return null
  if (typeof r.name !== 'string' || r.name.trim() === '' || r.name.length > 80) return null
  const model = optString(r.model, 200)
  const thinkingRaw = optString(r.thinking, 200)
  const thinking = thinkingRaw === undefined ? undefined : THINKING_LEVELS[thinkingRaw] ? thinkingRaw : null
  if (thinking === null) return null
  const baseBranch = optString(r.baseBranch, 200)
  const firstMessage = optString(r.firstMessage, 8000)
  const isDefault = r.isDefault === true ? true : undefined
  const out: AgentConfig = { id: r.id, name: r.name }
  if (model !== undefined) out.model = model
  if (thinking !== undefined) out.thinking = thinking
  if (baseBranch !== undefined) out.baseBranch = baseBranch
  if (firstMessage !== undefined) out.firstMessage = firstMessage
  if (isDefault !== undefined) out.isDefault = isDefault
  return out
}

const ENV_ALLOWLIST: Record<string, true> = {
  HOME: true,
  USER: true,
  LOGNAME: true,
  SHELL: true,
  PATH: true,
  TMPDIR: true,
  TEMP: true,
  TMP: true,
  LANG: true,
  LC_ALL: true,
  LC_CTYPE: true,
  TERM: true,
  COLORTERM: true
}

/** Names that smell like secrets. Even an allowlist addition must not leak these
 * from the parent process; only explicit Superpi-controlled `extras` may set them. */
const SECRET_RE = /TOKEN|KEY|SECRET|PASSWORD|PASS|AUTH|COOKIE|CREDENTIAL|GITHUB_|AWS_|OPENAI_|ANTHROPIC_|ELECTRON_RENDERER_URL/

/** Builds a launch environment from an allowlist of safe parent vars plus any
 * locale var matching `LC_[A-Z_]+`, then layers the Superpi-controlled `extras`
 * on top. Secret-like parent vars are never inherited; agent processes start
 * without provider credentials unless explicitly passed through. */
export function safeLaunchEnv(
  base: NodeJS.ProcessEnv,
  extras: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of Object.keys(ENV_ALLOWLIST)) {
    if (SECRET_RE.test(name)) continue
    const v = base[name]
    if (typeof v === 'string') out[name] = v
  }
  for (const name of Object.keys(base)) {
    if (!/^LC_[A-Z_]+$/.test(name)) continue
    if (SECRET_RE.test(name)) continue
    const v = base[name]
    if (typeof v === 'string') out[name] = v
  }
  for (const [k, v] of Object.entries(extras)) out[k] = v
  return out
}
