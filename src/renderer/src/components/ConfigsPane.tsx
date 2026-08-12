import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { AgentConfig, ModelOption } from '@shared/types'

const EMPTY: AgentConfig = { id: 'new', name: '', isDefault: false }

export function ConfigsPane() {
  const [configs, setConfigs] = useState<AgentConfig[]>([])
  const [models, setModels] = useState<ModelOption[]>([])
  const [editId, setEditId] = useState<string | null>(null)
  const [draft, setDraft] = useState<AgentConfig>(EMPTY)

  useEffect(() => {
    refresh()
    window.superpi.listModels().then(setModels)
  }, [])

  async function refresh(): Promise<void> {
    const list = await window.superpi.listConfigs()
    setConfigs(list)
    if (editId === null && list.length > 0) {
      setEditId(list[0].id)
      setDraft(list[0])
    }
  }

  function select(c: AgentConfig): void {
    setEditId(c.id)
    setDraft({ ...c })
  }

  async function save(): Promise<void> {
    if (!draft.name.trim()) return
    const saved = await window.superpi.saveConfig(draft)
    setConfigs(await window.superpi.listConfigs())
    setEditId(saved.id)
    setDraft(saved)
  }

  async function remove(id: string): Promise<void> {
    const list = await window.superpi.deleteConfig(id)
    setConfigs(list)
    if (editId === id) {
      setEditId(list[0]?.id ?? null)
      setDraft(list[0] ?? { ...EMPTY })
    }
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-zinc-900">
        <div className="w-48 shrink-0 border-r border-zinc-800">
          <div className="flex items-center justify-between px-3 py-3">
            <span className="text-xs font-semibold uppercase text-zinc-400">Configs</span>
            <button onClick={() => select({ ...EMPTY })} className="text-xs text-emerald-400 hover:underline">
              + add
            </button>
          </div>
          <div className="overflow-y-auto">
            {configs.map((c) => (
              <button
                key={c.id}
                onClick={() => select(c)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                  editId === c.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-800/60'
                }`}
              >
                <span className="flex-1 truncate">{c.name}</span>
                {c.isDefault && (
                  <span className="rounded bg-zinc-700 px-1 text-[10px] text-zinc-300">default</span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-1 flex-col">
          {editId === null ? (
            <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
              Select or add a config.
            </div>
          ) : (
            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              <Field label="Name">
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
                />
              </Field>
              <Field label="Model (optional)" hint="pi --model, e.g. anthropic/claude-sonnet">
                <input
                  value={draft.model ?? ''}
                  onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                  list="superpi-models"
                  className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
                />
                <datalist id="superpi-models">
                  {models.map((m) => (
                    <option key={m.selector} value={m.selector}>
                      {m.name}
                    </option>
                  ))}
                </datalist>
              </Field>
              <Field label="Thinking (optional)" hint="off | minimal | low | medium | high | xhigh">
                <input
                  value={draft.thinking ?? ''}
                  onChange={(e) => setDraft({ ...draft, thinking: e.target.value })}
                  className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
                />
              </Field>
              <Field label="Base branch (optional)">
                <input
                  value={draft.baseBranch ?? ''}
                  onChange={(e) => setDraft({ ...draft, baseBranch: e.target.value })}
                  className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
                />
              </Field>
              <Field label="First message (optional)" hint="Initial prompt sent to the agent on launch">
                <textarea
                  value={draft.firstMessage ?? ''}
                  onChange={(e) => setDraft({ ...draft, firstMessage: e.target.value })}
                  rows={3}
                  className="w-full resize-none rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
                />
              </Field>
              <label className="flex items-center gap-2 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  checked={!!draft.isDefault}
                  onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })}
                />
                Use as default for +New
              </label>
              <div className="flex items-center gap-2 pt-2">
                <button
                  onClick={save}
                  disabled={!draft.name.trim()}
                  className="rounded bg-emerald-600 px-3 py-1 text-sm text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  Save
                </button>
                {draft.id !== 'new' && (
                  <button
                    onClick={() => remove(draft.id)}
                    className="rounded px-3 py-1 text-sm text-red-400 hover:bg-zinc-800"
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-zinc-400">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-zinc-600">{hint}</span>}
    </label>
  )
}
