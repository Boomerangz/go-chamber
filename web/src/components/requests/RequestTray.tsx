import { basename } from '../../lib/format'
import { useSessionStore } from '../../stores/session'

const kindLabel: Record<string, string> = { permission: 'Permission', question: 'Question' }

// RequestTray is the global inbox of blocking requests across all sessions.
export default function RequestTray() {
  const requests = useSessionStore((s) => s.pendingRequests)
  const sessions = useSessionStore((s) => s.sessions)
  const selectSession = useSessionStore((s) => s.selectSession)
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
            <li key={r.id}>
              <button onClick={() => void selectSession(r.sessionId)}>
                <span className={`request-kind kind-${r.kind}`}>{kindLabel[r.kind] ?? r.kind}</span>
                <span className="request-label">{r.title || r.prompt || r.payload?.toolName}</span>
                {session && <span className="request-session">{session.title || basename(session.cwd)}</span>}
              </button>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
