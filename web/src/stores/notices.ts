import { create } from 'zustand'

// A notice tells the owner something the page can't show in place: an action
// failed, or a quiet confirmation. Errors stay until dismissed; info fades.
export interface Notice {
  id: number
  kind: 'error' | 'info'
  // title names what happened, e.g. "Fork failed".
  title?: string
  text: string
  // key collapses repeats: a new notice with the same key replaces the old.
  key?: string
  // action is one thing to do about it, e.g. Undo; it dismisses the notice.
  action?: { label: string; run: () => void }
  // sessionId ties the notice to a session: it goes when the session is
  // deleted. Leaving the session keeps it (a fork still wants to hear that
  // the worktree went).
  sessionId?: string
}

export interface NoticeStore {
  notices: Notice[]
  dismiss: (id: number) => void
  dismissKey: (key: string) => void
}

const MAX = 3
const INFO_MS = 4000
// a notice with an action stays long enough to reach it
const ACTION_MS = 8000
let nextId = 1
// quiet holds failures a caller shows in place instead of as a notice; only
// their reason is kept, for lastError.
let quiet: Notice[] = []
type PauseReason = 'pointer' | 'focus'
interface Expiry {
  timer: ReturnType<typeof setTimeout> | null
  remaining: number
  due: number
  paused: Set<PauseReason>
}
const expiries = new Map<number, Expiry>()

function schedule(id: number, expiry: Expiry) {
  expiry.due = Date.now() + expiry.remaining
  expiry.timer = setTimeout(() => useNotices.getState().dismiss(id), expiry.remaining)
}

export function pauseNotice(id: number, reason: PauseReason): void {
  const expiry = expiries.get(id)
  if (!expiry) return
  if (expiry.timer !== null) {
    clearTimeout(expiry.timer)
    expiry.timer = null
    expiry.remaining = Math.max(0, expiry.due - Date.now())
  }
  expiry.paused.add(reason)
}

export function resumeNotice(id: number, reason: PauseReason): void {
  const expiry = expiries.get(id)
  if (!expiry || !expiry.paused.delete(reason) || expiry.paused.size) return
  schedule(id, expiry)
}

export const useNotices = create<NoticeStore>((set, get) => ({
  notices: [],
  dismiss: (id) => {
    quiet = quiet.filter((n) => n.id !== id)
    set({ notices: get().notices.filter((n) => n.id !== id) })
  },
  dismissKey: (key) => {
    quiet = quiet.filter((n) => n.key !== key)
    set({ notices: get().notices.filter((n) => n.key !== key) })
  },
}))

// A dismissed, replaced or evicted notice no longer owns a timer.
useNotices.subscribe(({ notices }) => {
  const ids = new Set(notices.map((n) => n.id))
  for (const [id, expiry] of expiries) {
    if (ids.has(id)) continue
    if (expiry.timer !== null) clearTimeout(expiry.timer)
    expiries.delete(id)
  }
})

export function notify(notice: Omit<Notice, 'id'>): number {
  const id = nextId++
  const rest = useNotices.getState().notices.filter((n) => !notice.key || n.key !== notice.key)
  useNotices.setState({ notices: [...rest, { ...notice, id }].slice(-MAX) })
  if (notice.kind === 'info') {
    const expiry: Expiry = { timer: null, remaining: notice.action ? ACTION_MS : INFO_MS, due: 0, paused: new Set() }
    expiries.set(id, expiry)
    schedule(id, expiry)
  }
  return id
}

// dropSessionNotices takes back the notices about sessions that are gone.
export function dropSessionNotices(ids: Iterable<string>): void {
  const gone = new Set(ids)
  const notices = useNotices.getState().notices
  const kept = notices.filter((n) => !n.sessionId || !gone.has(n.sessionId))
  if (kept.length !== notices.length) useNotices.setState({ notices: kept })
}

// fail reports a failed action: "<title>: <reason>". With quiet, the
// caller shows the failure in place (an inline error, a Retry), so no
// notice is raised; the reason is still kept for lastError.
export function fail(title: string, err: unknown, key = title, { quiet: inPlace = false } = {}): void {
  const text = describeError(err)
  if (!inPlace) {
    notify({ kind: 'error', title, text, key })
    return
  }
  quiet = [...quiet.filter((n) => n.key !== key), { id: nextId++, kind: 'error' as const, title, text, key }].slice(-MAX)
}

// lastError is the newest error text, shown or quiet: an inline error line
// takes its reason from here when the store only said "false".
export function lastError(): string | null {
  const errors = [...useNotices.getState().notices.filter((n) => n.kind === 'error'), ...quiet]
  if (errors.length === 0) return null
  return errors.reduce((a, b) => (b.id > a.id ? b : a)).text
}

const MAX_TEXT = 240

// describeError turns a thrown value into one readable line: server bodies
// can be whole HTML pages, and a dropped connection reads "Failed to fetch".
export function describeError(err: unknown): string {
  // A DOMException is not always an Error (jsdom), so go by its name.
  if ((err as { name?: unknown } | null)?.name === 'TimeoutError') return "go-chamber didn't answer"
  let text = err instanceof Error ? err.message : String(err)
  if (err instanceof TypeError && /fetch|network/i.test(text)) return 'go-chamber is not reachable'
  const title = /<title>([^<]*)<\/title>/i.exec(text)
  if (title) text = title[1]!
  else if (/^\s*</.test(text)) text = text.replace(/<[^>]*>/g, ' ')
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text
}

export function resetNotices(): void {
  quiet = []
  useNotices.setState({ notices: [] })
}
