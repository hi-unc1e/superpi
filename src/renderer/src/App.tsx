import { useEffect, useState } from 'react'
import type { AgentDescriptor, AgentStatusInfo, WorkspaceInfo } from '@shared/types'
import { Welcome } from './components/Welcome'
import { GitInitBanner } from './components/GitInitBanner'
import { AgentSidebar } from './components/AgentSidebar'
import { TerminalPane } from './components/TerminalPane'
import { TodoPanel } from './components/TodoPanel'
import { StatusBar } from './components/StatusBar'
import { DiffPane } from './components/DiffPane'
import { emitTermData } from './lib/terminalBus'


export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null | undefined>(undefined)
  const [agents, setAgents] = useState<AgentDescriptor[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [diffOpen, setDiffOpen] = useState(false)
  const [todoAgentId, setTodoAgentId] = useState<string | null>(null)
  const [statuses, setStatuses] = useState<Record<string, AgentStatusInfo>>({})

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

  // Refetch agents + reset selection whenever the open folder changes.
  useEffect(() => {
    window.superpi.listAgents().then(setAgents)
    setActiveId(null)
    setTodoAgentId(null)
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

  useEffect(() => {
    if (activeId && !agents.some((a) => a.id === activeId)) setActiveId(agents[0]?.id ?? null)
    else if (!activeId && agents.length > 0) setActiveId(agents[0].id)
  }, [agents, activeId])

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
    const active = agents.find((a) => a.id === activeId) ?? null
    const todoAgent = todoAgentId ? agents.find((a) => a.id === todoAgentId) ?? null : null
    body = (
      <div className="flex flex-1 overflow-hidden">
        <AgentSidebar
          workspace={workspace}
          agents={agents}
          statuses={statuses}
          activeId={activeId}
          todoAgentId={todoAgentId}
          onToggleTodos={(id) => setTodoAgentId((prev) => (prev === id ? null : id))}
          onSelect={setActiveId}
        />
        <main className="flex flex-1 flex-col overflow-hidden">
          <div className="flex flex-1 overflow-hidden">
            <div className="flex-1 overflow-hidden">
              {active ? (
                <TerminalPane
                  key={active.id}
                  id={active.id}
                  diffOpen={diffOpen}
                  onToggleDiff={() => setDiffOpen((o) => !o)}
                />
              ) : (
                <div className="flex h-full items-center justify-center text-zinc-500">
                  No agent — click +New to launch one in this worktree.
                </div>
              )}
            </div>
            {diffOpen && active && (
              <DiffPane id={active.id} onClose={() => setDiffOpen(false)} />
            )}
          </div>
          <StatusBar agent={active} info={active ? statuses[active.id] : undefined} />
        </main>
        {todoAgent && (
          <TodoPanel
            agent={todoAgent}
            phases={statuses[todoAgent.id]?.todoPhases}
            onClose={() => setTodoAgentId(null)}
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