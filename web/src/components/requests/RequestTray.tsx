import type { KeyboardEvent } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { enter } from '../../lib/motion'
import { basename } from '../../lib/format'
import type { SessionRequest } from '../../lib/api'
import { useSessionStore } from '../../stores/session'

const kindLabel: Record<string, string> = { permission: 'Permission', question: 'Question' }

// RequestTray is the global inbox of blocking requests across all sessions.
// Permissions are answered in place; questions and forms open their session.
export default function RequestTray() {
  const requests = useSessionStore((s) => s.pendingRequests)
  const sessions = useSessionStore((s) => s.sessions)
  const selectSession = useSessionStore((s) => s.selectSession)
  const respond = useSessionStore((s) => s.respond)
  const arrive = enter(useReducedMotion() ?? false, 'margin')
  if (requests.length === 0) return <p className="tray-empty">No pending requests</p>
  return (
    <aside className="request-tray panel" aria-label="Pending requests">
      <h2 className="section-title">
        Waiting for you <span className="badge">{requests.length}</span>
      </h2>
      <ul>
        <AnimatePresence initial={false}>
          {requests.map((r) => {
            const session = sessions.find((s) => s.id === r.sessionId)
            return (
              <motion.li key={`${r.sessionId}/${r.id}`} {...arrive}>
                <button
                  className="tray-row"
                  onClick={() => void selectSession(r.sessionId)}
                  onKeyDown={(e) => {
                    const perSession = r.payload?.suggestions != null || session?.agent === 'codex'
                    if (onTrayKey(e, r, perSession, respond)) e.preventDefault()
                  }}
                >
                  <span className={`request-kind kind-${r.kind}`}>{kindLabel[r.kind] ?? r.kind}</span>
                  <span className="request-label">{r.title || r.prompt || r.payload?.toolName}</span>
                  {session && <span className="request-session">{session.title || basename(session.cwd)}</span>}
                </button>
                {r.kind === 'permission' && (
                  <TrayActions request={r} perSession={r.payload?.suggestions != null || session?.agent === 'codex'} onRespond={respond} />
                )}
              </motion.li>
            )
          })}
        </AnimatePresence>
      </ul>
    </aside>
  )
}

// onTrayKey answers the focused permission (A allow, S allow for session,
// D deny), then focuses the next one, and moves between requests with the
// arrows. It reports whether it
// handled the key.
function onTrayKey(
  e: KeyboardEvent<HTMLButtonElement>,
  r: SessionRequest,
  perSession: boolean,
  respond: Respond,
): boolean {
  if (e.altKey || e.ctrlKey || e.metaKey) return false
  const rows = [...(e.currentTarget.closest('ul')?.querySelectorAll<HTMLButtonElement>('.tray-row') ?? [])]
  const at = rows.indexOf(e.currentTarget)
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    rows[at + (e.key === 'ArrowDown' ? 1 : -1)]?.focus()
    return true
  }
  if (r.kind !== 'permission') return false
  const key = e.key.toLowerCase()
  if (key === 'a') void respond(r.sessionId, r.id, { behavior: 'allow' })
  else if (key === 's' && perSession) void respond(r.sessionId, r.id, { behavior: 'allow', allowForSession: true })
  else if (key === 'd') void respond(r.sessionId, r.id, { behavior: 'deny' })
  else return false
  // the answered line is about to leave: keep the keyboard on the queue
  ;(rows[at + 1] ?? rows[at - 1])?.focus()
  return true
}

type Respond = ReturnType<typeof useSessionStore.getState>['respond']

function TrayActions(props: {
  request: SessionRequest
  perSession: boolean
  onRespond: Respond
}) {
  const { sessionId, id } = props.request
  return (
    <div className="tray-actions">
      <button className="btn btn-xs btn-primary" aria-keyshortcuts="A" onClick={() => void props.onRespond(sessionId, id, { behavior: 'allow' })}>
        Allow <kbd aria-hidden="true">A</kbd>
      </button>
      {props.perSession && (
        <button
          className="btn btn-xs"
          aria-keyshortcuts="S"
          onClick={() => void props.onRespond(sessionId, id, { behavior: 'allow', allowForSession: true })}
        >
          Allow for session <kbd aria-hidden="true">S</kbd>
        </button>
      )}
      <button className="btn btn-xs btn-danger" aria-keyshortcuts="D" onClick={() => void props.onRespond(sessionId, id, { behavior: 'deny' })}>
        Deny <kbd aria-hidden="true">D</kbd>
      </button>
    </div>
  )
}
