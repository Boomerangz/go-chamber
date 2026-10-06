import { useEffect, useRef, useState } from 'react'

// useJustFinished is true for a moment after a turn ends on its own (running
// to idle), so the UI can mark the finish; loading idle or an interrupt is not
// a finish, and neither is a turn that failed (failed: known to the caller
// when the turn ended).
export function useJustFinished(status: string | undefined, failed = false, ms = 1500): boolean {
  const prev = useRef(status)
  const [finished, setFinished] = useState(false)
  useEffect(() => {
    const was = prev.current
    prev.current = status
    if (was !== 'running' || status !== 'idle' || failed) return
    setFinished(true)
    const timer = setTimeout(() => setFinished(false), ms)
    return () => {
      clearTimeout(timer)
      setFinished(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read at the transition only
  }, [status, ms])
  return finished
}
