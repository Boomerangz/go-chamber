import { create } from 'zustand'
import type { Session } from './api'

// When the owner last looked at each session, as the session's own activity
// time then: a row whose activity is later changed while they were away.
// Kept per browser like the transcript's seen mark; it is a convenience.

const KEY = 'go-chamber:visited:'

function stamp(iso: string | undefined): number {
  if (!iso) return 0
  const t = Date.parse(iso)
  return Number.isNaN(t) || new Date(t).getUTCFullYear() < 2000 ? 0 : t
}

const activity = (s: Session) => stamp(s.activeAt) || stamp(s.createdAt)

function loadAll(): Record<string, number> {
  const seen: Record<string, number> = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(KEY)) continue
      const at = Number(localStorage.getItem(key))
      if (Number.isFinite(at) && at > 0) seen[key.slice(KEY.length)] = at
    }
  } catch {
    // Storage blocked: nothing is remembered between visits.
  }
  return seen
}

export const useVisits = create<{ seen: Record<string, number> }>(() => ({ seen: loadAll() }))

export function resetVisits(): void {
  useVisits.setState({ seen: loadAll() })
}

// markVisited records that the owner has seen the session as it is now.
export function markVisited(session: Session): void {
  const at = activity(session) || Date.now()
  const seen = useVisits.getState().seen
  if ((seen[session.id] ?? 0) >= at) return
  useVisits.setState({ seen: { ...seen, [session.id]: at } })
  try {
    localStorage.setItem(KEY + session.id, String(at))
  } catch {
    // Storage blocked: the mark lasts for this page only.
  }
}

// isUnseen is true when a session the owner opened before has moved on
// since, and its turn is over (a running session already says so).
export function isUnseen(session: Session, seen: Record<string, number>): boolean {
  const visited = seen[session.id]
  if (visited === undefined || session.status === 'running') return false
  return activity(session) > visited
}

export function unseenCount(sessions: Session[], seen: Record<string, number>, activeId: string | null): number {
  return sessions.filter((s) => s.id !== activeId && isUnseen(s, seen)).length
}
