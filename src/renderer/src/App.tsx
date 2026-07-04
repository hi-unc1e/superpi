import { useEffect, useRef, useState } from 'react'
import type { AgentDescriptor, AgentStatusInfo, WorkspaceInfo } from '@shared/types'
import { Welcome } from './components/Welcome'
import { GitInitBanner } from './components/GitInitBanner'
import { AgentSidebar } from './components/AgentSidebar'
import { TabStrip } from './components/TabStrip'
import { TerminalPane } from './components/TerminalPane'
import { TodoPanel } from './components/TodoPanel'
import { StatusBar } from './components/StatusBar'
import { emitTermData } from './lib/terminalBus'
import { CONFIGS_TAB_ID, useWorkbench } from './lib/workbench'
import { ConfigsPane } from './components/ConfigsPane'


export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null | undefined>(undefined)
  const [agents, setAgents] = useState<AgentDescriptor[]>([])
  const [statuses, setStatuses] = useState<Record<string, AgentStatusInfo>>({})
  const { activeTabId, openTab, togglePanel, closePanel, isPanelOpen, pruneTabs, resetWorkbench } =
    useWorkbench()
  /** Agent ids seen in the previous list. Null before the first load of a
   * workspace, so the first agent gets a tab on startup; afterwards only
   * newly created agents auto-open (closing the last tab stays closed). */
  const seenAgentsRef = useRef<Set<string> | null>(null)

  useEffect(() => {
    window.superpi.getWorkspace().then(setWorkspace)
    const offWs = window.superpi.onWorkspaceChanged(setWorkspace)
    const offAgents = window.superpi.onAgentListChanged(setAgents)
    const offData = window.superpi.onTerminalData((id, data) => emitTermData(id, data))
    const offStatus = window.superpi.onStatusChanged((info) =>
      setStatuses((prev) => ({ ...prev, [info.agentId]: info }))
    )
    return () => {
      offWs()
      offAgents()
      offData()
      offStatus()
    }
  }, [])

  // Refetch agents + reset the workbench whenever the open folder changes.
  useEffect(() => {
    window.superpi.listAgents().then(setAgents)
    seenAgentsRef.current = null
    resetWorkbench()
  }, [workspace?.path])

  // Pull status snapshots for agents we have no push for yet: `status:changed`
  // emitted before the window existed (startup revive) never reaches us.
  useEffect(() => {
    for (const a of agents) {
      if (statuses[a.id]) continue
      window.superpi.getStatus(a.id).then((info) => {
        if (info) setStatuses((prev) => ({ ...prev, [info.agentId]: info }))
      })
    }
  }, [agents])

  // Close tabs of removed agents; auto-open a tab for the first agent after a
  // workspace load and for each newly created agent.
  useEffect(() => {
    pruneTabs([...agents.map((a) => a.id), CONFIGS_TAB_ID])
    const seen = seenAgentsRef.current
    seenAgentsRef.current = new Set(agents.map((a) => a.id))
    if (agents.length === 0) return
    if (seen === null) openTab(agents[0].id)
    else for (const a of agents) if (!seen.has(a.id)) openTab(a.id)
  }, [agents])

  let body: JSX.Element
  if (workspace === undefined) {
    body = <div className="flex-1 bg-zinc-950" />
  } else if (workspace === null) {
    body = (
      <div className="flex-1 overflow-hidden">
        <Welcome />
      </div>
    )
  } else if (!workspace.isGit) {
    body = (
      <div className="flex-1 overflow-hidden">
        <GitInitBanner workspace={workspace} />
      </div>
    )
  } else {
    const active = agents.find((a) => a.id === activeTabId) ?? null
    const todoOpen = active !== null && isPanelOpen(active.id, 'todo')
    body = (
      <div className="flex flex-1 overflow-hidden">
        <AgentSidebar
          workspace={workspace}
          agents={agents}
          statuses={statuses}
          activeId={activeTabId}
          todoAgentId={active && todoOpen ? active.id : null}
          onToggleTodos={(id) => {
            openTab(id)
            togglePanel(id, 'todo')
          }}
          onSelect={openTab}
        />
        <main className="flex flex-1 flex-col overflow-hidden">
          <TabStrip agents={agents} statuses={statuses} />
          <div className="flex flex-1 overflow-hidden">
            {activeTabId === CONFIGS_TAB_ID ? (
              <ConfigsPane />
            ) : active ? (
              <TerminalPane key={active.id} id={active.id} />
            ) : (
              <div className="flex flex-1 items-center justify-center text-zinc-500">
                {agents.length > 0
                  ? 'No tab open — select an agent in the sidebar.'
                  : 'No agent — click +New to launch one in this worktree.'}
              </div>
            )}
          </div>
          <StatusBar agent={active} info={active ? statuses[active.id] : undefined} />
        </main>
        {active && todoOpen && (
          <TodoPanel
            agent={active}
            phases={statuses[active.id]?.todoPhases}
            onClose={() => closePanel(active.id, 'todo')}
          />
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full w-full">
      {body}
    </div>
  )
}
