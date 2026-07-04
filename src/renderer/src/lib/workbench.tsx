import { createContext, useContext, useMemo, useReducer, type ReactNode } from 'react'

/** Auxiliary panels that can be opened per tab. */
export type PanelKind = 'diff' | 'conflicts' | 'todo' | 'gitlog'

/** Reserved tab ids for non-agent panes. Agent tab ids are UUIDs, so no
 * collision. Callers of pruneTabs must include them in `alive` when the tab
 * should survive pruning. */
export const CONFIGS_TAB_ID = 'superpi:configs'
export const GITLOG_TAB_ID = 'superpi:gitlog'

/** Tabs (open agent terminals) + per-tab panel visibility. The single owner of
 * "what is open" in the main pane: components open/close tabs and panels only
 * through the useWorkbench() API, never via ad-hoc local state. */
export interface WorkbenchState {
  /** Open tabs (agent ids) in open order. */
  tabs: string[]
  activeTabId: string | null
  /** Per-tab panel visibility; a missing entry means closed. */
  panels: Record<string, Partial<Record<PanelKind, boolean>>>
}

export type WorkbenchAction =
  | { type: 'open-tab'; id: string }
  | { type: 'close-tab'; id: string }
  | { type: 'activate-tab'; id: string }
  | { type: 'set-panel'; id: string; panel: PanelKind; open: boolean }
  | { type: 'toggle-panel'; id: string; panel: PanelKind }
  | { type: 'prune'; alive: string[] }
  | { type: 'reset' }

export const EMPTY_WORKBENCH: WorkbenchState = { tabs: [], activeTabId: null, panels: {} }

/** Exported for the headless smoke test; components use useWorkbench(). */
export function workbenchReducer(state: WorkbenchState, action: WorkbenchAction): WorkbenchState {
  switch (action.type) {
    case 'open-tab': {
      const tabs = state.tabs.includes(action.id) ? state.tabs : [...state.tabs, action.id]
      return { ...state, tabs, activeTabId: action.id }
    }
    case 'close-tab': {
      const idx = state.tabs.indexOf(action.id)
      if (idx === -1) return state
      const tabs = state.tabs.filter((t) => t !== action.id)
      const { [action.id]: _closed, ...panels } = state.panels
      // Closing the active tab activates the next tab, else the new last one.
      const activeTabId =
        state.activeTabId === action.id
          ? tabs[Math.min(idx, tabs.length - 1)] ?? null
          : state.activeTabId
      return { tabs, activeTabId, panels }
    }
    case 'activate-tab':
      return state.tabs.includes(action.id) ? { ...state, activeTabId: action.id } : state
    case 'set-panel': {
      const open = state.panels[action.id]?.[action.panel] ?? false
      if (open === action.open) return state
      return {
        ...state,
        panels: {
          ...state.panels,
          [action.id]: { ...state.panels[action.id], [action.panel]: action.open }
        }
      }
    }
    case 'toggle-panel': {
      const open = !(state.panels[action.id]?.[action.panel] ?? false)
      return workbenchReducer(state, { type: 'set-panel', id: action.id, panel: action.panel, open })
    }
    case 'prune': {
      const alive = new Set(action.alive)
      const tabs = state.tabs.filter((t) => alive.has(t))
      if (tabs.length === state.tabs.length) return state
      const panels: WorkbenchState['panels'] = {}
      for (const t of tabs) if (state.panels[t]) panels[t] = state.panels[t]
      const activeTabId =
        state.activeTabId !== null && alive.has(state.activeTabId)
          ? state.activeTabId
          : tabs[tabs.length - 1] ?? null
      return { tabs, activeTabId, panels }
    }
    case 'reset':
      return EMPTY_WORKBENCH
  }
}

export interface WorkbenchAPI extends WorkbenchState {
  /** Opens the agent's tab (appending it if new) and activates it. */
  openTab(id: string): void
  /** Closes the tab and drops its panel state. Never removes the agent. */
  closeTab(id: string): void
  activateTab(id: string): void
  openPanel(id: string, panel: PanelKind): void
  closePanel(id: string, panel: PanelKind): void
  togglePanel(id: string, panel: PanelKind): void
  isPanelOpen(id: string, panel: PanelKind): boolean
  /** Closes tabs whose agent no longer exists. */
  pruneTabs(alive: string[]): void
  /** Clears all tabs and panels (workspace switch). */
  resetWorkbench(): void
}

const WorkbenchContext = createContext<WorkbenchAPI | null>(null)

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(workbenchReducer, EMPTY_WORKBENCH)
  const api = useMemo<WorkbenchAPI>(
    () => ({
      ...state,
      openTab: (id) => dispatch({ type: 'open-tab', id }),
      closeTab: (id) => dispatch({ type: 'close-tab', id }),
      activateTab: (id) => dispatch({ type: 'activate-tab', id }),
      openPanel: (id, panel) => dispatch({ type: 'set-panel', id, panel, open: true }),
      closePanel: (id, panel) => dispatch({ type: 'set-panel', id, panel, open: false }),
      togglePanel: (id, panel) => dispatch({ type: 'toggle-panel', id, panel }),
      isPanelOpen: (id, panel) => state.panels[id]?.[panel] ?? false,
      pruneTabs: (alive) => dispatch({ type: 'prune', alive }),
      resetWorkbench: () => dispatch({ type: 'reset' })
    }),
    [state]
  )
  return <WorkbenchContext.Provider value={api}>{children}</WorkbenchContext.Provider>
}

export function useWorkbench(): WorkbenchAPI {
  const ctx = useContext(WorkbenchContext)
  if (!ctx) throw new Error('useWorkbench must be used inside WorkbenchProvider')
  return ctx
}
