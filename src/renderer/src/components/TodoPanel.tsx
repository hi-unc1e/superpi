import type { AgentDescriptor, TodoPhase, TodoStatus } from '@shared/types'

interface Props {
  agent: AgentDescriptor
  phases: TodoPhase[] | undefined
  onClose: () => void
}

/** Per-status checkbox + label styling. Static lookup → Record, not a function. */
const STATUS_STYLE: Record<TodoStatus, { box: string; text: string }> = {
  pending: { box: 'border-zinc-600', text: 'text-zinc-300' },
  in_progress: { box: 'border-amber-400 bg-amber-400/25', text: 'text-amber-100' },
  completed: { box: 'border-emerald-500 bg-emerald-500', text: 'text-zinc-500 line-through' },
  abandoned: { box: 'border-zinc-700', text: 'text-zinc-600 line-through' }
}

/**
 * Right-hand panel that renders an agent's todo list as IDE-style text
 * (proportional font, checkboxes — not a terminal). Backed by the `todoPhases`
 * captured from omp's `todo` tool results; live-updates as the agent mutates it.
 */
export function TodoPanel({ agent, phases, onClose }: Props) {
  const tasks = phases?.flatMap((p) => p.tasks) ?? []
  const done = tasks.filter((t) => t.status === 'completed').length
  const empty = !phases || phases.length === 0

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-zinc-800 bg-zinc-900">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Task list</div>
          <div className="truncate text-sm text-zinc-100" title={agent.name}>
            {agent.name}
          </div>
        </div>
        <button onClick={onClose} aria-label="Close task list" className="text-zinc-500 hover:text-zinc-300">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="h-4 w-4">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {empty ? (
          <p className="text-sm leading-relaxed text-zinc-500">
            No task list yet. The agent&apos;s plan will appear here once it creates one with the{' '}
            <span className="font-mono text-zinc-400">todo</span> tool.
          </p>
        ) : (
          <>
            <div className="mb-3 text-[11px] text-zinc-500">
              {done}/{tasks.length} done
            </div>
            {phases!.map((phase) => {
              const phaseDone = phase.tasks.filter((t) => t.status === 'completed').length
              return (
                <div key={phase.name} className="mb-4 last:mb-0">
                  <div className="mb-1 flex items-baseline gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{phase.name}</span>
                    <span className="text-[10px] text-zinc-600">
                      {phaseDone}/{phase.tasks.length}
                    </span>
                  </div>
                  <ul className="space-y-0.5">
                    {phase.tasks.map((task) => {
                      const s = STATUS_STYLE[task.status]
                      return (
                        <li key={task.content} className="flex items-start gap-2 py-0.5 text-sm leading-snug">
                          <span className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border ${s.box}`}>
                            {task.status === 'completed' && (
                              <svg viewBox="0 0 16 16" className="h-3 w-3 text-white" fill="none" stroke="currentColor" strokeWidth={2.5}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M3.5 8.5l3 3 6-6.5" />
                              </svg>
                            )}
                            {task.status === 'in_progress' && <span className="h-1 w-2 rounded-[1px] bg-amber-400" />}
                            {task.status === 'abandoned' && (
                              <svg viewBox="0 0 16 16" className="h-2.5 w-2.5 text-zinc-500" fill="none" stroke="currentColor" strokeWidth={2.5}>
                                <path strokeLinecap="round" d="M4 8h8" />
                              </svg>
                            )}
                          </span>
                          <span className={`min-w-0 break-words ${s.text}`}>{task.content}</span>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )
            })}
          </>
        )}
      </div>
    </aside>
  )
}
