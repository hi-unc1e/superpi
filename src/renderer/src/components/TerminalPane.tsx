import '@xterm/xterm/css/xterm.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { onTermData } from '../lib/terminalBus'
import { ConflictsPanel } from './ConflictsPanel'
import { WorktreeHeader } from './WorktreeHeader'

type AttachState = 'loading' | 'self' | 'remote' | 'error'

export function TerminalPane({
  id,
  diffOpen,
  onToggleDiff
}: {
  id: string
  diffOpen: boolean
  onToggleDiff: () => void
}) {
  const elRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<AttachState>('loading')
  const [conflictsOpen, setConflictsOpen] = useState(false)
  const openConflicts = useCallback(() => setConflictsOpen(true), [])

  // Resolve attach state on mount / id change.
  useEffect(() => {
    setState('loading')
    setConflictsOpen(false)
    let cancelled = false
    window.superpi.terminalAttach(id).then((res) => {
      if (cancelled) return
      if (!res) { setState('error'); return }
      setState(res.remote ? 'remote' : 'self')
    })
    return () => { cancelled = true }
  }, [id])

  // Only wire up xterm when this instance owns the PTY.
  useEffect(() => {
    if (state !== 'self') return
    const el = elRef.current
    if (!el) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: { background: '#09090b', foreground: '#e4e4e7', cursor: '#e4e4e7' }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(el)
    // GPU renderer; on context loss (or no WebGL2) fall back to the DOM renderer.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch { /* WebGL unavailable — DOM renderer */ }

    let disposed = false

    window.superpi.terminalAttach(id).then((res) => {
      if (!res || disposed || res.remote) return
      // Order matters: size xterm to the PTY's true dimensions first, so the
      // ring replay (full of absolute cursor positioning from the TUI) lands
      // on the grid it was recorded for. Only then fit to the pane: if the
      // fitted size differs from the PTY's, the resize reaches the PTY as a
      // real change (SIGWINCH) and the app repaints; if it matches, the
      // replay is already correct and no repaint is needed. Replaying into
      // the default 80x24 grid garbles the screen with no SIGWINCH to fix it.
      if (res.cols > 0 && res.rows > 0) term.resize(res.cols, res.rows)
      if (res.ring) term.write(res.ring)
      // Defer fit so the DOM layout settles (otherwise offsetWidth/Height may be 0).
      requestAnimationFrame(() => { try { fit.fit() } catch { /* layout not ready yet */ } })
    })

    const offInput = term.onData((d) => window.superpi.terminalInput(id, d))
    const offResize = term.onResize(({ cols, rows }) => window.superpi.terminalResize(id, cols, rows))
    const offData = onTermData(id, (d) => term.write(d))

    const ro = new ResizeObserver(() => { try { fit.fit() } catch { /* ignore */ } })
    ro.observe(el)

    return () => {
      disposed = true
      offInput.dispose()
      offResize.dispose()
      offData()
      ro.disconnect()
      term.dispose()
    }
  }, [id, state])

  let body: JSX.Element
  if (state === 'loading') {
    body = <div className="h-full w-full bg-zinc-950" />
  } else if (state === 'remote') {
    body = (
      <div className="flex h-full items-center justify-center text-sm text-zinc-500">
        Agent is running in another superpi window.
      </div>
    )
  } else if (state === 'error') {
    body = (
      <div className="flex h-full items-center justify-center text-sm text-zinc-500">
        Failed to attach to agent.
      </div>
    )
  } else {
    body = <div ref={elRef} className="h-full w-full p-1" />
  }

  return (
    <div className="flex h-full w-full flex-col">
      <WorktreeHeader id={id} diffOpen={diffOpen} onToggleDiff={onToggleDiff} onOpenConflicts={openConflicts} />
      <div className="flex min-h-0 flex-1">
        <div className="flex-1 overflow-hidden">{body}</div>
        {conflictsOpen && <ConflictsPanel id={id} onClose={() => setConflictsOpen(false)} />}
      </div>
    </div>
  )
}
