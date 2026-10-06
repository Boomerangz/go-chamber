import { ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { archivedSessions, relativeTime, sessionTitle } from '../../lib/sessions'
import type { SessionNode } from '../../lib/tree'
import { useNow } from '../../lib/now'
import { useSessionStore } from '../../stores/session'
import { icon } from '../icon'
import SessionMenu from './SessionMenu'
import './HistoryPanel.css'
import './ArchivedSessions.css'

// ArchivedSessions folds the sessions put away from the list under
// "Archived (N)" at the bottom of the sidebar. Each one opens as usual and
// its menu brings it back or deletes it. The fold opens by itself when the
// open session is archived, so the sidebar always shows where you are.
export default function ArchivedSessions() {
  const sessions = useSessionStore((s) => s.sessions)
  const activeId = useSessionStore((s) => s.activeId)
  const selectSession = useSessionStore((s) => s.selectSession)
  const pending = useSessionStore((s) => s.pendingRequests)
  const now = useNow(60_000)
  const nodes = useMemo(() => archivedSessions(sessions), [sessions])
  // Archiving puts a session away, not its requests: they still wait here.
  const waitingBy = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of pending) m.set(r.sessionId, (m.get(r.sessionId) ?? 0) + 1)
    return m
  }, [pending])
  const waitingInside = nodes.reduce((sum, n) => sum + waitingIn(n, waitingBy), 0)
  const activeInside = useMemo(() => activeId !== null && nodes.some((n) => contains(n, activeId)), [nodes, activeId])
  const [open, setOpen] = useState(activeInside)
  // Opening an archived session unfolds the section (adjusted during render).
  const [wasInside, setWasInside] = useState(activeInside)
  if (activeInside !== wasInside) {
    setWasInside(activeInside)
    if (activeInside) setOpen(true)
  }

  if (nodes.length === 0) return null
  return (
    <details className="history archived" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="section-title">
        <ChevronRight {...icon(13)} className="icon chevron" />
        Archived <span className="group-count">{nodes.length}</span>
        {waitingInside > 0 && (
          <span className="badge" title="Requests waiting for you">
            {waitingInside}
          </span>
        )}
      </summary>
      <ul className="sessions archived-list">
        {nodes.map((node) => (
          <ArchivedRow key={node.session.id} node={node} depth={0} activeId={activeId} now={now} waitingBy={waitingBy} onSelect={(id) => void selectSession(id)} />
        ))}
      </ul>
    </details>
  )
}

function waitingIn(node: SessionNode, by: Map<string, number>): number {
  return (by.get(node.session.id) ?? 0) + node.children.reduce((sum, c) => sum + waitingIn(c, by), 0)
}

function contains(node: SessionNode, id: string): boolean {
  return node.session.id === id || node.children.some((c) => contains(c, id))
}

function ArchivedRow(props: {
  node: SessionNode
  depth: number
  activeId: string | null
  now: number
  waitingBy: Map<string, number>
  onSelect: (id: string) => void
}) {
  const s = props.node.session
  const waiting = props.waitingBy.get(s.id) ?? 0
  const active = s.id === props.activeId
  const title = sessionTitle(s)
  return (
    <li className={props.depth > 0 ? 'session-child' : undefined}>
      <button className={active ? 'session active' : 'session'} aria-current={active ? 'true' : undefined} onClick={() => props.onSelect(s.id)}>
        <span className={`avatar avatar-sm avatar-${s.agent}`} aria-hidden="true">
          {s.agent === 'claude' ? 'C' : 'X'}
        </span>
        <span className="session-text">
          <span className="session-title" title={title}>
            {title}
          </span>
          <span className="session-meta">
            {waiting > 0 ? (
              <>
                <span className="session-status session-status-waiting">waiting for you</span>
                <span className="badge" title="Requests waiting for you">
                  {waiting}
                </span>
              </>
            ) : (
              s.status === 'running' && <span className="session-status session-status-running">running</span>
            )}
            <span className="session-time">
              {s.archivedAt ? `archived ${relativeTime(s.archivedAt, new Date(props.now))}` : relativeTime(s.activeAt ?? s.createdAt, new Date(props.now))}
            </span>
          </span>
        </span>
      </button>
      <SessionMenu session={s} />
      {props.node.children.length > 0 && (
        <ul className="sessions">
          {props.node.children.map((child) => (
            <ArchivedRow key={child.session.id} {...props} node={child} depth={props.depth + 1} />
          ))}
        </ul>
      )}
    </li>
  )
}
