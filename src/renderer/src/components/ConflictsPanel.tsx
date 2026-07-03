import { useCallback, useEffect, useState } from 'react'
import type { ConflictInfo, WorktreeActionResult } from '@shared/types'

const POLL_MS = 2000
/** Text-segment lines shown before collapsing the middle. */
const CONTEXT_LINES = 2

const btn =
  'rounded border border-zinc-700 px-2 py-1 text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40'

type Side = 'ours' | 'theirs'

/** A parsed run of a conflicted file: plain text, or one <<<<<<< block. */
type Segment =
  | { kind: 'text'; lines: string[] }
  | { kind: 'conflict'; ours: string[]; theirs: string[] }

/** Split file content into text/conflict segments. Diff3 base sections
 * (`|||||||`) are skipped; a malformed block degrades to plain text.
 * Exported for the smoke test. */
export function parseConflicts(text: string): Segment[] {
  const lines = text.split('\n')
  const segs: Segment[] = []
  let plain: string[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].startsWith('<<<<<<<')) {
      const ours: string[] = []
      const theirs: string[] = []
      let j = i + 1
      while (j < lines.length && !lines[j].startsWith('=======') && !lines[j].startsWith('|||||||')) {
        ours.push(lines[j])
        j++
      }
      while (j < lines.length && lines[j].startsWith('|||||||')) {
        while (j < lines.length && !lines[j].startsWith('=======')) j++
      }
      if (j < lines.length && lines[j].startsWith('=======')) {
        j++
        while (j < lines.length && !lines[j].startsWith('>>>>>>>')) {
          theirs.push(lines[j])
          j++
        }
        if (j < lines.length) {
          if (plain.length) {
            segs.push({ kind: 'text', lines: plain })
            plain = []
          }
          segs.push({ kind: 'conflict', ours, theirs })
          i = j + 1
          continue
        }
      }
    }
    plain.push(lines[i])
    i++
  }
  if (plain.length) segs.push({ kind: 'text', lines: plain })
  return segs
}

/** Right-side panel for resolving conflicts in a worktree. Conflicted files are
 * parsed into blocks: pick a side per block (or for all), or drop to a raw
 * editor for hand merges, then continue or abort the paused rebase. */
export function ConflictsPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const [info, setInfo] = useState<ConflictInfo | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [segments, setSegments] = useState<Segment[]>([])
  const [choices, setChoices] = useState<Record<number, Side>>({})
  const [raw, setRaw] = useState(false)
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
    setSegments(parseConflicts(text))
    setChoices({})
    setRaw(false)
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
  const oursLabel = rebasing ? 'main' : 'ours'
  const theirsLabel = rebasing ? 'mine' : 'theirs'

  const conflictIdxs = segments.flatMap((s, i) => (s.kind === 'conflict' ? [i] : []))
  const allChosen = conflictIdxs.length > 0 && conflictIdxs.every((i) => choices[i])

  function applyChoices(): Promise<void> {
    if (!selected) return Promise.resolve()
    const merged = segments
      .flatMap((s, i) => (s.kind === 'text' ? s.lines : s[choices[i] ?? 'ours']))
      .join('\n')
    return act(() => window.superpi.resolveConflict(id, selected, { content: merged }))
  }

  function contextRows(lines: string[]): { text: string; collapsed?: number }[] {
    if (lines.length <= CONTEXT_LINES * 2 + 1) return lines.map((text) => ({ text }))
    return [
      ...lines.slice(0, CONTEXT_LINES).map((text) => ({ text })),
      { text: '', collapsed: lines.length - CONTEXT_LINES * 2 },
      ...lines.slice(-CONTEXT_LINES).map((text) => ({ text }))
    ]
  }

  const sideBlock = (
    idx: number,
    side: Side,
    label: string,
    lines: string[],
    tone: { bar: string; body: string }
  ) => {
    const chosen = choices[idx]
    const dimmed = chosen && chosen !== side
    return (
      <div className={dimmed ? 'opacity-30' : ''}>
        <button
          type="button"
          className={`flex w-full items-center gap-1.5 px-2 py-0.5 text-left ${tone.bar}`}
          title={`Keep the ${label} side of this block`}
          onClick={() => setChoices((c) => ({ ...c, [idx]: side }))}
        >
          <span
            className={`inline-block h-3 w-3 shrink-0 rounded-sm border text-center leading-3 ${
              chosen === side ? 'border-current' : 'border-zinc-600'
            }`}
          >
            {chosen === side ? '✓' : ''}
          </span>
          <span className="font-medium uppercase tracking-wide">{label}</span>
        </button>
        <pre className={`overflow-x-auto px-2 py-0.5 ${tone.body}`}>
          {lines.length > 0 ? lines.join('\n') : <span className="italic opacity-50">(empty — side deletes these lines)</span>}
        </pre>
      </div>
    )
  }

  let editor: JSX.Element
  if (!selected) {
    editor = (
      <div className="flex flex-1 items-center justify-center px-4 text-center text-zinc-600">
        Select a file to resolve.
      </div>
    )
  } else if (raw) {
    editor = (
      <>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          spellCheck={false}
          className="min-h-0 flex-1 resize-none bg-zinc-950 p-2 font-mono text-[11px] leading-4 text-zinc-200 focus:outline-none"
        />
        <div className="flex items-center gap-1.5 border-t border-zinc-800 px-3 py-1.5">
          <button type="button" className={btn} disabled={busy} onClick={() => setRaw(false)}>
            Blocks
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
    )
  } else if (conflictIdxs.length === 0) {
    // No textual markers (binary file, or already edited): pick a side via git.
    editor = (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-zinc-500">
        <p>No conflict markers found — keep one side wholesale:</p>
        <div className="flex gap-1.5">
          <button
            type="button"
            className={btn}
            disabled={busy}
            onClick={() => void act(() => window.superpi.resolveConflict(id, selected, 'ours'))}
          >
            Keep {oursLabel}
          </button>
          <button
            type="button"
            className={btn}
            disabled={busy}
            onClick={() => void act(() => window.superpi.resolveConflict(id, selected, 'theirs'))}
          >
            Keep {theirsLabel}
          </button>
          <button type="button" className={btn} disabled={busy} onClick={() => setRaw(true)}>
            Edit raw
          </button>
        </div>
      </div>
    )
  } else {
    editor = (
      <>
        <div className="min-h-0 flex-1 overflow-y-auto bg-zinc-950 font-mono text-[11px] leading-4">
          {segments.map((seg, idx) =>
            seg.kind === 'text' ? (
              <div key={idx} className="px-2 py-0.5 text-zinc-600">
                {contextRows(seg.lines).map((row, k) =>
                  row.collapsed ? (
                    <div key={k} className="select-none py-0.5 text-center text-zinc-700">
                      ⋯ {row.collapsed} unchanged lines ⋯
                    </div>
                  ) : (
                    <div key={k} className="whitespace-pre overflow-x-auto">{row.text || '\u00A0'}</div>
                  )
                )}
              </div>
            ) : (
              <div key={idx} className="my-1 border-y border-zinc-800">
                {sideBlock(idx, 'ours', oursLabel, seg.ours, {
                  bar: 'bg-sky-950 text-sky-300',
                  body: 'bg-sky-950/40 text-sky-100'
                })}
                {sideBlock(idx, 'theirs', theirsLabel, seg.theirs, {
                  bar: 'bg-amber-950 text-amber-300',
                  body: 'bg-amber-950/40 text-amber-100'
                })}
              </div>
            )
          )}
        </div>
        <div className="flex items-center gap-1.5 border-t border-zinc-800 px-3 py-1.5">
          <button
            type="button"
            className={btn}
            disabled={busy}
            onClick={() => setChoices(Object.fromEntries(conflictIdxs.map((i) => [i, 'ours'])))}
          >
            All {oursLabel}
          </button>
          <button
            type="button"
            className={btn}
            disabled={busy}
            onClick={() => setChoices(Object.fromEntries(conflictIdxs.map((i) => [i, 'theirs'])))}
          >
            All {theirsLabel}
          </button>
          <button type="button" className={btn} disabled={busy} onClick={() => setRaw(true)}>
            Raw
          </button>
          <button
            type="button"
            className={`${btn} ml-auto border-emerald-700 text-emerald-400`}
            disabled={busy || !allChosen}
            title={allChosen ? undefined : 'Pick a side for every block first'}
            onClick={() => void applyChoices()}
          >
            Apply &amp; stage
          </button>
        </div>
      </>
    )
  }

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
          {editor}
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
