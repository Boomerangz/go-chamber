import type { Session } from './api'
import { basename } from './format'
import { sessionTitle } from './sessions'
import type { Terminal } from './terminal'

export interface SwitcherEntry {
  kind: 'session' | 'terminal'
  id: string
  title: string
  // detail is the folder and state, in mono.
  detail: string
  waiting: number
  status: string
}

function rank(s: Session, waiting: number): number {
  if (waiting > 0) return 0
  if (s.status === 'running') return 1
  return 2
}

// switcherEntries is the quick switcher's list: what needs the owner first,
// then what runs, then the most recent; terminals after sessions. Every word
// of the query must appear in the title or the folder.
export function switcherEntries(
  sessions: Session[],
  terminals: Terminal[],
  waitingBySession: Map<string, number>,
  query: string,
): SwitcherEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const hit = (...fields: string[]) => {
    const text = fields.join(' ').toLowerCase()
    return words.every((w) => text.includes(w))
  }
  const sessionEntries = sessions
    .filter((s) => hit(sessionTitle(s), s.cwd, s.agent))
    .sort((a, b) => {
      const byRank = rank(a, waitingBySession.get(a.id) ?? 0) - rank(b, waitingBySession.get(b.id) ?? 0)
      if (byRank !== 0) return byRank
      return (b.activeAt ?? b.createdAt ?? '').localeCompare(a.activeAt ?? a.createdAt ?? '')
    })
    .map<SwitcherEntry>((s) => ({
      kind: 'session',
      id: s.id,
      title: sessionTitle(s),
      detail: basename(s.cwd),
      waiting: waitingBySession.get(s.id) ?? 0,
      status: s.status,
    }))
  const terminalEntries = terminals
    .filter((t) => hit(t.title, t.cwd))
    .map<SwitcherEntry>((t) => ({
      kind: 'terminal',
      id: t.id,
      title: t.title || basename(t.cwd),
      detail: basename(t.cwd),
      waiting: 0,
      status: t.status,
    }))
  return [...sessionEntries, ...terminalEntries]
}
