import { useEffect, useState } from 'react'
import type { Item } from './api'

// Where the user stopped reading each session, so the transcript can mark
// what arrived since. Kept per browser: it is a convenience, not state.

const KEY = 'go-chamber:seen:'

// firstUnseen returns the first item after the last one seen, or null when
// there is nothing new or no record of a previous visit.
export function firstUnseen(order: string[], seenId: string | null): string | null {
  if (!seenId) return null
  const i = order.indexOf(seenId)
  if (i < 0 || i === order.length - 1) return null
  return order[i + 1]
}

export function loadSeen(sessionId: string): string | null {
  try {
    return localStorage.getItem(KEY + sessionId)
  } catch {
    return null
  }
}

export function saveSeen(sessionId: string, itemId: string): void {
  try {
    localStorage.setItem(KEY + sessionId, itemId)
  } catch {
    // Storage may be blocked; the mark is optional.
  }
}

export interface UnseenInput {
  sessionId: string | undefined
  order: string[]
  items: Record<string, Item>
  // ready is false until the transcript is loaded: a partial one would
  // read as "nothing new".
  ready: boolean
  // pinned (and isPinned, read at commit time) say the end is in view.
  pinned: boolean
  isPinned: () => boolean
}

// useUnseen returns the first item that arrived while the owner was away,
// for the "new since you left" mark. Away means the session wasn't open or
// the page was hidden: what arrives while the page is in front is not news.
// A mark found on arrival stays put while more streams in, until the owner
// sends a message, which says they have seen everything. Where reading
// stopped is remembered only while the end of the transcript is on screen.
export function useUnseen({ sessionId, order, items, ready, pinned, isPinned }: UnseenInput): string | null {
  const [anchor, setAnchor] = useState(() => (sessionId ? loadSeen(sessionId) : null))
  // away holds until the owner looks at the loaded transcript: opening the
  // session or bringing the page back is when news are found.
  const [away, setAway] = useState(true)
  // markedAt is how long the transcript was when the owner found the mark.
  const [markedAt, setMarkedAt] = useState<number | null>(null)
  const visible = useVisible()
  const last = order[order.length - 1]
  const mark = ready ? firstUnseen(order, anchor) : null
  if (!visible) {
    if (!away) setAway(true)
  } else if (ready && last) {
    if (away) {
      setAway(false)
      setMarkedAt(mark === null ? null : order.length)
    } else if (markedAt === null) {
      if (anchor !== last) setAnchor(last)
    } else if (order.slice(markedAt).some((id) => items[id]?.kind === 'user_message' && !items[id]?.parentItemId)) {
      setAnchor(last)
      setMarkedAt(null)
    }
  }
  useEffect(() => {
    // isPinned, not pinned: landing on the mark unpins in this very commit.
    if (sessionId && last && ready && pinned && visible && isPinned()) saveSeen(sessionId, last)
  }, [sessionId, last, ready, pinned, visible, isPinned])
  return mark
}

function useVisible(): boolean {
  const read = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
  const [visible, setVisible] = useState(read)
  useEffect(() => {
    const update = () => setVisible(read())
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  return visible
}
