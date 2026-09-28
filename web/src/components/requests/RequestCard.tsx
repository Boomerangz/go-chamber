import { useState } from 'react'
import type { AgentKind, Question, RequestAnswerInput, SessionRequest } from '../../lib/api'

export interface RequestCardProps {
  request: SessionRequest
  // agent owns the session; Codex always supports approving for the session.
  agent?: AgentKind
  onRespond: (sessionId: string, requestId: string, answer: RequestAnswerInput) => void | Promise<unknown>
}

// RequestCard renders a blocking agent request: a permission prompt, an
// AskUserQuestion dialog or an MCP elicitation form.
export default function RequestCard(props: RequestCardProps) {
  const [busy, setBusy] = useState(false)
  // answer disables the card until the server accepted the answer, so a
  // double click doesn't send it twice.
  const answer = async (a: RequestAnswerInput) => {
    if (busy) return
    setBusy(true)
    try {
      await props.onRespond(props.request.sessionId, props.request.id, a)
    } finally {
      setBusy(false)
    }
  }
  const inner = { ...props, busy, answer }
  if (props.request.kind === 'question') return <QuestionCard {...inner} />
  if (props.request.kind === 'elicitation') return <ElicitationCard {...inner} />
  return <PermissionCard {...inner} />
}

interface CardProps extends RequestCardProps {
  busy: boolean
  answer: (a: RequestAnswerInput) => Promise<void>
}

function PermissionCard({ request, agent, busy, answer }: CardProps) {
  const [denying, setDenying] = useState(false)
  const [reason, setReason] = useState('')
  const toolName = request.payload?.toolName
  return (
    <div className="request permission">
      <header className="request-title">
        <span className="request-kw">Requires approval</span>
        <span>{request.title || toolName || 'Permission required'}</span>
      </header>
      {request.prompt && <p className="request-prompt">{request.prompt}</p>}
      {toolName && <code className="request-tool">{toolName}</code>}
      {request.payload?.input && <pre className="request-input">{JSON.stringify(request.payload.input, null, 2)}</pre>}
      <div className="request-actions">
        <button className="btn btn-primary" disabled={busy} onClick={() => void answer({ behavior: 'allow' })}>
          Allow
        </button>
        {(request.payload?.suggestions != null || agent === 'codex') && (
          <button
            className="btn"
            disabled={busy}
            onClick={() => void answer({ behavior: 'allow', allowForSession: true })}
          >
            Allow for session
          </button>
        )}
        <button className="btn btn-danger deny" disabled={busy} onClick={() => setDenying((v) => !v)}>
          Deny
        </button>
      </div>
      {denying && (
        <form
          className="deny-form"
          onSubmit={(e) => {
            e.preventDefault()
            void answer({ behavior: 'deny', message: reason })
          }}
        >
          <input
            className="field"
            aria-label="deny reason"
            placeholder="Reason (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button type="submit" className="btn btn-danger" disabled={busy}>
            Confirm deny
          </button>
        </form>
      )}
    </div>
  )
}

function QuestionCard({ request, busy, answer }: CardProps) {
  const questions = request.payload?.input?.questions ?? []
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})

  const toggle = (question: string, label: string, multi: boolean) =>
    setSelected((prev) => {
      const current = prev[question] ?? []
      if (multi) {
        return {
          ...prev,
          [question]: current.includes(label) ? current.filter((l) => l !== label) : [...current, label],
        }
      }
      return { ...prev, [question]: [label] }
    })

  const submit = () => {
    const answers: Record<string, string[]> = {}
    for (const q of questions) {
      const custom = other[q.question]?.trim()
      const picked = selected[q.question] ?? []
      // A single-choice question takes one answer: typed text wins over the radio.
      const labels = q.multiSelect ? [...picked, ...(custom ? [custom] : [])] : custom ? [custom] : picked.slice(0, 1)
      if (labels.length > 0) answers[q.question] = labels
    }
    void answer({ behavior: 'allow', answers })
  }

  return (
    <div className="request question">
      <header className="request-title">
        <span className="request-kw">Requires answer</span>
        <span>{request.title || 'Question'}</span>
      </header>
      {request.prompt && <p className="request-prompt">{request.prompt}</p>}
      {questions.map((q: Question) => (
        <fieldset key={q.question} className="question">
          <legend>{q.question}</legend>
          {q.options?.map((opt) => (
            <label key={opt.label} className="option">
              <input
                type={q.multiSelect ? 'checkbox' : 'radio'}
                name={`${request.id}:${q.question}`}
                checked={(selected[q.question] ?? []).includes(opt.label)}
                onChange={() => toggle(q.question, opt.label, !!q.multiSelect)}
              />
              <span className="option-label">{opt.label}</span>
              {opt.description && <small>{opt.description}</small>}
            </label>
          ))}
          <label className="other">
            <input
              className="field"
              type="text"
              aria-label={`other ${q.question}`}
              placeholder="Other…"
              value={other[q.question] ?? ''}
              onChange={(e) => setOther((prev) => ({ ...prev, [q.question]: e.target.value }))}
            />
          </label>
        </fieldset>
      ))}
      <button className="btn btn-primary submit-answer" disabled={busy} onClick={submit}>
        Submit
      </button>
    </div>
  )
}

interface SchemaField {
  type?: string
  title?: string
  description?: string
  enum?: string[]
}

interface ElicitationPayload {
  message?: string
  requestedSchema?: { properties?: Record<string, SchemaField>; required?: string[] }
}

// ElicitationCard renders an MCP elicitation's flat form schema (string,
// number, integer, boolean, enum) and returns the values as content.
function ElicitationCard({ request, busy, answer }: CardProps) {
  const payload = (request.payload ?? {}) as ElicitationPayload
  const fields = Object.entries(payload.requestedSchema?.properties ?? {})
  const required = new Set(payload.requestedSchema?.required ?? [])
  const [values, setValues] = useState<Record<string, string | boolean>>({})
  const set = (name: string, v: string | boolean) => setValues((prev) => ({ ...prev, [name]: v }))

  const submit = () => {
    const content: Record<string, unknown> = {}
    for (const [name, f] of fields) {
      const v = f.type === 'boolean' ? !!values[name] : values[name]
      if (v === undefined || v === '') continue
      content[name] = f.type === 'number' || f.type === 'integer' ? Number(v) : v
    }
    void answer({ behavior: 'allow', content })
  }

  return (
    <form
      className="request elicitation"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <header className="request-title">
        <span className="request-kw">Requires input</span>
        <span>{request.title || 'Input requested'}</span>
      </header>
      {payload.message && payload.message !== request.title && <p className="request-prompt">{payload.message}</p>}
      {fields.map(([name, f]) => {
        const label = f.title || name
        const common = { id: `${request.id}:${name}`, 'aria-label': label, required: required.has(name) }
        return (
          <label key={name} className="field-row">
            <span>{label}</span>
            {f.type === 'boolean' ? (
              <input {...common} required={false} type="checkbox" checked={!!values[name]} onChange={(e) => set(name, e.target.checked)} />
            ) : f.enum ? (
              <select {...common} className="field" value={String(values[name] ?? '')} onChange={(e) => set(name, e.target.value)}>
                <option value="" />
                {f.enum.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                {...common}
                className="field"
                type={f.type === 'number' || f.type === 'integer' ? 'number' : 'text'}
                value={String(values[name] ?? '')}
                onChange={(e) => set(name, e.target.value)}
              />
            )}
            {f.description && <small>{f.description}</small>}
          </label>
        )
      })}
      <div className="request-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Accept
        </button>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void answer({ behavior: 'deny' })}>
          Decline
        </button>
      </div>
    </form>
  )
}
