import type { AgentDescriptor, AgentStatus, AgentStatusInfo } from '@shared/types'

interface Props {
  agent: AgentDescriptor | null
  info?: AgentStatusInfo
}

// `working` has an empty dot class: it renders as a marching-ants dashed
// square (inline SVG below), matching omp's own busy indicator.
const STATUS_STYLE: Record<AgentStatus, { dot: string; label: string }> = {
  starting: { dot: 'bg-zinc-400', label: 'Starting' },
  working: { dot: '', label: 'Working' },
  idle: { dot: 'bg-emerald-400', label: 'Idle' },
  stopped: { dot: 'bg-zinc-600', label: 'Stopped' },
  error: { dot: 'bg-red-500', label: 'Error' }
}

export function StatusBar({ agent, info }: Props) {
  if (!agent) {
    return <footer className="border-t border-zinc-800 bg-zinc-900 px-4 py-1.5 text-xs text-zinc-600" />
  }
  const style = STATUS_STYLE[info?.status ?? 'starting']
  return (
    <footer className="flex items-center gap-4 border-t border-zinc-800 bg-zinc-900 px-4 py-1.5 text-xs text-zinc-400">
      <span className="flex shrink-0 items-center gap-1.5">
        {info?.status === 'working' ? (
          <svg viewBox="0 0 8 8" className="h-2 w-2 shrink-0 text-amber-400" aria-label="working">
            <rect x="0.75" y="0.75" width="6.5" height="6.5" fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray="2 1.25">
              <animate attributeName="stroke-dashoffset" from="0" to="-3.25" dur="0.6s" repeatCount="indefinite" />
            </rect>
          </svg>
        ) : (
          <span className={`h-2 w-2 rounded-full ${style.dot}`} />
        )}
        {style.label}
      </span>
      {info?.lastTool && (
        <span className="shrink-0">
          tool: <span className="text-zinc-200">{info.lastTool}</span>
        </span>
      )}
      {info?.lastMessage && <span className="truncate opacity-70">{info.lastMessage}</span>}
      <span className="ml-auto shrink-0 truncate text-zinc-600">{agent.worktreePath}</span>
    </footer>
  )
}
