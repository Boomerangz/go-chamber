import { useEffect, useState } from 'react'

// useNow ticks every interval ms (null pauses it), for countdowns and
// relative times that must not freeze at "just now".
export function useNow(interval: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (interval === null) return
    const tick = () => setNow(Date.now())
    // Resuming after a pause: the value kept from before is stale and the
    // first interval tick is a whole interval away, so read the clock at once.
    const first = setTimeout(tick, 0)
    const id = setInterval(tick, interval)
    return () => {
      clearTimeout(first)
      clearInterval(id)
    }
  }, [interval])
  return now
}
