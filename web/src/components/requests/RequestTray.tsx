import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { enter } from '../../lib/motion'
import { basename } from '../../lib/format'
import type { RequestAnswerInput, SessionRequest } from '../../lib/api'
import { useSessionStore } from '../../stores/session'
import { notSent, shortcut } from './answer'
import './RequestTray.css'

const kindLabel: Record<string, string> = { permission: 'Permission', question: 'Question', elicitation: 'Input' }

const keyOf = (r: SessionRequest) => `${r.sessionId}/${r.id}`

// RequestTray is the global inbox of blocking requests across all sessions.
// Permissions are answered in place; questions and forms open their session.
export default function RequestTray() {
  const requests = useSessionStore((s) => s.pendingRequests)
  const sessions = useSessionStore((s) => s.sessions)
  const selectSession = useSessionStore((s) => s.selectSession)
  const respond = useSessionStore((s) => s.respond)
  const arrive = enter(useReducedMotion() ?? false, 'margin')
  // answering guards each line while its answer is on its way: the ref drops
  // a repeated key in the same tick, the state dims the line.
  const answering = useRef(new Set<string>())
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})

  // waiting says whether a line still asks: not being answered and not
  // leaving (an answered line stays in the DOM while it animates out).
  const live = useRef(requests)
  useEffect(() => {
    live.current = requests
  }, [requests])
  const waiting = (el: HTMLElement) => {
    const key = el.dataset.key ?? ''
    return el.isConnected && !answering.current.has(key) && live.current.some((r) => keyOf(r) === key)
  }

  // Forget the lines that left the queue.
  useEffect(() => {
    const live = new Set(requests.map(keyOf))
    let changed = false
    for (const k of answering.current) {
      if (!live.has(k)) {
        answering.current.delete(k)
        changed = true
      }
    }
    if (changed) setBusy(new Set(answering.current))
    setErrors((prev) => {
      const kept = Object.entries(prev).filter(([k]) => live.has(k))
      return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept)
    })
  }, [requests])

  // answer sends one line's answer. Focus stays on the line until the
  // outcome is known; once it went through, the keyboard moves on to the
  // next line still waiting.
  const answer = async (r: SessionRequest, a: RequestAnswerInput, row: HTMLElement | null) => {
    const key = keyOf(r)
    if (answering.current.has(key)) return
    answering.current.add(key)
    setBusy(new Set(answering.current))
    setErrors((prev) => (key in prev ? Object.fromEntries(Object.entries(prev).filter(([k]) => k !== key)) : prev))
    const line = row?.closest('li') ?? null
    const rows = [...(row?.closest('ul')?.querySelectorAll<HTMLElement>('.tray-row') ?? [])]
    let failure: string | null = null
    try {
      if ((await respond(r.sessionId, r.id, a)) === false) failure = notSent()
    } catch (err) {
      failure = notSent(err)
    }
    if (failure !== null) {
      answering.current.delete(key)
      setBusy(new Set(answering.current))
      setErrors((prev) => ({ ...prev, [key]: failure }))
      return
    }
    const focused = document.activeElement
    if (!row || !(focused === null || focused === document.body || line?.contains(focused))) return
    nextRow(rows, rows.indexOf(row), waiting)?.focus()
  }

  if (requests.length === 0) return <p className="tray-empty">No pending requests</p>
  return (
    <aside className="request-tray panel" aria-label="Pending requests">
      <h2 className="section-title">
        Waiting for you <span className="badge">{requests.length}</span>
      </h2>
      <ul>
        <AnimatePresence initial={false}>
          {requests.map((r) => {
            const key = keyOf(r)
            const session = sessions.find((s) => s.id === r.sessionId)
            const perSession = r.payload?.suggestions != null || session?.agent === 'codex'
            const sending = busy.has(key)
            return (
              <motion.li key={key} className={sending ? 'answering' : undefined} aria-busy={sending || undefined} {...arrive}>
                <button
                  className="tray-row"
                  data-key={key}
                  onClick={() => void selectSession(r.sessionId)}
                  onKeyDown={(e) => {
                    if (onTrayKey(e, r, perSession, answer)) e.preventDefault()
                  }}
                >
                  <span className={`request-kind kind-${r.kind}`}>{kindLabel[r.kind] ?? r.kind}</span>
                  <span className="request-label">{r.title || r.prompt || r.payload?.toolName}</span>
                  {session && <span className="request-session">{session.title || basename(session.cwd)}</span>}
                </button>
                {r.kind === 'permission' && (
                  <TrayActions
                    perSession={perSession}
                    sending={sending}
                    onAnswer={(a, el) => void answer(r, a, el.closest('li')?.querySelector<HTMLElement>('.tray-row') ?? null)}
                  />
                )}
                {errors[key] && (
                  <p className="error tray-error" role="alert">
                    {errors[key]}
                  </p>
                )}
              </motion.li>
            )
          })}
        </AnimatePresence>
      </ul>
    </aside>
  )
}

// nextRow is the waiting line after `at`, else the nearest one above it.
function nextRow(rows: HTMLElement[], at: number, waiting: (el: HTMLElement) => boolean): HTMLElement | undefined {
  for (let i = at + 1; i < rows.length; i++) if (waiting(rows[i]!)) return rows[i]
  for (let i = at - 1; i >= 0; i--) if (waiting(rows[i]!)) return rows[i]
  return undefined
}

type Answer = (r: SessionRequest, a: RequestAnswerInput, row: HTMLElement | null) => Promise<void>

// onTrayKey answers the focused permission (A allow, S allow for session,
// D deny) and moves between requests with the arrows. It reports whether it
// handled the key.
function onTrayKey(e: KeyboardEvent<HTMLButtonElement>, r: SessionRequest, perSession: boolean, answer: Answer): boolean {
  if (e.altKey || e.ctrlKey || e.metaKey) return false
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const rows = [...(e.currentTarget.closest('ul')?.querySelectorAll<HTMLButtonElement>('.tray-row') ?? [])]
    rows[rows.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)]?.focus()
    return true
  }
  if (r.kind !== 'permission') return false
  const key = shortcut(e)
  const row = e.currentTarget
  if (key === 'a') void answer(r, { behavior: 'allow' }, row)
  else if (key === 's' && perSession) void answer(r, { behavior: 'allow', allowForSession: true }, row)
  else if (key === 'd') void answer(r, { behavior: 'deny' }, row)
  else return false
  return true
}

function TrayActions(props: {
  perSession: boolean
  sending: boolean
  onAnswer: (a: RequestAnswerInput, el: HTMLElement) => void
}) {
  return (
    <div className="tray-actions">
      <button
        className="btn btn-xs btn-primary"
        aria-keyshortcuts="A"
        disabled={props.sending}
        onClick={(e) => props.onAnswer({ behavior: 'allow' }, e.currentTarget)}
      >
        Allow <kbd aria-hidden="true">A</kbd>
      </button>
      {props.perSession && (
        <button
          className="btn btn-xs"
          aria-keyshortcuts="S"
          disabled={props.sending}
          onClick={(e) => props.onAnswer({ behavior: 'allow', allowForSession: true }, e.currentTarget)}
        >
          Allow for session <kbd aria-hidden="true">S</kbd>
        </button>
      )}
      <button
        className="btn btn-xs btn-danger"
        aria-keyshortcuts="D"
        disabled={props.sending}
        onClick={(e) => props.onAnswer({ behavior: 'deny' }, e.currentTarget)}
      >
        Deny <kbd aria-hidden="true">D</kbd>
      </button>
    </div>
  )
}
