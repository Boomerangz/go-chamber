import { useCallback, useEffect, useRef, useState } from 'react'

// HOLD_TIMEOUT_MS is how long a held control waits for the event that
// removes it (request.resolved, a session showing up) before it lets go:
// with the live socket down that event may never come.
export const HOLD_TIMEOUT_MS = 10_000

export interface PendingOptions {
  // holdOnSuccess keeps the control busy after a successful action, for
  // controls the success removes (an answered request, a started session):
  // re-enabling them for a moment invites a second click.
  holdOnSuccess?: boolean
  // holdTimeoutMs ends the hold if the control is still there after it
  // (default HOLD_TIMEOUT_MS; 0 holds until the control leaves). The hook
  // then reports stillWaiting, so the control can read "sent · waiting".
  holdTimeoutMs?: number
}

// usePending runs an async action once at a time and says whether it is in
// flight. A trigger while it runs is dropped (resolves undefined), so a
// double click or a repeated key never sends twice.
//
// stillWaiting is true once a held success outlived holdTimeoutMs: the
// action went through but what it should cause hasn't arrived. It clears
// on the next run.
export function usePending<A extends unknown[], R>(
  action: (...args: A) => Promise<R>,
  { holdOnSuccess = false, holdTimeoutMs = HOLD_TIMEOUT_MS }: PendingOptions = {},
): [run: (...args: A) => Promise<R | undefined>, pending: boolean, stillWaiting: boolean] {
  const running = useRef(false)
  const alive = useRef(true)
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [pending, setPending] = useState(false)
  const [stillWaiting, setStillWaiting] = useState(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (holdTimer.current) clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
  }, [])
  const run = useCallback(
    async (...args: A) => {
      if (running.current) return undefined
      running.current = true
      setPending(true)
      setStillWaiting(false)
      let held = false
      try {
        const result = await action(...args)
        held = holdOnSuccess && result !== false
        return result
      } finally {
        if (!held) {
          running.current = false
          if (alive.current) setPending(false)
        } else if (holdTimeoutMs > 0 && alive.current) {
          holdTimer.current = setTimeout(() => {
            holdTimer.current = null
            running.current = false
            if (!alive.current) return
            setPending(false)
            setStillWaiting(true)
          }, holdTimeoutMs)
        }
      }
    },
    [action, holdOnSuccess, holdTimeoutMs],
  )
  return [run, pending, stillWaiting]
}
