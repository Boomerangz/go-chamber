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
}

export interface NoticeStore {
  notices: Notice[]
  dismiss: (id: number) => void
  dismissKey: (key: string) => void
}

const MAX = 3
const INFO_MS = 4000
let nextId = 1

export const useNotices = create<NoticeStore>((set, get) => ({
  notices: [],
  dismiss: (id) => set({ notices: get().notices.filter((n) => n.id !== id) }),
  dismissKey: (key) => set({ notices: get().notices.filter((n) => n.key !== key) }),
}))

export function notify(notice: Omit<Notice, 'id'>): number {
  const id = nextId++
  const rest = useNotices.getState().notices.filter((n) => !notice.key || n.key !== notice.key)
  useNotices.setState({ notices: [...rest, { ...notice, id }].slice(-MAX) })
  if (notice.kind === 'info') setTimeout(() => useNotices.getState().dismiss(id), INFO_MS)
  return id
}

// fail reports a failed action: "<title>: <reason>".
export function fail(title: string, err: unknown, key = title): void {
  notify({ kind: 'error', title, text: describeError(err), key })
}

// lastError is the newest error text; used by tests.
export function lastError(): string | null {
  const errors = useNotices.getState().notices.filter((n) => n.kind === 'error')
  return errors.length ? errors[errors.length - 1]!.text : null
}

const MAX_TEXT = 240

// describeError turns a thrown value into one readable line: server bodies
// can be whole HTML pages, and a dropped connection reads "Failed to fetch".
export function describeError(err: unknown): string {
  let text = err instanceof Error ? err.message : String(err)
  if (err instanceof TypeError && /fetch|network/i.test(text)) return 'go-chamber is not reachable'
  const title = /<title>([^<]*)<\/title>/i.exec(text)
  if (title) text = title[1]!
  else if (/^\s*</.test(text)) text = text.replace(/<[^>]*>/g, ' ')
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text
}

export function resetNotices(): void {
  useNotices.setState({ notices: [] })
}
