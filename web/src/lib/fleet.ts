import type { Session, SessionRequest } from './api'

export interface Fleet {
  running: number
  waiting: number
}

// fleet is the sessions at a glance: how many run and how many wait for the
// owner. Subagents are their parent's work, not sessions of their own; a turn
// held by a request counts as waiting, not also as running, so each session
// is counted once. waiting is the count every other place shows (open
// requests and answers owed, see waitingCount).
export function fleet(sessions: readonly Session[], requests: readonly SessionRequest[], waiting: number): Fleet {
  let running = 0
  for (const s of sessions) {
    if (!s.parentId && s.status === 'running' && !requests.some((r) => r.sessionId === s.id)) running++
  }
  return { running, waiting }
}

// fleetText says it in one line, naming only what is there: "2 running · 1
// waiting", "1 waiting", or nothing at all.
export function fleetText(f: Fleet): string {
  const parts: string[] = []
  if (f.running) parts.push(`${f.running} running`)
  if (f.waiting) parts.push(`${f.waiting} waiting`)
  return parts.join(' · ')
}
