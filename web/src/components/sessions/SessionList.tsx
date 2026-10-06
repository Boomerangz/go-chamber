import { ChevronDown, Plus, Search, X } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { icon } from '../icon'
import { Fragment, useEffect, useMemo, useRef } from 'react'
import type { AgentKind, SearchHit, Session } from '../../lib/api'
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
import { useNow } from '../../lib/now'
import { isUnseen, useVisits, type Visits } from '../../lib/visits'
import { useSessionStore } from '../../stores/session'
import { LoadFailed, LoadingLine, Skeleton } from '../ui/Loading'
import SessionMenu from './SessionMenu'

// RECENT is how many sessions an expanded project shows before "older".
const RECENT = 5

const agentName: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex' }

export interface SessionListProps {
  onCreateIn: (cwd: string) => void
  // agent is who a group's "+" starts; named on the button.
  agent?: AgentKind
  // creating disables the "+" buttons while a session is starting.
  creating?: boolean
  // creatingIn is the folder whose "+" started it, marked busy.
  creatingIn?: string | null
}

// SessionList shows sessions grouped by project folder. Each group is
// collapsed, shows its recent sessions, or everything with time dividers.
export default function SessionList({ onCreateIn, agent = 'claude', creating = false, creatingIn = null }: SessionListProps) {
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
  const status = useSessionStore((s) => s.sessionsStatus)
  const loadSessions = useSessionStore((s) => s.loadSessions)
  const searchingMessages = useSessionStore((s) => s.searching)
  const searchError = useSessionStore((s) => s.searchError)
  const seen = useVisits()
  // Relative times ("4m ago") must not freeze.
  const now = useNow(60_000)
  const input = useRef<HTMLInputElement>(null)

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

  // A session already listed for its title isn't listed again under messages.
  const shownIds = useMemo(
    () => new Set(searching ? sessions.filter((s) => matchesQuery(s, query)).map((s) => s.id) : []),
    [sessions, query, searching],
  )

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
          ref={input}
          type="search"
          aria-label="search sessions"
          placeholder="Search sessions"
          title="Search sessions (/)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            // The first Escape clears, the next one leaves the field.
            e.preventDefault()
            if (query) setQuery('')
            else e.currentTarget.blur()
          }}
        />
        {query && (
          <button
            type="button"
            className="btn btn-ghost btn-icon search-clear"
            aria-label="Clear search"
            title="Clear search"
            onClick={() => {
              setQuery('')
              input.current?.focus()
            }}
          >
            <X {...icon(14)} />
          </button>
        )}
      </div>
      <div className="groups">
        {status === 'loading' && sessions.length === 0 && <Skeleton rows={4} label="loading sessions" />}
        {status === 'error' && sessions.length === 0 && (
          <LoadFailed onRetry={() => void loadSessions()}>Couldn't load sessions</LoadFailed>
        )}
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
            agent={agent}
            creating={creating}
            creatingIn={creatingIn}
            seen={seen}
            now={now}
          />
        ))}
        {searching && searchingMessages && <LoadingLine>searching messages…</LoadingLine>}
        {searching && !searchingMessages && searchError && (
          <LoadFailed onRetry={() => void searchMessages(query)}>{`Couldn't search messages: ${searchError}`}</LoadFailed>
        )}
        {searching && (
          <MessageHits
            hits={searchHits.filter((h) => !shownIds.has(h.sessionId))}
            sessions={sessions}
            activeId={activeId}
            onSelect={(id) => void selectSession(id)}
          />
        )}
        {status === 'ready' && groups.length === 0 && (!searching || (!searchingMessages && !searchError && searchHits.length === 0)) && (
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
  agent: AgentKind
  creating: boolean
  creatingIn: string | null
  seen: Visits
  now: number
}) {
  const { mode, activeId } = props
  // What waits for the owner leads its group, then the most recent.
  const group = useMemo(() => {
    const waits = (n: SessionNode) => (pendingIn(n, props.pendingBySession) > 0 ? 0 : 1)
    return { ...props.group, nodes: [...props.group.nodes].sort((a, b) => waits(a) - waits(b)) }
  }, [props.group, props.pendingBySession])
  const { shown, hidden } = visibleInGroup(group, mode, RECENT, activeId)
  const waiting = group.nodes.reduce((n, node) => n + pendingIn(node, props.pendingBySession), 0)
  const unseen = group.nodes.reduce((n, node) => n + unseenIn(node, props.seen, activeId), 0)
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
          {unseen > 0 && (
            <span className="group-unseen" title={`${unseen} changed since you last looked`}>
              {unseen} new
            </span>
          )}
          {waiting > 0 && (
            <span className="badge" title="Waiting for you">
              {waiting}
            </span>
          )}
        </button>
        <button
          className="btn btn-ghost btn-icon group-new"
          aria-label={`New ${agentName[props.agent]} session in ${group.cwd}`}
          title={`New ${agentName[props.agent]} session in ${group.cwd}`}
          disabled={props.creating}
          aria-busy={(props.creating && props.creatingIn === group.cwd) || undefined}
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

function unseenIn(node: SessionNode, seen: Visits, activeId: string | null): number {
  const own = node.session.id !== activeId && isUnseen(node.session, seen) ? 1 : 0
  return own + node.children.reduce((n, c) => n + unseenIn(c, seen, activeId), 0)
}

// useScrolledIntoView keeps the open session's row on screen when the open
// session changes from elsewhere (a link, a notification, the tray).
function useScrolledIntoView(active: boolean) {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (active) ref.current?.scrollIntoView?.({ block: 'nearest' })
  }, [active])
  return ref
}

function SessionRow(props: {
  node: SessionNode
  depth: number
  activeId: string | null
  pendingBySession: Map<string, number>
  seen: Visits
  onSelect: (id: string) => void
  now: number
}) {
  const s = props.node.session
  const waiting = props.pendingBySession.get(s.id) ?? 0
  const reduced = useReducedMotion() ?? false
  const finished = useJustFinished(s.status)
  const active = s.id === props.activeId
  const ref = useScrolledIntoView(active)
  const title = sessionTitle(s)
  const unseen = !active && isUnseen(s, props.seen)
  return (
    <motion.li layout="position" transition={settle(reduced)} className={props.depth > 0 ? 'session-child' : undefined}>
      <button
        ref={ref}
        className={active ? 'session active' : 'session'}
        aria-current={active ? 'true' : undefined}
        onClick={() => props.onSelect(s.id)}
      >
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
              (s.status === 'running' || s.status === 'interrupted' || finished) && (
                <span className={`session-status session-status-${finished ? 'done' : s.status}`}>{finished ? 'done' : s.status}</span>
              )
            )}
            {s.status === 'detached' && !finished && waiting === 0 && (
              // Most sessions rest detached; the dashed mark alone says so.
              <span className="session-status session-status-detached" role="img" aria-label="detached" title="detached · resumes when you write" />
            )}
            {s.status === 'idle' && !finished && waiting === 0 && (
              // Idle is a resting state too: the hollow mark alone.
              <span className="session-status session-status-idle" role="img" aria-label="idle" title="idle · waiting for your next message" />
            )}
            {unseen && (
              <span className="session-unseen" title="Changed since you last opened it">
                new
              </span>
            )}
            {s.forkOf && (
              <span className="session-fork" title="Forked from another session">
                fork
              </span>
            )}
            <span className="session-time">{relativeTime(s.activeAt ?? s.createdAt, new Date(props.now))}</span>
          </span>
        </span>
      </button>
      <SessionMenu session={s} />
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
              aria-current={session.id === props.activeId ? 'true' : undefined}
              onClick={() => props.onSelect(session.id)}
            >
              <span className={`avatar avatar-sm avatar-${session.agent}`} aria-hidden="true">
                {session.agent === 'claude' ? 'C' : 'X'}
              </span>
              <span className="session-text">
                <span className="session-title" title={sessionTitle(session)}>
                  {sessionTitle(session)}
                </span>
                <span className="snippet">
                  {snippetParts(hit.snippet).map((p, i) => (p.match ? <mark key={i}>{p.text}</mark> : p.text))}
                </span>
                <span className="session-meta">
                  <span title={session.cwd}>{session.cwd.split('/').filter(Boolean).pop()}</span>
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
