import { useCallback, useEffect, useState } from 'react'
import type { GitLogEntry } from '@shared/types'

/**
 * Right-hand panel: the workspace's git commit history, toggled by the
 * Git log button's right-arrow action in the sidebar.
 */
export function GitLogPanel({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<GitLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setEntries(await window.superpi.gitLog())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="flex w-[42%] min-w-[360px] shrink-0 flex-col border-l border-zinc-800 bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Git log</span>
        <button onClick={onClose} aria-label="Close git log panel" className="text-zinc-500 hover:text-zinc-300">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="h-4 w-4">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="px-4 py-2 text-xs text-zinc-500">Loading...</div>
        ) : error ? (
          <div className="px-4 py-2 text-xs text-red-400">{error}</div>
        ) : entries.length === 0 ? (
          <div className="px-4 py-2 text-xs text-zinc-500">No commits yet.</div>
        ) : (
          <div className="divide-y divide-zinc-800">
            {entries.map((entry) => (
              <div key={entry.hash} className="px-4 py-2">
                <div className="flex items-start gap-1.5">
                  <span className="shrink-0 text-[11px] font-mono text-amber-500">{entry.hash.slice(0, 7)}</span>
                  {entry.refs && (
                    <span className="shrink-0 text-[11px] font-mono text-emerald-400">
                      {entry.refs.replace('HEAD -> ', '').replace(', ', ' ')}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-[11px] leading-tight text-zinc-100">{entry.message}</div>
                <div className="mt-0.5 text-[10px] text-zinc-500">
                  {entry.author}
                  <span className="mx-1">&middot;</span>
                  {entry.date.slice(0, 10)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
