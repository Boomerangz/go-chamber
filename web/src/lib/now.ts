import { useEffect, useState } from 'react'

// useNow ticks every interval ms (null pauses it), for countdowns and
// relative times that must not freeze at "just now".
export function useNow(interval: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (interval === null) return
    const id = setInterval(() => setNow(Date.now()), interval)
    return () => clearInterval(id)
  }, [interval])
  return now
}
