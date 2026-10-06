import { useSessionStore } from '../../stores/session'
import { sessionTitle } from '../../lib/sessions'
import type { Session } from '../../lib/api'
import { isMac, useMedia } from './useMedia'
import { Skeleton } from '../ui/Loading'
import './EmptyChat.css'

const MAX = 5

// EmptyChat is the document with no session open: how to start one, the
// sessions that wait for the owner (or the latest ones), and the shortcuts.
export default function EmptyChat() {
  const sessions = useSessionStore((s) => s.sessions)
  const pending = useSessionStore((s) => s.pendingRequests)
  const selectSession = useSessionStore((s) => s.selectSession)
  const status = useSessionStore((s) => s.sessionsStatus)
  // On a phone the sessions are a pane of their own, not a column on the left.
  const narrow = useMedia('(max-width: 720px)')
  const waitingIds = [...new Set(pending.map((r) => r.sessionId))]
  const waiting = waitingIds.map((id) => sessions.find((x) => x.id === id)).filter((x): x is Session => !!x)
  const recent = [...sessions]
    .filter((x) => !x.parentId && !x.archivedAt)
    .sort((a, b) => (b.activeAt ?? b.createdAt ?? '').localeCompare(a.activeAt ?? a.createdAt ?? ''))
  const [title, list] = waiting.length ? ['Waiting for you', waiting] : ['Recent', recent]
  const mod = isMac() ? '⌘' : 'Ctrl'
  return (
    <section className="chat empty panel">
      <div className="hero">
        <h2>Start a session</h2>
        <p>
          {narrow
            ? 'Pick an agent and a project folder under Sessions, or open an existing session.'
            : 'Pick an agent and a project folder on the left, or open an existing session.'}
        </p>
        {status === 'loading' && list.length === 0 && (
          <div className="empty-sessions">
            <Skeleton rows={3} label="loading sessions" />
          </div>
        )}
        {list.length > 0 && (
          <div className="empty-sessions">
            <h3 className="section-title">{title}</h3>
            <ul>
              {list.slice(0, MAX).map((x) => (
                <li key={x.id}>
                  <button type="button" className="btn btn-ghost empty-session" onClick={() => void selectSession(x.id)}>
                    {sessionTitle(x)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!narrow && (
          <p className="empty-keys">
            <span>
              <kbd>{mod}</kbd>
              <kbd>K</kbd> <span>quick switch</span>
            </span>
            <span>
              <kbd>?</kbd> <span>shortcuts</span>
            </span>
          </p>
        )}
      </div>
    </section>
  )
}
