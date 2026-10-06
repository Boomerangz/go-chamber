import type { QuotaWindow, Session, SessionStatus } from './api'
import type { ChatState } from './events'

const claudeWindows: Record<string, string> = {
  five_hour: '5h window',
  seven_day: '7d window',
  seven_day_opus: '7d Opus',
  seven_day_sonnet: '7d Sonnet',
}

// windowLabel names a rate-limit window for people: Codex reports its
// duration in minutes ("300m"), Claude a well-known key ("five_hour").
export function windowLabel(w: QuotaWindow): string {
  const minutes = /^(\d+)m$/.exec(w.status ?? '')
  if (minutes) return `${duration(Number(minutes[1]))} window`
  return claudeWindows[w.name] ?? w.name.replace(/_/g, ' ')
}

function duration(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

function resetTime(resetsAt: string | undefined): Date | null {
  if (!resetsAt) return null
  const at = new Date(resetsAt)
  return Number.isNaN(at.getTime()) || at.getUTCFullYear() < 2000 ? null : at
}

// hasReset tells a window whose reset time has passed: the usage reported
// before it is old until fresh numbers arrive.
export function hasReset(resetsAt: string | undefined, now: Date = new Date()): boolean {
  const at = resetTime(resetsAt)
  return at !== null && at.getTime() <= now.getTime()
}

// resetLabel tells how long until a window resets, or how long ago it did
// ("reset 16d ago": a lone "reset" read like a command), or null when unknown.
export function resetLabel(resetsAt: string | undefined, now: Date = new Date()): string | null {
  const at = resetTime(resetsAt)
  if (!at) return null
  const ms = at.getTime() - now.getTime()
  if (ms <= 0) {
    const ago = Math.floor(-ms / 60_000)
    if (ago < 1) return 'reset just now'
    if (ago < 60) return `reset ${ago}m ago`
    if (ago < 1440) return `reset ${Math.floor(ago / 60)}h ago`
    return `reset ${Math.floor(ago / 1440)}d ago`
  }
  const mins = Math.max(1, Math.floor(ms / 60_000))
  const days = Math.floor(mins / 1440)
  const hours = Math.floor((mins % 1440) / 60)
  const rest = mins % 60
  if (days > 0) return `resets in ${days}d${hours ? ` ${hours}h` : ''}`
  if (hours > 0) return `resets in ${hours}h${rest ? ` ${rest}m` : ''}`
  return `resets in ${rest}m`
}

export function basename(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : path
}

// displayStatus picks the status shown for the open session: the live chat
// once any event arrived, otherwise the stored session (history is not
// persisted across restarts, so an interrupted session has no events).
export function displayStatus(chat: ChatState, session: Pick<Session, 'status'> | undefined): SessionStatus {
  if (chat.lastSeq > 0) return chat.status
  return session?.status ?? chat.status
}
