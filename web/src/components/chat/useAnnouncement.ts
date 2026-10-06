import { useEffect, useRef, useState } from 'react'
import type { SessionStatus } from '../../lib/api'
import type { ChatState } from '../../lib/events'
import type { LoadStatus } from '../../stores/session'

export interface Announcement {
  text: string
  // n changes with every announcement, so the same words are read again.
  n: number
}

interface Seen {
  ready: boolean
  replies: number
  requests: Set<string>
  status: SessionStatus
}

function replies(chat: ChatState): number {
  let n = 0
  for (const id of chat.order) {
    const item = chat.items[id]
    if (item?.kind === 'assistant_message' && !item.parentItemId && item.status === 'completed') n++
  }
  return n
}

// useAnnouncement picks the few moments a screen reader should hear while a
// session runs: a reply finished, the agent needs the owner, the turn ended.
// The transcript itself is not a live region; streaming text would be read
// token by token. A transcript that loads is history, not news.
export function useAnnouncement(chat: ChatState, history: LoadStatus, status: SessionStatus): Announcement {
  const [said, setSaid] = useState<Announcement>({ text: '', n: 0 })
  const prev = useRef<Seen | null>(null)
  useEffect(() => {
    const requests = Object.values(chat.requests)
    const now: Seen = { ready: history === 'ready', replies: replies(chat), requests: new Set(requests.map((r) => r.id)), status }
    const was = prev.current
    prev.current = now
    if (!was?.ready || !now.ready) return
    const fresh = requests.find((r) => !was.requests.has(r.id))
    let text: string | null = null
    if (fresh) text = fresh.kind === 'permission' ? 'approval needed' : 'answer needed'
    else if (was.status === 'running' && status !== 'running') text = status === 'interrupted' ? 'turn interrupted' : 'turn finished'
    else if (now.replies > was.replies) text = 'assistant replied'
    // Announcing is the point of this effect: it reacts to what just changed.
    // eslint-disable-next-line react/set-state-in-effect
    if (text) setSaid((s) => ({ text: text!, n: s.n + 1 }))
  }, [chat, history, status])
  return said
}
