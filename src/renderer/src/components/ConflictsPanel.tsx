import { useCallback, useEffect, useState } from 'react'
import type { ConflictInfo, WorktreeActionResult } from '@shared/types'

const POLL_MS = 2000

const btn =
  'rounded border border-zinc-700 px-2 py-1 text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40'

/** Right-side panel for resolving conflicts in a worktree: lists unmerged
 * files, lets the user keep one side wholesale or edit the merged content,
 * then continue or abort the paused rebase. */
export function ConflictsPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const [info, setInfo] = useState<ConflictInfo | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const s = await window.superpi.worktreeGitState(id)
    if (s) setInfo(s.conflicts)
  }, [id])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(t)
  }, [refresh])

  // Drop the selection once its file is no longer conflicted.
  useEffect(() => {
    if (selected && info && !info.files.includes(selected)) setSelected(null)
  }, [info, selected])

  async function openFile(path: string): Promise<void> {
    const text = await window.superpi.readWorktreeFile(id, path)
    if (text === null) {
      setError(`Cannot read ${path}`)
      return
    }
    setError(null)
    setSelected(path)
    setContent(text)
  }

  async function act(fn: () => Promise<WorktreeActionResult>): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const r = await fn()
      if (!r.ok) setError(r.error ?? 'Action failed')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const rebasing = info?.rebasing ?? false
  const files = info?.files ?? []
  // During a rebase, HEAD is main's side: --ours = main, --theirs = the branch commit.
  const oursLabel = rebasing ? 'Keep main' : 'Keep ours'
  const theirsLabel = rebasing ? 'Keep mine' : 'Keep theirs'

  return (
    <div className="flex w-96 flex-col border-l border-zinc-800 bg-zinc-900 text-xs text-zinc-400">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-1.5">
        <span className="font-medium text-zinc-200">
          Conflicts{files.length > 0 ? ` (${files.length})` : ''}
        </span>
        <button
          type="button"
          className="px-1 text-zinc-500 hover:text-zinc-200"
          onClick={onClose}
          aria-label="Close conflicts panel"
        >
          ✕
        </button>
      </div>

      {files.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-zinc-500">
          {rebasing
            ? 'All conflicts staged — continue the rebase below.'
            : 'No conflicts in this worktree.'}
        </div>
      ) : (
        <>
          <ul className="max-h-40 overflow-y-auto border-b border-zinc-800">
            {files.map((f) => (
              <li key={f}>
                <button
                  type="button"
                  className={`w-full truncate px-3 py-1 text-left font-mono hover:bg-zinc-800 ${
                    f === selected ? 'bg-zinc-800 text-amber-400' : 'text-zinc-300'
                  }`}
                  title={f}
                  onClick={() => void openFile(f)}
                >
                  {f}
                </button>
              </li>
            ))}
          </ul>

          {selected ? (
            <>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                spellCheck={false}
                className="min-h-0 flex-1 resize-none bg-zinc-950 p-2 font-mono text-[11px] leading-4 text-zinc-200 focus:outline-none"
              />
              <div className="flex items-center gap-1.5 border-t border-zinc-800 px-3 py-1.5">
                <button
                  type="button"
                  className={btn}
                  disabled={busy}
                  onClick={() => void act(() => window.superpi.resolveConflict(id, selected, 'ours'))}
                >
                  {oursLabel}
                </button>
                <button
                  type="button"
                  className={btn}
                  disabled={busy}
                  onClick={() => void act(() => window.superpi.resolveConflict(id, selected, 'theirs'))}
                >
                  {theirsLabel}
                </button>
                <button
                  type="button"
                  className={`${btn} ml-auto border-emerald-700 text-emerald-400`}
                  disabled={busy}
                  onClick={() => void act(() => window.superpi.resolveConflict(id, selected, { content }))}
                >
                  Save &amp; stage
                </button>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center px-4 text-center text-zinc-600">
              Select a file to resolve.
            </div>
          )}
        </>
      )}

      {rebasing && (
        <div className="flex items-center gap-1.5 border-t border-zinc-800 px-3 py-1.5">
          <button
            type="button"
            className={`${btn} border-emerald-700 text-emerald-400`}
            disabled={busy || files.length > 0}
            title={files.length > 0 ? 'Resolve all conflicts first' : undefined}
            onClick={() => void act(() => window.superpi.rebaseContinue(id))}
          >
            Continue rebase
          </button>
          <button
            type="button"
            className={`${btn} ml-auto border-red-900 text-red-400`}
            disabled={busy}
            onClick={() => void act(() => window.superpi.rebaseAbort(id))}
          >
            Abort rebase
          </button>
        </div>
      )}

      {error && (
        <div className="truncate border-t border-zinc-800 px-3 py-1.5 text-red-400" title={error}>
          {error}
        </div>
      )}
    </div>
  )
}
