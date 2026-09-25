import { useState } from 'react'
import type { Question, RequestAnswerInput, SessionRequest } from '../../lib/api'

export interface RequestCardProps {
  request: SessionRequest
  onRespond: (sessionId: string, requestId: string, answer: RequestAnswerInput) => void
}

// RequestCard renders a blocking agent request: a permission prompt or an
// AskUserQuestion dialog.
export default function RequestCard({ request, onRespond }: RequestCardProps) {
  if (request.kind === 'question') return <QuestionCard request={request} onRespond={onRespond} />
  return <PermissionCard request={request} onRespond={onRespond} />
}

function PermissionCard({ request, onRespond }: RequestCardProps) {
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
        <button className="btn btn-primary" onClick={() => onRespond(request.sessionId, request.id, { behavior: 'allow' })}>
          Allow
        </button>
        {request.payload?.suggestions != null && (
          <button
            className="btn"
            onClick={() => onRespond(request.sessionId, request.id, { behavior: 'allow', allowForSession: true })}
          >
            Allow for session
          </button>
        )}
        <button className="btn btn-danger deny" onClick={() => setDenying((v) => !v)}>
          Deny
        </button>
      </div>
      {denying && (
        <form
          className="deny-form"
          onSubmit={(e) => {
            e.preventDefault()
            onRespond(request.sessionId, request.id, { behavior: 'deny', message: reason })
          }}
        >
          <input
            className="field"
            aria-label="deny reason"
            placeholder="Reason (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button type="submit" className="btn btn-danger">
            Confirm deny
          </button>
        </form>
      )}
    </div>
  )
}

function QuestionCard({ request, onRespond }: RequestCardProps) {
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
      const labels = [...(selected[q.question] ?? [])]
      const custom = other[q.question]?.trim()
      if (custom) labels.push(custom)
      if (labels.length > 0) answers[q.question] = labels
    }
    onRespond(request.sessionId, request.id, { behavior: 'allow', answers })
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
                name={q.question}
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
      <button className="btn btn-primary submit-answer" onClick={submit}>
        Submit
      </button>
    </div>
  )
}
