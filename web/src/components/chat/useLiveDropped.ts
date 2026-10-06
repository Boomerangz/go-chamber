import { useSessionStore } from '../../stores/session'

// SENT_HOLD_MS is how long a control waits, busy, for the agent to answer
// an accepted action before it lets go and says the action was sent.
export const SENT_HOLD_MS = 10_000

// useLiveDropped says the live socket dropped and the page is reconnecting:
// what the agent does now won't reach this page until it is back. The first
// connection of a page load is not a drop.
export function useLiveDropped(): boolean {
  return useSessionStore(isDropped)
}

type ConnectionState = Pick<ReturnType<typeof useSessionStore.getState>, 'connection' | 'nextRetryAt'>

export function isDropped(s: ConnectionState): boolean {
  return s.connection === 'offline' || (s.connection === 'connecting' && s.nextRetryAt !== null)
}

// untilBack resolves once the live socket is back (at once if it never
// dropped): what is sent meanwhile would only fail.
export function untilBack(): Promise<void> {
  if (!isDropped(useSessionStore.getState())) return Promise.resolve()
  return new Promise((resolve) => {
    const unsubscribe = useSessionStore.subscribe((s) => {
      if (isDropped(s)) return
      unsubscribe()
      resolve()
    })
  })
}
