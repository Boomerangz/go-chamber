import { ChevronDown } from 'lucide-react'
import { icon } from '../icon'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ModelChoice, Session } from '../../lib/api'
import { effortsFor, modelLabel } from '../../lib/models'
import { useSessionStore } from '../../stores/session'
import { LoadingLine } from '../ui/Loading'
import './ModelPicker.css'

const agentConfig = { claude: 'Claude settings', codex: 'Codex config' } as const

// ModelPicker chooses the session's model and reasoning effort. A choice
// shows at once in the "not yet settled" form until the server agrees, and
// goes back if it refuses.
export default function ModelPicker({ session }: { session: Session }) {
  const models = useSessionStore((s) => s.models[session.agent])
  const loadModels = useSessionStore((s) => s.loadModels)
  const setModel = useSessionStore((s) => s.setModel)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<ModelChoice | null>(null)
  const latest = useRef(0)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void loadModels(session.agent)
  }, [session.agent, loadModels])

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
    <div className="model-picker" ref={root}>
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
          void loadModels(session.agent)
          setOpen(true)
        }}
      >
        {pending && <span className="busy-mark" aria-hidden="true" />}
        <span className="model-name">{label}</span>
        <ChevronDown {...icon(13)} className="icon chevron" />
      </button>
      {open && (
        <div className="model-menu" role="dialog" aria-label="Choose model" ref={menu}>
          <div className="model-options" role="radiogroup" aria-label="model" onKeyDown={walkRadios}>
            <ModelOption
              checked={modelChecked('')}
              focusable={modelChecked('') || !anyModelChecked}
              name="Default"
              description={`From ${agentConfig[session.agent]}`}
              onSelect={() => void choose('', effort)}
            />
            {list.map((m) => (
              <ModelOption
                key={m.id}
                checked={modelChecked(m.id)}
                focusable={modelChecked(m.id)}
                name={m.name}
                description={m.description}
                tag={m.default ? 'default' : undefined}
                onSelect={() => void choose(m.id, effort)}
              />
            ))}
            {models === undefined && <LoadingLine>loading models…</LoadingLine>}
            {models?.length === 0 && <p className="model-none">this agent doesn't list models</p>}
          </div>
          {efforts.length > 0 && (
            <div className="effort">
              <span className="section-title">Reasoning effort</span>
              <div className="effort-options" role="radiogroup" aria-label="effort" onKeyDown={walkRadios}>
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
          <p className="model-hint">Applies from the next turn.</p>
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
  tag?: string
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
          {props.tag && <span className="model-tag">{props.tag}</span>}
        </span>
        {props.description && <span className="model-desc">{props.description}</span>}
      </span>
    </button>
  )
}
