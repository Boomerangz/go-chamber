import { ChevronDown } from 'lucide-react'
import { icon } from '../icon'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ModelChoice, Session } from '../../lib/api'
import { failedTo } from '../../lib/failed'
import { effortsFor, modelLabel } from '../../lib/models'
import { modelCatalogKey, useSessionStore } from '../../stores/session'
import { LoadFailed, LoadingLine } from '../ui/Loading'
import './ModelPicker.css'

const agentConfig = { claude: 'Claude settings', codex: 'Codex config', opencode: 'OpenCode config' } as const

// ModelPicker chooses the session's model and reasoning effort. A choice
// shows at once in the "not yet settled" form until the server agrees, and
// goes back if it refuses.
export default function ModelPicker({ session }: { session: Session }) {
  const cwd = session.agent === 'opencode' ? session.cwd : undefined
  const key = modelCatalogKey(session.agent, cwd)
  const [search, setSearch] = useState('')
  const models = useSessionStore((s) => s.models[key])
  const status = useSessionStore((s) => s.modelsStatus[key])
  const modelsError = useSessionStore((s) => s.modelsError[key])
  const loadModels = useSessionStore((s) => s.loadModels)
  const setModel = useSessionStore((s) => s.setModel)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<ModelChoice | null>(null)
  const latest = useRef(0)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void loadModels(session.agent, cwd)
  }, [session.agent, cwd, loadModels])

  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) trigger.current?.focus()
  }

  useEffect(() => {
    if (!open) return
    // Focus lands on the current choice, as in a native radio group.
    const checked = menu.current?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')
    checked?.focus()
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const list = models ?? []
  // The model "Default" stands for, when the agent says; named there, once.
  const defaultModel = list.find((m) => m.default)
  const model = pending ? pending.model ?? '' : session.model ?? ''
  const effort = pending ? pending.effort ?? '' : session.effort ?? ''
  const efforts = effortsFor(list, model)
  const label = modelLabel(list, { model, effort })

  const choose = async (nextModel: string, nextEffort: string) => {
    // Drop an effort the new model doesn't accept.
    const allowed = effortsFor(list, nextModel)
    const e = allowed.includes(nextEffort) ? nextEffort : ''
    close(true)
    if (nextModel === model && e === effort) return
    const ticket = ++latest.current
    setPending({ model: nextModel, effort: e })
    await setModel(session.id, { model: nextModel, effort: e })
    // Success: the session now carries the choice. Failure: back to it.
    if (ticket === latest.current) setPending(null)
  }

  const modelChecked = (id: string) => model === id
  const anyModelChecked = model === '' || list.some((m) => m.id === model)

  return (
    <div
      className="model-picker"
      ref={root}
      onBlur={(e) => {
        // Tab took the focus elsewhere: the menu goes. A click on the menu's
        // own surface blurs to nothing (no relatedTarget) and keeps it; a
        // click outside is the mousedown handler's.
        const to = e.relatedTarget
        if (open && to instanceof Node && !e.currentTarget.contains(to)) setOpen(false)
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="model-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-busy={pending ? true : undefined}
        aria-label={`Model: ${label}`}
        title={pending ? 'Changing the model…' : undefined}
        onClick={() => {
          if (open) return close(false)
          // A listing that failed is asked for again when the menu opens.
          void loadModels(session.agent, cwd)
          setOpen(true)
        }}
      >
        {pending && <span className="busy-mark" aria-hidden="true" />}
        <span className="model-name">{label}</span>
        <ChevronDown {...icon(13)} className="icon chevron" />
      </button>
      {open && (
        <div className="model-menu" role="dialog" aria-label="Choose model" ref={menu}>
          {session.agent === 'opencode' && <div className="model-search"><input className="field" type="search" aria-label="Search models" placeholder="Model or provider…" value={search} onChange={(e) => setSearch(e.target.value)} /><button className="btn btn-xs" onClick={() => void loadModels(session.agent, cwd, true)}>Refresh models</button></div>}
          <div className="model-options" role="radiogroup" aria-label="Model" onKeyDown={walkRadios}>
            <ModelOption
              checked={modelChecked('')}
              focusable={modelChecked('') || !anyModelChecked}
              name="Default"
              description={defaultModel ? `${defaultModel.name}, from ${agentConfig[session.agent]}` : `From ${agentConfig[session.agent]}`}
              onSelect={() => void choose('', effort)}
            />
            {list.filter((m) => `${m.name} ${m.id} ${m.provider ?? ''}`.toLowerCase().includes(search.toLowerCase())).map((m, i, shown) => (
              <div key={m.id}>
              {m.provider && (i === 0 || shown[i-1]?.provider !== m.provider) && <p className="model-provider">{m.provider}</p>}
              <ModelOption
                key={m.id}
                checked={modelChecked(m.id)}
                focusable={modelChecked(m.id)}
                name={m.name}
                description={m.provider ? `${m.id}${m.description ? ` · ${m.description}` : ''}` : m.description}
                onSelect={() => void choose(m.id, effort)}
              />
              </div>
            ))}
            {(status === 'loading' || (status === undefined && models === undefined)) && <LoadingLine>loading models…</LoadingLine>}
            {status === 'error' && (
              <LoadFailed onRetry={() => void loadModels(session.agent, cwd)}>{failedTo('load models', modelsError)}</LoadFailed>
            )}
            {status === 'ready' && models?.length === 0 && <p className="model-none">this agent doesn't list models</p>}
          </div>
          {efforts.length > 0 && (
            <div className="effort">
              <span className="section-title">{session.agent === 'opencode' ? 'Variant' : 'Reasoning effort'}</span>
              <div className="effort-options" role="radiogroup" aria-label="Effort" onKeyDown={walkRadios}>
                {['', ...efforts].map((e) => (
                  <button
                    key={e || 'auto'}
                    type="button"
                    role="radio"
                    aria-checked={effort === e}
                    tabIndex={effort === e ? 0 : -1}
                    onClick={() => void choose(model, e)}
                  >
                    {e || 'auto'}
                  </button>
                ))}
              </div>
            </div>
          )}
          <p className="model-hint">Applies to the next message.</p>
        </div>
      )}
    </div>
  )
}

// walkRadios moves focus within a radiogroup with the arrows, Home and End;
// Space or Enter then picks. Moving doesn't pick: a pick changes the model.
function walkRadios(e: KeyboardEvent<HTMLDivElement>) {
  const radios = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')]
  const at = radios.indexOf(document.activeElement as HTMLElement)
  if (at < 0) return
  let next: number
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (at + 1) % radios.length
  else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (at - 1 + radios.length) % radios.length
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = radios.length - 1
  else return
  e.preventDefault()
  radios[next]?.focus()
}

function ModelOption(props: {
  checked: boolean
  focusable: boolean
  name: string
  description?: string
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.checked}
      tabIndex={props.focusable ? 0 : -1}
      className="model-option"
      onClick={props.onSelect}
    >
      <span className="model-radio" aria-hidden="true" />
      <span className="model-text">
        <span className="model-option-name">
          {props.name}
        </span>
        {props.description && <span className="model-desc">{props.description}</span>}
      </span>
    </button>
  )
}
