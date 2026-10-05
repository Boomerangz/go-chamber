import { useEffect, useRef, useState } from 'react'

// useJustFinished is true for a moment after a turn ends on its own (running
// to idle), so the UI can mark the finish; loading idle or an interrupt is not
// a finish.
export function useJustFinished(status: string | undefined, ms = 1500): boolean {
  const prev = useRef(status)
  const [finished, setFinished] = useState(false)
  useEffect(() => {
    const was = prev.current
    prev.current = status
    if (was !== 'running' || status !== 'idle') return
    setFinished(true)
    const timer = setTimeout(() => setFinished(false), ms)
    return () => {
      clearTimeout(timer)
      setFinished(false)
    }
  }, [status, ms])
  return finished
}
