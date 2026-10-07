import type { Session } from './api'
import type { Terminal } from './terminal'

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p)

// within reports whether folder cwd is dir or one inside it.
export function within(cwd: string, dir: string): boolean {
  if (!dir) return false
  const d = trimSlash(dir)
  const c = trimSlash(cwd)
  return c === d || c.startsWith(d === '/' ? '/' : d + '/')
}

// shellsWithin counts the shells working in dir or below it: removing a
// worktree folder closes them.
export function shellsWithin(terminals: Terminal[], dir: string | undefined): number {
  if (!dir) return 0
  return terminals.filter((t) => within(t.cwd, dir)).length
}

// closingNote tells, before a worktree folder goes, that its shells go too.
export function closingNote(n: number): string | null {
  if (n <= 0) return null
  return `${n} ${n === 1 ? 'terminal' : 'terminals'} in it will close.`
}

// shellsMayHaveGone reports a change of sessions after which the server
// closed or let go of shells: a session was deleted, or a worktree folder
// was removed.
export function shellsMayHaveGone(prev: Session[], next: Session[]): boolean {
  if (prev === next) return false
  const now = new Map(next.map((s) => [s.id, s]))
  return prev.some((s) => {
    const after = now.get(s.id)
    if (!after) return true
    return Boolean(s.worktree && !s.worktree.removed && after.worktree?.removed)
  })
}
