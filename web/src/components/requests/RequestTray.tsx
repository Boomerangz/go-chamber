import { useSessionStore } from '../../stores/session'

// RequestTray is the global inbox of blocking requests across all sessions.
export default function RequestTray() {
  const requests = useSessionStore((s) => s.pendingRequests)
  const selectSession = useSessionStore((s) => s.selectSession)
  if (requests.length === 0) return null
  return (
    <aside className="request-tray" aria-label="Pending requests">
      <h2>Requests ({requests.length})</h2>
      <ul>
        {requests.map((r) => (
          <li key={r.id}>
            <button onClick={() => void selectSession(r.sessionId)}>
              <span className={`request-kind kind-${r.kind}`}>{r.kind}</span>
              <span className="request-label">{r.title || r.prompt || r.payload?.toolName}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}
