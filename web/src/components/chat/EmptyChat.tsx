import { useLayoutStore } from '../../stores/layout'
import { useSessionStore } from '../../stores/session'
import { folderNames, relativeTime, sessionTitle, startFolder } from '../../lib/sessions'
import { useNow } from '../../lib/now'
import { owesAnswer } from '../../lib/status'
import { isMac, useMedia } from './useMedia'
import Keys from '../ui/Keys'
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
  const waitingIds = new Set(pending.map((r) => r.sessionId))
  // A steady order whatever order the requests came in: the longest waiting first.
  const waiting = sessions
    .filter((x) => waitingIds.has(x.id) || owesAnswer(x))
    .sort((a, b) => (a.activeAt ?? a.createdAt ?? '').localeCompare(b.activeAt ?? b.createdAt ?? '') || a.id.localeCompare(b.id))
  const recent = [...sessions]
    .filter((x) => !x.parentId && !x.archivedAt)
    .sort((a, b) => (b.activeAt ?? b.createdAt ?? '').localeCompare(a.activeAt ?? a.createdAt ?? ''))
  const [title, list] = waiting.length ? ['Waiting for you', waiting] : ['Recent', recent]
  // Like the switcher, each row says where and when: titles alone are often
  // the same default. A worktree is named by its repository and branch.
  const now = useNow(60_000)
  const folder = startFolder(sessions)
  const shown = list.slice(0, MAX)
  const names = folderNames(shown.map(folder))
  const mod = isMac() ? '⌘' : 'Ctrl+'
  // the rest wait in the Requests inbox
  const showRequests = () => {
    if (narrow) useSessionStore.getState().setPane('requests')
    else if (useLayoutStore.getState().dock !== 'requests') useLayoutStore.getState().toggleDock('requests')
  }
  return (
    <main className="chat empty panel" aria-label="Chat">
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
              {shown.map((x) => (
                <li key={x.id}>
                  <button type="button" className="btn btn-ghost empty-session" onClick={() => void selectSession(x.id)}>
                    <span className="empty-session-title">{sessionTitle(x)}</span>
                    <span className="empty-session-meta">
                      <span title={folder(x)}>{names.get(folder(x))}</span>
                      {x.worktree && <span title={x.worktree.path}>⎇ {x.worktree.branch.replace(/^chamber\//, '')}</span>}
                      <span>{relativeTime(x.activeAt ?? x.createdAt, new Date(now))}</span>
                    </span>
                  </button>
                </li>
              ))}
              {waiting.length > MAX && list === waiting && (
                <li>
                  <button type="button" className="act-link empty-more" onClick={showRequests}>
                    +{waiting.length - MAX} more
                  </button>
                </li>
              )}
            </ul>
          </div>
        )}
        {!narrow && (
          <p className="empty-keys">
            <Keys keys={`${mod}K`} label="quick switch" />
            <Keys keys="?" label="shortcuts" />
          </p>
        )}
      </div>
    </main>
  )
}
