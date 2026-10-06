import { useCallback, useEffect, useRef, useState } from 'react'

export interface PendingOptions {
  // holdOnSuccess keeps the control busy after a successful action, for
  // controls the success removes (an answered request, a started session):
  // re-enabling them for a moment invites a second click.
  holdOnSuccess?: boolean
}

// usePending runs an async action once at a time and says whether it is in
// flight. A trigger while it runs is dropped (resolves undefined), so a
// double click or a repeated key never sends twice.
export function usePending<A extends unknown[], R>(
  action: (...args: A) => Promise<R>,
  { holdOnSuccess = false }: PendingOptions = {},
): [run: (...args: A) => Promise<R | undefined>, pending: boolean] {
  const running = useRef(false)
  const alive = useRef(true)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const run = useCallback(
    async (...args: A) => {
      if (running.current) return undefined
      running.current = true
      setPending(true)
      let held = false
      try {
        const result = await action(...args)
        held = holdOnSuccess && result !== false
        return result
      } finally {
        if (!held) {
          running.current = false
          if (alive.current) setPending(false)
        }
      }
    },
    [action, holdOnSuccess],
  )
  return [run, pending]
}
