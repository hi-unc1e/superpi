import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { eventsFileFor } from './paths'
import { monitorHookPath } from './resources'
import type { AgentConfig, ModelOption } from '@shared/types'

const execFileAsync = promisify(execFile)

export interface PiLaunchConfig {
  /** argv passed to `pi`. */
  args: string[]
  env: NodeJS.ProcessEnv
}

/**
 * Builds the `omp` invocation for an agent:
 *   omp --session-dir <dir> -e <monitor-hook.ts> --append-system-prompt <worktree-isolation>
 *        [--model ..] [--thinking ..] [extraArgs]
 * with SUPERPI_* env so the hook can locate its per-agent events file and the
 * agent environment carries the worktree root for path isolation.
 * The --append-system-prompt injects a worktree isolation directive that
 * constrains the agent to relative paths and forbids touching main.
 */

/** Injected into every omp agent's system prompt so agents never touch the
 * main working tree — they work exclusively inside their sandboxed worktree.
 * The one escape hatch: explicit user permission to operate on main. */
const WORKTREE_ISOLATION_PROMPT =
`<worktree-isolation>
You are running inside a git worktree managed by superpi. The worktree root is at
$SUPERPI_WORKTREE.
- You MUST use only relative paths with every tool (read, edit, write, bash,
  grep, glob, ast_grep). Absolute paths bypass the worktree and hit the main
  working tree.
- You MUST NOT modify, read, or access files outside this worktree. The main
  branch is off-limits.
- The env var SUPERPI_WORKTREE carries the absolute worktree path. Harness
  tooling SHOULD reject any path that resolves outside this directory.
- Changes are committed to the worktree's branch, never to main. Merging
  happens separately — outside your scope.
- To work on the main branch (outside the worktree), you MUST ask the user
  for explicit permission first. Without such permission, operating outside
  the worktree is a violation of your constraints.
</worktree-isolation>`
export function buildPiLaunchConfig(
  agentId: string,
  sessionDir: string,
  worktreePath: string,
  config?: AgentConfig,
  resume?: boolean
): PiLaunchConfig {
  const args = ['--session-dir', sessionDir, '-e', monitorHookPath(), '--append-system-prompt', WORKTREE_ISOLATION_PROMPT]
  if (resume) args.push('--continue')
  if (config?.model) args.push('--model', config.model)
  if (config?.thinking) args.push('--thinking', config.thinking)
  if (config?.extraArgs) args.push(...splitArgs(config.extraArgs))
  if (config?.firstMessage && !resume) args.push(config.firstMessage)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SUPERPI: '1',
    SUPERPI_AGENT_ID: agentId,
    SUPERPI_EVENTS: eventsFileFor(agentId),
    SUPERPI_WORKTREE: worktreePath
  }
  return { args, env }
}

/**
 * Builds a `sh -lc` command that execs the agent binary (omp) with the given
 * args. A login shell loads PATH/profile so `omp` resolves; `exec` replaces the
 * shell so the PTY closes when the agent exits.
 */
/** Binary launched for each agent. Will become configurable. */
const AGENT_BIN = 'omp'

export function buildPiShellCommand(args: string[]): string {
  return 'exec ' + AGENT_BIN + ' ' + args.map(shellQuote).join(' ')
}

/** Builds a plain login shell command for terminal agents (no omp). */
export function buildPlainShellCommand(): string {
  return 'exec "$SHELL" -l'
}

/** In-flight/settled catalog fetch; cleared on failure so a retry can succeed. */
let modelsPromise: Promise<ModelOption[]> | null = null

/**
 * Lists models known to the agent binary via `omp models --json`, run through
 * a login shell so PATH matches how agents themselves are launched. Cached for
 * the process lifetime — the catalog only changes on `omp models refresh`.
 */
export function listModels(): Promise<ModelOption[]> {
  modelsPromise ??= execFileAsync('sh', ['-lc', AGENT_BIN + ' models --json'], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000
  }).then(
    ({ stdout }) => {
      const parsed = JSON.parse(stdout) as { models?: ModelOption[] }
      return (parsed.models ?? []).map(({ provider, id, selector, name }) => ({ provider, id, selector, name }))
    },
    (err) => {
      console.error('[superpi] omp models --json failed:', err)
      modelsPromise = null
      return []
    }
  )
  return modelsPromise
}

/** Split a user-typed arg string respecting simple single/double quoting. */
function splitArgs(s: string): string[] {
  const matches = s.match(/[^\s"']+|"([^"]*)"|'([^']*)'/g)
  return matches ? matches.map((t) => t.replace(/^["']|["']$/g, '')) : []
}

function shellQuote(s: string): string {
  if (s === '') return "''"
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

export function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}
