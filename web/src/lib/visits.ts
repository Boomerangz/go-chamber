import { markSeen, type Session } from './api'

// What changed in each session since the owner last looked at it, on any
// device: the server keeps where they last looked (seen) and when a turn
// last ended (endedAt), and every device reads the same two.

function stamp(iso: string | undefined): number {
  if (!iso) return 0
  const t = Date.parse(iso)
  return Number.isNaN(t) ? 0 : t
}

// isUnseen is true when a turn ended after the owner last looked; a
// running session already says so.
export function isUnseen(session: Session): boolean {
  if (session.status === 'running') return false
  return stamp(session.endedAt) > stamp(session.seen?.at)
}

export function unseenCount(sessions: Session[], activeId: string | null): number {
  return sessions.filter((s) => s.id !== activeId && isUnseen(s)).length
}

// needsReport tells whether the server has yet to hear that the owner looks
// at the session now, having read up to item (undefined: not at the end).
export function needsReport(session: Session, item: string | undefined): boolean {
  if (item !== undefined && item !== session.seen?.item) return true
  return isUnseen({ ...session, status: 'idle' })
}

// A look is told after the owner settles for a moment: a streaming turn
// would otherwise report every reply.
const SETTLE_MS = 800

interface Pending {
  item: string | undefined
  key: string
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, Pending>()
// sent is the last look told per session, until the server's echo makes
// needsReport quiet; it keeps a slow echo from asking twice.
const sent = new Map<string, string>()

// reportSeen tells the server, once the owner settles, that they look at
// the session having read up to item. endedAt is the turn end they saw.
export function reportSeen(id: string, item: string | undefined, endedAt?: string): void {
  const key = `${item ?? ''}|${endedAt ?? ''}`
  if (sent.get(id) === key) return
  const was = pending.get(id)
  if (was) clearTimeout(was.timer)
  pending.set(id, { item, key, timer: setTimeout(() => flushSeen(id), SETTLE_MS) })
}

// flushSeen tells a waiting look at once: the owner is leaving.
export function flushSeen(id: string): void {
  const look = pending.get(id)
  if (!look) return
  clearTimeout(look.timer)
  pending.delete(id)
  sent.set(id, look.key)
  markSeen(id, look.item).catch(() => {
    // Not told: the next look tries again.
    if (sent.get(id) === look.key) sent.delete(id)
  })
}

export function resetSeenReports(): void {
  for (const look of pending.values()) clearTimeout(look.timer)
  pending.clear()
  sent.clear()
}
