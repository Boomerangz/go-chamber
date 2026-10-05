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
  if (requests.length === 0) return <p className="tray-empty">No pending requests</p>
  return (
    <aside className="request-tray panel" aria-label="Pending requests">
      <h2 className="section-title">
        Waiting for you <span className="badge">{requests.length}</span>
      </h2>
      <ul>
        {requests.map((r) => {
          const session = sessions.find((s) => s.id === r.sessionId)
          return (
            <li key={`${r.sessionId}/${r.id}`}>
              <button onClick={() => void selectSession(r.sessionId)}>
                <span className={`request-kind kind-${r.kind}`}>{kindLabel[r.kind] ?? r.kind}</span>
                <span className="request-label">{r.title || r.prompt || r.payload?.toolName}</span>
                {session && <span className="request-session">{session.title || basename(session.cwd)}</span>}
              </button>
              {r.kind === 'permission' && (
                <TrayActions request={r} perSession={r.payload?.suggestions != null || session?.agent === 'codex'} onRespond={respond} />
              )}
            </li>
          )
        })}
      </ul>
    </aside>
  )
}

function TrayActions(props: {
  request: SessionRequest
  perSession: boolean
  onRespond: ReturnType<typeof useSessionStore.getState>['respond']
}) {
  const { sessionId, id } = props.request
  return (
    <div className="tray-actions">
      <button className="btn btn-xs btn-primary" onClick={() => void props.onRespond(sessionId, id, { behavior: 'allow' })}>
        Allow
      </button>
      {props.perSession && (
        <button
          className="btn btn-xs"
          onClick={() => void props.onRespond(sessionId, id, { behavior: 'allow', allowForSession: true })}
        >
          Allow for session
        </button>
      )}
      <button className="btn btn-xs btn-danger" onClick={() => void props.onRespond(sessionId, id, { behavior: 'deny' })}>
        Deny
      </button>
    </div>
  )
}
