import { create } from 'zustand'
import type { Session } from './api'

// What changed in each session since the owner last looked at it. Two
// signals: the session's own activity time (a turn started, from here or
// elsewhere) moved past the one seen, or a turn this page watched end did so
// after the last look. Kept per browser like the transcript's seen mark; it
// is a convenience, not state.

const SEEN = 'go-chamber:visited:'
const ENDED = 'go-chamber:ended:'
const LOOKED = 'go-chamber:looked:'

function stamp(iso: string | undefined): number {
  if (!iso) return 0
  const t = Date.parse(iso)
  return Number.isNaN(t) || new Date(t).getUTCFullYear() < 2000 ? 0 : t
}

const activity = (s: Session) => stamp(s.activeAt) || stamp(s.createdAt)

type Times = Record<string, number>

export interface Visits {
  // seen is the activity time of each session when last looked at.
  seen: Times
  // ended is when this browser saw a turn end (clock time).
  ended: Times
  // looked is when the owner last looked after a turn ended (clock time).
  looked: Times
}

function loadAll(): Visits {
  const all: Visits = { seen: {}, ended: {}, looked: {} }
  const prefixes: [string, Times][] = [[SEEN, all.seen], [ENDED, all.ended], [LOOKED, all.looked]]
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      const match = prefixes.find(([p]) => key?.startsWith(p))
      if (!key || !match) continue
      const at = Number(localStorage.getItem(key))
      if (Number.isFinite(at) && at > 0) match[1][key.slice(match[0].length)] = at
    }
  } catch {
    // Storage blocked: nothing is remembered between visits.
  }
  return all
}

function save(prefix: string, id: string, at: number) {
  try {
    localStorage.setItem(prefix + id, String(at))
  } catch {
    // Storage blocked: the mark lasts for this page only.
  }
}

export const useVisits = create<Visits>(() => loadAll())

export function resetVisits(): void {
  useVisits.setState(loadAll())
}

// markVisited records that the owner has seen the session as it is now.
export function markVisited(session: Session, now = Date.now()): void {
  const { seen, ended, looked } = useVisits.getState()
  const at = activity(session) || now
  if ((seen[session.id] ?? 0) < at) {
    useVisits.setState({ seen: { ...seen, [session.id]: at } })
    save(SEEN, session.id, at)
  }
  const end = ended[session.id]
  if (end !== undefined && (looked[session.id] ?? 0) <= end) {
    const after = Math.max(now, end + 1)
    useVisits.setState({ looked: { ...useVisits.getState().looked, [session.id]: after } })
    save(LOOKED, session.id, after)
  }
}

// markEnded records that a session's turn ended while this page watched.
export function markEnded(id: string, now = Date.now()): void {
  useVisits.setState({ ended: { ...useVisits.getState().ended, [id]: now } })
  save(ENDED, id, now)
}

// isUnseen is true when a session has moved on since the owner last looked,
// and its turn is over (a running session already says so). Activity counts
// only for sessions looked at here before; an ended turn always counts.
export function isUnseen(session: Session, visits: Visits): boolean {
  if (session.status === 'running') return false
  const end = visits.ended[session.id]
  if (end !== undefined && end > (visits.looked[session.id] ?? 0)) return true
  const seen = visits.seen[session.id]
  return seen !== undefined && activity(session) > seen
}

export function unseenCount(sessions: Session[], visits: Visits, activeId: string | null): number {
  return sessions.filter((s) => s.id !== activeId && isUnseen(s, visits)).length
}

// endedTurns lists sessions whose turn ended between two lists.
export function endedTurns(before: Session[], after: Session[]): string[] {
  const was = new Map(before.map((s) => [s.id, s.status]))
  return after.filter((s) => was.get(s.id) === 'running' && s.status !== 'running').map((s) => s.id)
}
