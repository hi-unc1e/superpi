// pi monitor hook — loaded into each agent via `pi -e <this file>`.
// Forwards agent lifecycle events as append-only JSONL to $SUPERPI_EVENTS,
// which the desktop app tails to render a read-only status panel.
//
// Runs inside pi's own process, where @oh-my-pi/pi-coding-agent is available.
// The type-only import is erased at transpile time.
import { appendFileSync } from 'node:fs'
import type { HookAPI } from '@oh-my-pi/pi-coding-agent/extensibility/hooks'

export default function monitor(pi: HookAPI): void {
  const out = process.env.SUPERPI_EVENTS
  if (!out) return

  const emit = (type: string, data: Record<string, unknown> = {}): void => {
    try {
      appendFileSync(out, JSON.stringify({ ts: Date.now(), type, data }) + '\n')
    } catch {
      /* events file unavailable — skip */
    }
  }

  pi.on('session_start', () => emit('session_start'))
  pi.on('turn_start', () => emit('turn_start'))
  pi.on('turn_end', () => emit('turn_end'))
  pi.on('agent_start', () => emit('agent_start'))
  pi.on('agent_end', () => emit('agent_end'))
  pi.on('tool_call', (e) => emit('tool_call', { tool: e.toolName }))
  pi.on('tool_result', (e) => {
    emit('tool_result', { tool: e.toolName, isError: e.isError })
    if (e.toolName === 'todo') {
      const phases = readTodoPhases(e.details)
      if (phases) emit('todo_state', { phases })
    }
  })
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

interface EmittedTask {
  content: string
  status: string
}
interface EmittedPhase {
  name: string
  tasks: EmittedTask[]
}

/** Validate the `todo` tool_result's `details.phases` before forwarding it.
 * omp guarantees the shape, but this hook's type import is erased at runtime,
 * so we narrow defensively — never trust an unchecked cast on tool data. */
function readTodoPhases(details: unknown): EmittedPhase[] | undefined {
  if (!isRecord(details) || !Array.isArray(details.phases)) return undefined
  const phases: EmittedPhase[] = []
  for (const raw of details.phases) {
    if (!isRecord(raw) || typeof raw.name !== 'string' || !Array.isArray(raw.tasks)) continue
    const tasks: EmittedTask[] = []
    for (const t of raw.tasks) {
      if (!isRecord(t) || typeof t.content !== 'string' || typeof t.status !== 'string') continue
      tasks.push({ content: t.content, status: t.status })
    }
    phases.push({ name: raw.name, tasks })
  }
  return phases
}
