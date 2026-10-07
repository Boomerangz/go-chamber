import { useLayoutEffect, useRef, useState, type DependencyList, type RefObject } from 'react'

export interface Clip {
  // clipped: the box is cut by its max-height and scrolls.
  clipped: boolean
  full: boolean
  setFull: (full: boolean) => void
}

// useClip measures whether a capped box (code, output, a diff) hides some of
// its content, so it can offer to show all of it. deps are what changes the
// content.
export function useClip<T extends HTMLElement>(deps: DependencyList): [RefObject<T | null>, Clip] {
  const ref = useRef<T>(null)
  const [clipped, setClipped] = useState(false)
  const [full, setFull] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || full) return
    const measure = () => setClipped(el.scrollHeight > el.clientHeight + 1)
    if (typeof ResizeObserver === 'undefined') {
      measure()
      return
    }
    // The observer reports once the frame is laid out, every box at once.
    // Reading the size here instead forced a layout per box: a long
    // transcript opening spent most of its time in hundreds of them.
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps name the content
  }, [full, ...deps])
  return [ref, { clipped, full, setFull }]
}
