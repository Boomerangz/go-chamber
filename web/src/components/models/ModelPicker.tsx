import { useEffect, useRef, useState } from 'react'
import type { Session } from '../../lib/api'
import { effortsFor, modelLabel } from '../../lib/models'
import { useSessionStore } from '../../stores/session'

const agentConfig = { claude: 'Claude settings', codex: 'Codex config' } as const


// ModelPicker chooses the session's model and reasoning effort.
export default function ModelPicker({ session }: { session: Session }) {
  const models = useSessionStore((s) => s.models[session.agent])
  const loadModels = useSessionStore((s) => s.loadModels)
  const setModel = useSessionStore((s) => s.setModel)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void loadModels(session.agent)
  }, [session.agent, loadModels])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const list = models ?? []
  const model = session.model ?? ''
  const effort = session.effort ?? ''
  const efforts = effortsFor(list, model)

  const choose = (nextModel: string, nextEffort: string) => {
    // Drop an effort the new model doesn't accept.
    const allowed = effortsFor(list, nextModel)
    const e = allowed.includes(nextEffort) ? nextEffort : ''
    setOpen(false)
    if (nextModel !== model || e !== effort) void setModel(session.id, { model: nextModel, effort: e })
  }

  return (
    <div className="model-picker" ref={root}>
      <button
        type="button"
        className="model-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Model: ${modelLabel(list, session)}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="model-spark" aria-hidden="true" />
        <span className="model-name">{modelLabel(list, session)}</span>
        <span className="chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="model-menu" role="dialog" aria-label="Choose model">
          <div className="model-options" role="radiogroup" aria-label="model">
            <ModelOption
              checked={model === ''}
              name="Default"
              description={`From ${agentConfig[session.agent]}`}
              onSelect={() => choose('', effort)}
            />
            {list.map((m) => (
              <ModelOption
                key={m.id}
                checked={model === m.id}
                name={m.name}
                description={m.description}
                tag={m.default ? 'default' : undefined}
                onSelect={() => choose(m.id, effort)}
              />
            ))}
          </div>
          {efforts.length > 0 && (
            <div className="effort">
              <span className="section-title">Reasoning effort</span>
              <div className="effort-options" role="radiogroup" aria-label="effort">
                {['', ...efforts].map((e) => (
                  <button
                    key={e || 'auto'}
                    type="button"
                    role="radio"
                    aria-checked={effort === e}
                    onClick={() => choose(model, e)}
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

function ModelOption(props: {
  checked: boolean
  name: string
  description?: string
  tag?: string
  onSelect: () => void
}) {
  return (
    <button type="button" role="radio" aria-checked={props.checked} className="model-option" onClick={props.onSelect}>
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
