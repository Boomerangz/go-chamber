import type { Session, SessionRequest } from './api'
import { owesAnswer } from './status'
import { useSessionStore } from '../stores/session'

// waitingCount is how many things wait for the owner, as the Requests tray
// lists them: the open requests, and the turns cut off (a restart, a crash)
// while they asked — their request is gone, but the answer is still owed.
export function waitingCount(requests: readonly SessionRequest[], sessions: readonly Session[]): number {
  let owed = 0
  for (const s of sessions) if (owesAnswer(s)) owed++
  return requests.length + owed
}

// useWaitingCount is waitingCount over the store: the one number the rail,
// the phone tab, the tab title and the favicon show.
export function useWaitingCount(): number {
  return useSessionStore((s) => waitingCount(s.pendingRequests, s.sessions))
}
