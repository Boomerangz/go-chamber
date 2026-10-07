import { useEffect, useState } from 'react'

// useNow ticks every interval ms (null pauses it), for countdowns and
// relative times that must not freeze at "just now".
export function useNow(interval: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (interval === null) return
    // Resuming after a pause: the value kept from before is stale, and the
    // first tick is a whole interval away.
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), interval)
    return () => clearInterval(id)
  }, [interval])
  return now
}
