import type { AgentDescriptor, AgentStatusInfo } from '@shared/types'
import { CONFIGS_TAB_ID, GITLOG_TAB_ID, useWorkbench } from '../lib/workbench'

// Unlike the sidebar's STATUS_DOT (which renders `working` as a marching-ants
// SVG), tabs are too small for an animated indicator — `working` gets a dot.
const TAB_DOT: Record<string, string> = {
  starting: 'bg-zinc-400',
  working: 'bg-amber-400',
  idle: 'bg-emerald-400',
  stopped: 'bg-zinc-600',
  error: 'bg-red-500'
}

/** Labels for the reserved non-agent tabs; anything else is an agent id. */
const SPECIAL_TAB_LABEL: Record<string, string> = {
  [CONFIGS_TAB_ID]: 'Config',
  [GITLOG_TAB_ID]: 'Git log'
}

/** Tab bar above the terminal pane: one tab per open agent. Click activates,
 * middle-click or the × closes the tab (never the agent). */
export function TabStrip({
  agents,
  statuses
}: {
  agents: AgentDescriptor[]
  statuses: Record<string, AgentStatusInfo>
}) {
  const { tabs, activeTabId, activateTab, closeTab } = useWorkbench()
  if (tabs.length === 0) return null
  return (
    <div className="flex shrink-0 items-center overflow-x-auto border-b border-zinc-800 bg-zinc-950 text-xs">
      {tabs.map((id) => {
        const special = SPECIAL_TAB_LABEL[id]
        const agent = special ? null : agents.find((a) => a.id === id)
        if (!special && !agent) return null
        const status = statuses[id]?.status ?? 'starting'
        const active = id === activeTabId
        return (
          <div
            key={id}
            onClick={() => activateTab(id)}
            onAuxClick={(e) => {
              if (e.button === 1) closeTab(id)
            }}
            title={agent?.branch}
            className={`group flex shrink-0 cursor-pointer select-none items-center gap-2 border-r border-zinc-800 px-3 py-1.5 ${
              active
                ? 'bg-zinc-900 text-zinc-200'
                : 'text-zinc-500 hover:bg-zinc-900/60 hover:text-zinc-300'
            }`}
          >
            {agent && (
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TAB_DOT[status] ?? 'bg-zinc-500'}`} />
            )}
            <span className="max-w-40 truncate">{agent ? agent.name : special}</span>
            <button
              type="button"
              aria-label="Close tab"
              onClick={(e) => {
                e.stopPropagation()
                closeTab(id)
              }}
              className={`rounded px-0.5 leading-none text-zinc-600 hover:bg-zinc-700 hover:text-zinc-200 ${
                active ? '' : 'opacity-0 group-hover:opacity-100'
              }`}
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}
