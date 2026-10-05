import { ChevronDown, Plus, Search } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { icon } from '../icon'
import { Fragment, useEffect, useMemo } from 'react'
import type { SearchHit, Session } from '../../lib/api'
import {
  bucketOf,
  groupSessions,
  matchesQuery,
  relativeTime,
  sessionTitle,
  snippetParts,
  visibleInGroup,
  type GroupMode,
  type SessionGroup,
} from '../../lib/sessions'
import type { SessionNode } from '../../lib/tree'
import { settle } from '../../lib/motion'
import { useJustFinished } from '../../lib/finished'
import { useSessionStore } from '../../stores/session'

// RECENT is how many sessions an expanded project shows before "older".
const RECENT = 5

export interface SessionListProps {
  onCreateIn: (cwd: string) => void
}

// SessionList shows sessions grouped by project folder. Each group is
// collapsed, shows its recent sessions, or everything with time dividers.
export default function SessionList({ onCreateIn }: SessionListProps) {
  const sessions = useSessionStore((s) => s.sessions)
  const activeId = useSessionStore((s) => s.activeId)
  const query = useSessionStore((s) => s.query)
  const setQuery = useSessionStore((s) => s.setQuery)
  const groupModes = useSessionStore((s) => s.groupModes)
  const setGroupMode = useSessionStore((s) => s.setGroupMode)
  const pending = useSessionStore((s) => s.pendingRequests)
  const selectSession = useSessionStore((s) => s.selectSession)
  const searchHits = useSessionStore((s) => s.searchHits)
  const searchMessages = useSessionStore((s) => s.searchMessages)

  const searching = query.trim() !== ''

  // Message search runs on the server, a moment after typing stops.
  useEffect(() => {
    const timer = setTimeout(() => void searchMessages(query), 250)
    return () => clearTimeout(timer)
  }, [query, searchMessages])
  const groups = useMemo(() => {
    if (!searching) return groupSessions(sessions)
    // Keep parents of matching children so the tree stays intact.
    const ids = new Set<string>()
    for (const session of sessions) {
      if (!matchesQuery(session, query)) continue
      ids.add(session.id)
      if (session.parentId) ids.add(session.parentId)
    }
    const withParents = sessions.filter((s) => ids.has(s.id))
    return groupSessions(withParents)
  }, [sessions, query, searching])

  const pendingBySession = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of pending) m.set(r.sessionId, (m.get(r.sessionId) ?? 0) + 1)
    return m
  }, [pending])

  return (
    <>
      <div className="session-search">
        <Search {...icon(14)} />
        <input
          type="search"
          aria-label="search sessions"
          placeholder="Search sessions"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
        />
      </div>
      <div className="groups">
        {groups.map((g) => (
          <Group
            key={g.cwd}
            group={g}
            mode={searching ? 'all' : groupModes[g.cwd] ?? 'recent'}
            searching={searching}
            activeId={activeId}
            pendingBySession={pendingBySession}
            onMode={(mode) => setGroupMode(g.cwd, mode)}
            onSelect={(id) => void selectSession(id)}
            onCreateIn={onCreateIn}
          />
        ))}
        {searching && (
          <MessageHits
            hits={searchHits}
            sessions={sessions}
            activeId={activeId}
            onSelect={(id) => void selectSession(id)}
          />
        )}
        {groups.length === 0 && (!searching || searchHits.length === 0) && (
          <p className="sessions-empty">{searching ? 'No matching sessions' : 'No sessions yet'}</p>
        )}
      </div>
    </>
  )
}

function Group(props: {
  group: SessionGroup
  mode: GroupMode
  searching: boolean
  activeId: string | null
  pendingBySession: Map<string, number>
  onMode: (mode: GroupMode) => void
  onSelect: (id: string) => void
  onCreateIn: (cwd: string) => void
}) {
  const { group, mode, activeId } = props
  const { shown, hidden } = visibleInGroup(group, mode, RECENT, activeId)
  const waiting = group.nodes.reduce((n, node) => n + pendingIn(node, props.pendingBySession), 0)
  const open = mode !== 'collapsed'
  const buckets = shown.map((n) => bucketOf(n.session.activeAt ?? n.session.createdAt))
  const dividers = mode === 'all' && !props.searching && group.count > RECENT

  return (
    <section className="group" data-mode={mode} aria-label={`Project ${group.name}`}>
      <header className="group-header">
        <button
          className="group-toggle"
          aria-expanded={open}
          title={group.cwd}
          onClick={() => props.onMode(open ? 'collapsed' : 'recent')}
          disabled={props.searching}
        >
          <ChevronDown {...icon(13)} className="icon chevron" />
          <span className="group-name">{group.name}</span>
          <span className="sr-only"> {group.cwd}</span>
          <span className="group-count">{group.count}</span>
          {group.running && <span className="live-dot" title="A session is running" />}
          {waiting > 0 && (
            <span className="badge" title="Waiting for you">
              {waiting}
            </span>
          )}
        </button>
        <button
          className="btn btn-ghost btn-icon group-new"
          aria-label={`New session in ${group.name}`}
          title={`New session in ${group.cwd}`}
          onClick={() => props.onCreateIn(group.cwd)}
        >
          <Plus {...icon(15)} />
        </button>
      </header>
      {shown.length > 0 && (
        <ul className="sessions">
          {shown.map((node, i) => {
            const divider = dividers && buckets[i] !== buckets[i - 1]
            return (
              <Fragment key={node.session.id}>
                {divider && (
                  <li className="bucket" aria-hidden="true">
                    {buckets[i]}
                  </li>
                )}
                <SessionRow node={node} depth={0} {...props} />
              </Fragment>
            )
          })}
        </ul>
      )}
      {!props.searching && open && (hidden > 0 || (mode === 'all' && group.count > RECENT)) && (
        <button className="group-more" onClick={() => props.onMode(hidden > 0 ? 'all' : 'recent')}>
          {hidden > 0 ? `Show ${hidden} older` : 'Show less'}
        </button>
      )}
    </section>
  )
}

function pendingIn(node: SessionNode, bySession: Map<string, number>): number {
  return (bySession.get(node.session.id) ?? 0) + node.children.reduce((n, c) => n + pendingIn(c, bySession), 0)
}

function SessionRow(props: {
  node: SessionNode
  depth: number
  activeId: string | null
  pendingBySession: Map<string, number>
  onSelect: (id: string) => void
}) {
  const s = props.node.session
  const waiting = props.pendingBySession.get(s.id) ?? 0
  const reduced = useReducedMotion() ?? false
  const finished = useJustFinished(s.status)
  return (
    <motion.li layout="position" transition={settle(reduced)} className={props.depth > 0 ? 'session-child' : undefined}>
      <button
        className={s.id === props.activeId ? 'session active' : 'session'}
        aria-current={s.id === props.activeId ? 'true' : undefined}
        onClick={() => props.onSelect(s.id)}
      >
        <span className={`avatar avatar-sm avatar-${s.agent}`} aria-hidden="true">
          {s.agent === 'claude' ? 'C' : 'X'}
        </span>
        <span className="session-text">
          <span className="session-title">{sessionTitle(s)}</span>
          <span className="session-meta">
            {(s.status === 'running' || s.status === 'interrupted' || finished) && (
              <span className={`session-status session-status-${finished ? 'done' : s.status}`}>{finished ? 'done' : s.status}</span>
            )}
            {s.forkOf && (
              <span className="session-fork" title="Forked from another session">
                fork
              </span>
            )}
            <span className="session-time">{relativeTime(s.activeAt ?? s.createdAt)}</span>
          </span>
        </span>
        <span className="session-badge">{waiting > 0 && <span className="badge">{waiting}</span>}</span>
      </button>
      {props.node.children.length > 0 && (
        <ul className="sessions">
          {props.node.children.map((child) => (
            <SessionRow key={child.session.id} {...props} node={child} depth={props.depth + 1} />
          ))}
        </ul>
      )}
    </motion.li>
  )
}

function MessageHits(props: {
  hits: SearchHit[]
  sessions: Session[]
  activeId: string | null
  onSelect: (id: string) => void
}) {
  const rows = props.hits
    .map((hit) => ({ hit, session: props.sessions.find((s) => s.id === hit.sessionId) }))
    .filter((r): r is { hit: SearchHit; session: Session } => r.session !== undefined)
  if (rows.length === 0) return null
  return (
    <section className="message-hits" aria-label="Message matches">
      <h3 className="section-title">In messages</h3>
      <ul className="sessions">
        {rows.map(({ hit, session }) => (
          <li key={hit.sessionId}>
            <button
              className={session.id === props.activeId ? 'session hit active' : 'session hit'}
              onClick={() => props.onSelect(session.id)}
            >
              <span className={`avatar avatar-sm avatar-${session.agent}`} aria-hidden="true">
                {session.agent === 'claude' ? 'C' : 'X'}
              </span>
              <span className="session-text">
                <span className="session-title">{sessionTitle(session)}</span>
                <span className="snippet">
                  {snippetParts(hit.snippet).map((p, i) => (p.match ? <mark key={i}>{p.text}</mark> : p.text))}
                </span>
                <span className="session-meta">
                  <span>{session.cwd.split('/').filter(Boolean).pop()}</span>
                  {hit.matches > 1 && <span>· {hit.matches} messages</span>}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
