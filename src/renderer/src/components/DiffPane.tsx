import { useCallback, useEffect, useState } from 'react'
import type { WorktreeDiff, WorktreeDiffFile, WorktreeDiffLine } from '@shared/types'

// House style: static lookup → Record (see STATUS_DOT in AgentSidebar).
const DIFF_LINE: Record<WorktreeDiffLine['type'], string> = {
  add: 'bg-emerald-500/10 text-emerald-300',
  del: 'bg-red-500/10 text-red-300',
  context: 'text-zinc-500'
}

const SIGN: Record<WorktreeDiffLine['type'], string> = {
  add: '+',
  del: '−',
  context: ' '
}

const BTN = 'rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:bg-zinc-800'

/** Right-hand panel: the worktree's changes vs HEAD rendered as an IDE-style
 * text diff (classic green/red), toggled by clicking the header's LoC count. */
export function DiffPane({ id, onClose }: { id: string; onClose: () => void }) {
  const [diff, setDiff] = useState<WorktreeDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setDiff(await window.superpi.getWorktreeDiff(id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div className="flex w-[42%] min-w-[360px] shrink-0 flex-col border-l border-zinc-800 bg-zinc-950">
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs">
        <span className="font-medium text-zinc-300">Changes vs HEAD</span>
        <div className="flex items-center gap-1.5">
          <button type="button" className={BTN} onClick={() => void refresh()}>
            Refresh
          </button>
          <button type="button" className={BTN} onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto font-mono text-xs leading-5">
        {loading ? (
          <div className="px-3 py-2 text-zinc-500">Loading…</div>
        ) : error ? (
          <div className="px-3 py-2 text-red-400">{error}</div>
        ) : !diff || diff.files.length === 0 ? (
          <div className="px-3 py-2 text-zinc-500">No changes.</div>
        ) : (
          diff.files.map((f) => <FileBlock key={f.path} file={f} />)
        )}
      </div>
    </div>
  )
}

function FileBlock({ file }: { file: WorktreeDiffFile }) {
  return (
    <div className="border-b border-zinc-900">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/95 px-3 py-1 backdrop-blur">
        <span className="truncate text-zinc-200" title={file.path}>
          {file.path}
        </span>
        <span className="ml-auto flex shrink-0 gap-2">
          <span className="text-emerald-400">+{file.added}</span>
          <span className="text-red-400">−{file.deleted}</span>
        </span>
      </div>
      {file.binary ? (
        <div className="px-3 py-2 italic text-zinc-500">Binary file</div>
      ) : (
        file.hunks.map((h, i) => (
          <div key={i}>
            <div className="whitespace-pre px-3 py-0.5 text-zinc-600">{h.header}</div>
            {h.lines.map((ln, j) => (
              <div key={j} className={`flex ${DIFF_LINE[ln.type]}`}>
                <span className="w-10 shrink-0 select-none px-2 text-right text-zinc-600">
                  {ln.oldNo ?? ''}
                </span>
                <span className="w-10 shrink-0 select-none px-2 text-right text-zinc-600">
                  {ln.newNo ?? ''}
                </span>
                <span className="w-4 shrink-0 select-none text-center">{SIGN[ln.type]}</span>
                <span className="whitespace-pre pl-1 pr-3">{ln.text}</span>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  )
}
