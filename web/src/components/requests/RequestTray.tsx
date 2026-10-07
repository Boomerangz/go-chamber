import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { enter } from '../../lib/motion'
import { basename } from '../../lib/format'
import { usePending } from '../../lib/pending'
import { continueSession, type RequestAnswerInput, type Session, type SessionRequest } from '../../lib/api'
import { owesAnswer } from '../../lib/status'
import { fail } from '../../stores/notices'
import { useSessionStore } from '../../stores/session'
import { LoadFailed, Skeleton } from '../ui/Loading'
import { notSent, shortcut } from './answer'
import { requestGist } from './gist'
import './RequestTray.css'

// The kind says what the request requires, as its block does ("Requires approval").
const kindLabel: Record<string, string> = { permission: 'Approval', question: 'Answer', elicitation: 'Input' }

const keyOf = (r: SessionRequest) => `${r.sessionId}/${r.id}`

// Action names the control that sent the answer, so only it reads "…ing".
type Action = 'allow' | 'session' | 'deny'

// RequestTray is the global inbox of blocking requests across all sessions.
// Permissions are answered in place; questions and forms open their session.
export default function RequestTray() {
  const requests = useSessionStore((s) => s.pendingRequests)
  const status = useSessionStore((s) => s.requestsStatus)
  const loadRequests = useSessionStore((s) => s.loadRequests)
  const sessions = useSessionStore((s) => s.sessions)
  // Turns cut off (a restart, a crash) while they waited for the owner: the
  // request went with them, but the owner still owes them an answer.
  const owed = sessions.filter(owesAnswer)

  // waiting says whether a line still asks: not being answered and not
  // leaving (an answered line stays in the DOM while it animates out).
  const live = useRef(requests)
  useEffect(() => {
    live.current = requests
  }, [requests])
  const waiting = (el: HTMLElement) => {
    const key = el.dataset.key ?? ''
    return (
      el.isConnected &&
      el.closest('li')?.getAttribute('aria-busy') !== 'true' &&
      live.current.some((r) => keyOf(r) === key)
    )
  }

  // Focus in the tray stays in the tray, never drops to the page: with no
  // line left to move on to after a keyboard answer it rests on the tray,
  // and when what held it leaves (its line answered here or elsewhere, the
  // list giving way to the empty tray) it moves to the tray, or to what the
  // tray says once empty. Not to a line: a stray key would answer it.
  const region = useRef<HTMLElement | null>(null)
  const empty = useRef<HTMLElement | null>(null)
  const held = useRef<Element | null>(null)
  const setEmpty = (el: HTMLElement | null) => void (empty.current = el)
  const settle = () => (region.current ?? empty.current)?.focus()
  const onFocus = (e: { target: Element }) => void (held.current = e.target)
  const recover = useRef(() => {})
  recover.current = () => {
    const was = held.current
    const active = document.activeElement
    if (!was || was.isConnected || (active && active !== document.body)) return
    held.current = null
    settle()
  }
  // A list that gives way to another root, or a line that leaves once its
  // exit has played (no render of the tray marks that).
  useLayoutEffect(() => recover.current())
  const none = requests.length === 0 && owed.length === 0
  useEffect(() => {
    const el = region.current
    if (!el || typeof MutationObserver !== 'function') return
    const watch = new MutationObserver(() => recover.current())
    watch.observe(el, { childList: true, subtree: true })
    return () => watch.disconnect()
  }, [none])

  // This is what needs the owner: until it loaded, an empty inbox would be
  // a false all-clear.
  const failed = status === 'error' && (
    <LoadFailed onRetry={() => void loadRequests()}>Couldn't load requests</LoadFailed>
  )
  if (none) {
    if (status === 'loading')
      return (
        <div className="tray-empty" ref={setEmpty} tabIndex={-1} onFocus={onFocus}>
          <Skeleton rows={2} label="loading requests" />
        </div>
      )
    if (failed)
      return (
        <div className="tray-empty" ref={setEmpty} tabIndex={-1} onFocus={onFocus}>
          {failed}
        </div>
      )
    return (
      <p className="tray-empty" ref={setEmpty} tabIndex={-1} onFocus={onFocus}>
        No pending requests
      </p>
    )
  }
  return (
    <aside className="request-tray panel" aria-label="Pending requests" ref={region} tabIndex={-1} onFocus={onFocus}>
      <h2 className="section-title">
        Waiting for you <span className="badge">{requests.length + owed.length}</span>
      </h2>
      {failed}
      <ul>
        <AnimatePresence initial={false}>
          {requests.map((r) => (
            <TrayLine
              key={keyOf(r)}
              request={r}
              session={sessions.find((s) => s.id === r.sessionId)}
              waiting={waiting}
              settle={settle}
            />
          ))}
          {owed.map((s) => (
            <OwedLine key={`owed/${s.id}`} session={s} />
          ))}
        </AnimatePresence>
      </ul>
    </aside>
  )
}

// TrayLine is one request. While its answer is on its way the line dims and
// holds its buttons; once it went through it stays held until it leaves the
// queue, or until the hold times out (the live socket may be down), when it
// says it was sent and waits on the agent.
function TrayLine({
  request: r,
  session,
  waiting,
  settle,
}: {
  request: SessionRequest
  session: Session | undefined
  waiting: (el: HTMLElement) => boolean
  // settle takes focus when no line is left to move on to.
  settle: () => void
}) {
  const selectSession = useSessionStore((s) => s.selectSession)
  const respond = useSessionStore((s) => s.respond)
  const arrive = enter(useReducedMotion() ?? false, 'margin')
  const perSession = r.payload?.suggestions != null || session?.agent === 'codex'
  const [acting, setActing] = useState<Action | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [run, sending, stillWaiting] = usePending(
    async (action: Action, a: RequestAnswerInput) => {
      setActing(action)
      setError(null)
      let failure: string | null = null
      try {
        if ((await respond(r.sessionId, r.id, a)) === false) failure = notSent()
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

  // answer sends the line's answer. Focus stays on the line until the
  // outcome is known; once it went through, the keyboard moves on to the
  // next line still waiting, or with none left stays in the tray.
  const answer = async (action: Action, a: RequestAnswerInput, row: HTMLElement | null) => {
    const line = row?.closest('li') ?? null
    const rows = [...(row?.closest('ul')?.querySelectorAll<HTMLElement>('.tray-row') ?? [])]
    if ((await run(action, a)) !== true) return
    const focused = document.activeElement
    if (!row || !(focused === null || focused === document.body || line?.contains(focused))) return
    const next = nextRow(rows, rows.indexOf(row), waiting)
    if (next) next.focus()
    else settle()
  }

  const key = keyOf(r)
  const where = session ? session.title || basename(session.cwd) : null
  const gist = requestGist(r)
  return (
    <motion.li className={sending ? 'answering' : undefined} aria-busy={sending || undefined} {...arrive}>
      <button
        className="tray-row"
        data-key={key}
        onClick={() => void selectSession(r.sessionId)}
        onKeyDown={(e) => {
          if (onTrayKey(e, r, perSession, answer)) e.preventDefault()
        }}
      >
        <span className={`request-kind kind-${r.kind}`}>{kindLabel[r.kind] ?? r.kind}</span>
        <span className="request-label" title={gist}>
          {gist}
        </span>
        {where && (
          <span className="request-session" title={where}>
            {where}
          </span>
        )}
      </button>
      {r.kind === 'permission' && (
        <TrayActions
          perSession={perSession}
          acting={sending ? acting : null}
          onAnswer={(action, a, el) =>
            void answer(action, a, el.closest('li')?.querySelector<HTMLElement>('.tray-row') ?? null)
          }
        />
      )}
      {error && (
        <p className="error tray-error" role="alert">
          {error}
        </p>
      )}
      {stillWaiting && !sending && !error && (
        <p className="tray-waiting" role="status">
          sent · waiting for agent
        </p>
      )}
    </motion.li>
  )
}

// OwedLine is a session whose turn was cut off while it waited for the
// owner: it opens the session, or continues it in place.
function OwedLine({ session }: { session: Session }) {
  const selectSession = useSessionStore((s) => s.selectSession)
  const arrive = enter(useReducedMotion() ?? false, 'margin')
  // The line leaves once the session runs again; until then Continue holds.
  const [resume, continuing] = usePending(
    async () => {
      try {
        await continueSession(session.id)
        return true
      } catch (err) {
        fail("Couldn't continue", err)
        return false
      }
    },
    { holdOnSuccess: true },
  )
  const name = session.title || basename(session.cwd)
  // What the stopped request asked leads, as a live one's gist does.
  const asked = session.interruption?.request?.trim() || 'stopped while waiting for you'
  return (
    <motion.li {...arrive}>
      <button className="tray-row" data-key={`owed/${session.id}`} onClick={() => void selectSession(session.id)}>
        <span className="request-kind kind-interrupted">Interrupted</span>
        <span className="request-label" title={asked}>
          {asked}
        </span>
        <span className="request-session" title={name}>
          {name}
        </span>
      </button>
      <div className="tray-actions">
        <button className="btn btn-xs btn-primary" aria-busy={continuing} onClick={() => void resume()}>
          {continuing ? 'Continuing…' : 'Continue'}
        </button>
      </div>
    </motion.li>
  )
}

// nextRow is the waiting line after `at`, else the nearest one above it.
function nextRow(rows: HTMLElement[], at: number, waiting: (el: HTMLElement) => boolean): HTMLElement | undefined {
  for (let i = at + 1; i < rows.length; i++) if (waiting(rows[i]!)) return rows[i]
  for (let i = at - 1; i >= 0; i--) if (waiting(rows[i]!)) return rows[i]
  return undefined
}

type Answer = (action: Action, a: RequestAnswerInput, row: HTMLElement | null) => Promise<void>

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
  if (key === 'a') void answer('allow', { behavior: 'allow' }, row)
  else if (key === 's' && perSession) void answer('session', { behavior: 'allow', allowForSession: true }, row)
  else if (key === 'd') void answer('deny', { behavior: 'deny' }, row)
  else return false
  return true
}

// busyProps marks the control that sent the answer and holds the rest.
function busyProps(acting: Action | null, self: Action) {
  if (acting === self) return { 'aria-busy': true as const }
  return { disabled: acting !== null }
}

function TrayActions(props: {
  perSession: boolean
  acting: Action | null
  onAnswer: (action: Action, a: RequestAnswerInput, el: HTMLElement) => void
}) {
  const { acting } = props
  return (
    <div className="tray-actions">
      <button
        className="btn btn-xs btn-primary"
        aria-keyshortcuts="A"
        {...busyProps(acting, 'allow')}
        onClick={(e) => props.onAnswer('allow', { behavior: 'allow' }, e.currentTarget)}
      >
        {acting === 'allow' ? 'Allowing…' : 'Allow'}
        {!acting && <kbd aria-hidden="true">A</kbd>}
      </button>
      {props.perSession && (
        <button
          className="btn btn-xs"
          aria-keyshortcuts="S"
          {...busyProps(acting, 'session')}
          onClick={(e) => props.onAnswer('session', { behavior: 'allow', allowForSession: true }, e.currentTarget)}
        >
          {acting === 'session' ? 'Allowing…' : 'Allow for session'}
          {!acting && <kbd aria-hidden="true">S</kbd>}
        </button>
      )}
      <button
        className="btn btn-xs btn-danger"
        aria-keyshortcuts="D"
        {...busyProps(acting, 'deny')}
        onClick={(e) => props.onAnswer('deny', { behavior: 'deny' }, e.currentTarget)}
      >
        {acting === 'deny' ? 'Denying…' : 'Deny'}
        {!acting && <kbd aria-hidden="true">D</kbd>}
      </button>
    </div>
  )
}
