import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { AgentKind, Question, RequestAnswerInput, SessionRequest } from '../../lib/api'
import { editDiff } from '../../lib/diff'
import { usePending } from '../../lib/pending'
import InlineDiff from '../chat/InlineDiff'
import Markdown from '../markdown/Markdown'
import { notSent, shortcut } from './answer'
import { describeSuggestions } from './suggestions'
import './RequestCard.css'

export interface RequestCardProps {
  // position is where this card stands among the open requests, shown when
  // there are several.
  position?: { index: number; count: number }
  request: SessionRequest
  // agent owns the session; Codex always supports approving for the session.
  agent?: AgentKind
  // onRespond resolves false (or throws) when the answer didn't go through.
  onRespond: (sessionId: string, requestId: string, answer: RequestAnswerInput) => void | Promise<unknown>
}

// Action names the control that sent the answer, so only it reads "…ing".
type Action = 'allow' | 'session' | 'deny' | 'submit' | 'decline'

// RequestCard renders a blocking agent request: a permission prompt, an
// AskUserQuestion dialog or an MCP elicitation form.
export default function RequestCard(props: RequestCardProps) {
  const [acting, setActing] = useState<Action | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The card stays busy after a sent answer until request.resolved removes
  // it; usePending's ref guard also drops a same-tick double click.
  const [run] = usePending(
    async (action: Action, a: RequestAnswerInput) => {
      setActing(action)
      setError(null)
      let failure: string | null = null
      try {
        if ((await props.onRespond(props.request.sessionId, props.request.id, a)) === false) failure = notSent()
      } catch (err) {
        failure = notSent(err)
      }
      if (failure === null) return true
      setError(failure)
      setActing(null)
      return false
    },
    { holdOnSuccess: true },
  )
  const answer = async (action: Action, a: RequestAnswerInput) => {
    await run(action, a)
  }
  const inner = { ...props, acting, error, answer }
  if (props.request.kind === 'question') return <QuestionCard {...inner} />
  if (props.request.kind === 'elicitation') return <ElicitationCard {...inner} />
  return <PermissionCard {...inner} />
}

interface CardProps extends RequestCardProps {
  acting: Action | null
  error: string | null
  answer: (action: Action, a: RequestAnswerInput) => Promise<void>
}

// busyProps marks the control that sent the answer and disables the rest.
function busyProps(acting: Action | null, self: Action) {
  if (acting === self) return { 'aria-busy': true as const }
  return { disabled: acting !== null }
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p className="error request-error" role="alert">
      {error}
    </p>
  ) : null
}

const CHOICE_INPUTS = new Set(['radio', 'checkbox', 'button', 'submit'])

// typing reports whether a key goes to a text control, not to shortcuts. An
// option's radio or checkbox takes no text, so shortcuts still answer there.
function typing(target: EventTarget): boolean {
  if (target instanceof HTMLInputElement) return !CHOICE_INPUTS.has(target.type)
  return target instanceof HTMLElement && target.closest('textarea, select, [contenteditable="true"]') !== null
}

// A card that took focus from a text field ignores its single-key
// shortcuts this long, so the next letter typed doesn't answer by accident.
const ARM_MS = 600

// useFocusOnArrival brings keyboard focus to a card when it arrives, so its
// key hints work: unless the owner is writing (a text field holds text) or
// another card already has focus. It returns when shortcuts start to count.
function useFocusOnArrival(card: React.RefObject<HTMLElement | null>, target?: () => HTMLElement | null) {
  const armedAt = useRef(0)
  useEffect(() => {
    const active = document.activeElement
    const field = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
    if (field && active.value.trim()) return
    if (active instanceof HTMLElement && (active.isContentEditable || active.closest('.request'))) return
    const el = target?.() ?? card.current
    if (!el) return
    el.focus({ preventScroll: true })
    if (field) armedAt.current = Date.now() + ARM_MS
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on arrival
  }, [])
  return () => Date.now() >= armedAt.current
}

// Position is where a card stands among several open requests.
function Position({ position }: { position?: { index: number; count: number } }) {
  if (!position || position.count < 2) return null
  return (
    <span className="request-pos">
      · {position.index} of {position.count}
    </span>
  )
}

// Permission bodies read as what they are: a command as code, an edit as a
// diff; the raw input stays one click away.
function PermissionBody({ toolName, input }: { toolName?: string; input: Record<string, unknown> }) {
  const raw = JSON.stringify(input, null, 2)
  const command = typeof input.command === 'string' ? input.command : null
  const description = typeof input.description === 'string' ? input.description : null
  const diff = toolName && EDIT_TOOLS.has(toolName) ? editDiff(input) : null
  const path = [input.file_path, input.notebook_path, input.path].find((p): p is string => typeof p === 'string')
  if (command === null && !diff) return <pre className="request-input">{raw}</pre>
  return (
    <>
      {command !== null ? (
        <>
          {description && <p className="request-desc">{description}</p>}
          <pre className="request-command">
            <code>{command}</code>
          </pre>
        </>
      ) : (
        <>
          {path && <code className="request-path">{path}</code>}
          <InlineDiff lines={diff!} label={path ? `diff of ${path}` : 'diff'} />
        </>
      )}
      <details className="request-raw">
        <summary>Raw input</summary>
        <pre className="request-input">{raw}</pre>
      </details>
    </>
  )
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

// repeatsCommand: the prompt is only "<agent> wants to run: <command>" and
// the command block under it shows the command anyway.
function repeatsCommand(prompt: string, input: unknown): boolean {
  const command = (input as { command?: unknown } | undefined)?.command
  if (typeof command !== 'string' || !command.trim()) return false
  const flat = (text: string) => text.replace(/\s+/g, ' ').trim()
  const said = flat(prompt)
  const cmd = flat(command)
  if (!said.endsWith(cmd)) return false
  return /^(\S+ )?wants to (run|execute)\s*:?\s*$/i.test(said.slice(0, said.length - cmd.length))
}

function PermissionCard({ request, agent, position, acting, error, answer }: CardProps) {
  const [denying, setDenying] = useState(false)
  const [reason, setReason] = useState('')
  const denyButton = useRef<HTMLButtonElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const armed = useFocusOnArrival(card)
  const toolName = request.payload?.toolName
  // ExitPlanMode asks to leave plan mode; its plan reads better as text.
  const input = request.payload?.input as { plan?: unknown } | undefined
  const plan = toolName === 'ExitPlanMode' && typeof input?.plan === 'string' ? input.plan : null
  const perSession = request.payload?.suggestions != null || agent === 'codex'
  const grants = describeSuggestions(request.payload?.suggestions)
  const allowing = acting === 'allow' || acting === 'session'

  // The same keys as the tray: A allow, S allow for the session, D deny
  // (here it opens the reason, as the button does).
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (typing(e.target) || acting !== null || !armed()) return
    const key = shortcut(e)
    if (key === 'a') void answer('allow', { behavior: 'allow' })
    else if (key === 's' && perSession) void answer('session', { behavior: 'allow', allowForSession: true })
    else if (key === 'd') setDenying(true)
    else return
    e.preventDefault()
  }

  return (
    <div ref={card} className="request permission" tabIndex={-1} onKeyDown={onKey}>
      <header className="request-title">
        <span className="request-kw">Requires approval</span>
        <span>{request.title || toolName || 'Permission required'}</span>
        <Position position={position} />
      </header>
      {request.prompt && !repeatsCommand(request.prompt, request.payload?.input) && (
        <p className="request-prompt">{request.prompt}</p>
      )}
      {toolName && <code className="request-tool">{toolName}</code>}
      {plan !== null ? (
        <div className="request-plan">
          <Markdown text={plan} />
        </div>
      ) : (
        request.payload?.input && <PermissionBody toolName={toolName} input={request.payload.input} />
      )}
      <div className="request-actions">
        <button
          className="btn btn-primary"
          aria-keyshortcuts="A"
          {...busyProps(acting, 'allow')}
          onClick={() => void answer('allow', { behavior: 'allow' })}
        >
          {acting === 'allow' ? 'Allowing…' : 'Allow'}
          {!allowing && <kbd aria-hidden="true">A</kbd>}
        </button>
        {perSession && (
          <button
            className="btn"
            aria-keyshortcuts="S"
            aria-describedby={grants.length ? `${request.id}-grants` : undefined}
            {...busyProps(acting, 'session')}
            onClick={() => void answer('session', { behavior: 'allow', allowForSession: true })}
          >
            {acting === 'session' ? 'Allowing…' : 'Allow for session'}
            {!allowing && <kbd aria-hidden="true">S</kbd>}
          </button>
        )}
        <button
          ref={denyButton}
          className="btn btn-danger deny"
          aria-keyshortcuts="D"
          aria-expanded={denying}
          disabled={acting !== null}
          onClick={() => setDenying((v) => !v)}
        >
          Deny <kbd aria-hidden="true">D</kbd>
        </button>
      </div>
      {perSession && grants.length > 0 && (
        <p className="request-grants" id={`${request.id}-grants`}>
          for session: {grants.join(' · ')}
        </p>
      )}
      {denying && (
        <form
          className="deny-form"
          onSubmit={(e) => {
            e.preventDefault()
            void answer('deny', { behavior: 'deny', message: reason })
          }}
        >
          <input
            className="field"
            aria-label="deny reason"
            placeholder="Reason (optional)"
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              e.preventDefault()
              e.stopPropagation()
              setDenying(false)
              setReason('')
              denyButton.current?.focus()
            }}
          />
          <button type="submit" className="btn btn-danger" {...busyProps(acting, 'deny')}>
            {acting === 'deny' ? 'Denying…' : 'Confirm deny'}
          </button>
        </form>
      )}
      <ErrorLine error={error} />
    </div>
  )
}

function QuestionCard({ request, position, acting, error, answer }: CardProps) {
  const questions = request.payload?.input?.questions ?? []
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})

  const toggle = (question: string, label: string, multi: boolean) => {
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
    // A single choice is either an option or typed text, never both.
    if (!multi) setOther((prev) => ({ ...prev, [question]: '' }))
  }

  const type = (question: string, text: string, multi: boolean) => {
    setOther((prev) => ({ ...prev, [question]: text }))
    if (!multi && text.trim()) setSelected((prev) => ({ ...prev, [question]: [] }))
  }

  const labelsFor = (q: Question): string[] => {
    const custom = other[q.question]?.trim()
    const picked = selected[q.question] ?? []
    // A single-choice question takes one answer: typed text wins over the radio.
    return q.multiSelect ? [...picked, ...(custom ? [custom] : [])] : custom ? [custom] : picked.slice(0, 1)
  }
  const answered = questions.filter((q) => labelsFor(q).length > 0).length
  const complete = answered === questions.length

  const submit = () => {
    if (!complete) return
    const answers: Record<string, string[]> = {}
    for (const q of questions) {
      const labels = labelsFor(q)
      if (labels.length > 0) answers[q.question] = labels
    }
    void answer('submit', { behavior: 'allow', answers })
  }

  const form = useRef<HTMLFormElement>(null)
  const armed = useFocusOnArrival(form, () => form.current?.querySelector<HTMLElement>('.option input') ?? null)

  // 1–9 pick an option of the question that has focus (or the first one).
  const onKey = (e: KeyboardEvent<HTMLFormElement>) => {
    if (typing(e.target) || acting !== null || !armed() || e.altKey || e.ctrlKey || e.metaKey) return
    const n = Number(e.key)
    if (!Number.isInteger(n) || n < 1 || n > 9) return
    const fieldset = (e.target as HTMLElement).closest('fieldset.question') ?? form.current?.querySelector('fieldset.question')
    const index = fieldset ? [...(form.current?.querySelectorAll('fieldset.question') ?? [])].indexOf(fieldset) : -1
    const q = questions[index]
    const opt = q?.options?.[n - 1]
    if (!q || !opt) return
    e.preventDefault()
    toggle(q.question, opt.label, !!q.multiSelect)
    fieldset?.querySelectorAll<HTMLInputElement>('.option input')[n - 1]?.focus()
  }

  return (
    <form
      ref={form}
      className="request question"
      onKeyDown={onKey}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <header className="request-title">
        <span className="request-kw">Requires answer</span>
        <span>{request.title || 'Question'}</span>
        <Position position={position} />
      </header>
      {request.prompt && <p className="request-prompt">{request.prompt}</p>}
      {questions.map((q: Question) => (
        <fieldset key={q.question} className="question">
          <legend>
            {q.header && <span className="question-header">{q.header}</span>}
            {q.question}
          </legend>
          {q.options?.map((opt, i) => (
            <label key={opt.label} className="option">
              <input
                type={q.multiSelect ? 'checkbox' : 'radio'}
                name={`${request.id}:${q.question}`}
                aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}
                checked={(selected[q.question] ?? []).includes(opt.label)}
                onChange={() => toggle(q.question, opt.label, !!q.multiSelect)}
              />
              <span className="option-label">
                {opt.label}
                {i < 9 && <kbd aria-hidden="true">{i + 1}</kbd>}
              </span>
              {opt.description && <small>{opt.description}</small>}
              {opt.preview && <pre className="option-preview">{opt.preview}</pre>}
            </label>
          ))}
          <label className="other">
            <input
              className="field"
              type="text"
              aria-label={`other ${q.question}`}
              placeholder="Other…"
              value={other[q.question] ?? ''}
              onChange={(e) => type(q.question, e.target.value, !!q.multiSelect)}
            />
          </label>
        </fieldset>
      ))}
      <div className="request-actions">
        <button
          type="submit"
          className="btn btn-primary submit-answer"
          {...(acting === 'submit' ? { 'aria-busy': true as const } : { disabled: acting !== null || !complete })}
        >
          {acting === 'submit' ? 'Sending…' : 'Submit'}
        </button>
        <button
          type="button"
          className="btn skip-answer"
          {...busyProps(acting, 'decline')}
          onClick={() => void answer('decline', { behavior: 'deny' })}
        >
          {acting === 'decline' ? 'Skipping…' : 'Skip'}
        </button>
        {!complete && (
          <span className="request-meta">
            {answered} of {questions.length} answered
          </span>
        )}
      </div>
      <ErrorLine error={error} />
    </form>
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
function ElicitationCard({ request, acting, error, answer }: CardProps) {
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
    void answer('submit', { behavior: 'allow', content })
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
        <button type="submit" className="btn btn-primary" {...busyProps(acting, 'submit')}>
          {acting === 'submit' ? 'Sending…' : 'Accept'}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          {...busyProps(acting, 'decline')}
          onClick={() => void answer('decline', { behavior: 'deny' })}
        >
          {acting === 'decline' ? 'Declining…' : 'Decline'}
        </button>
      </div>
      <ErrorLine error={error} />
    </form>
  )
}
