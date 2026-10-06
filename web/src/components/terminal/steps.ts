import { useEffect, useRef } from 'react'
import { nextIndex } from '../../lib/hotkeys'
import { useTerminalStore } from '../../stores/terminals'

// STEP_EVENT asks the visible terminal list to step to the previous (-1)
// or next (1) tab: the terminal sends it on ⌥[ / ⌥], and only the list on
// screen knows its order.
export const STEP_EVENT = 'gc:terminal-step'

export function stepTerminal(step: 1 | -1): void {
  window.dispatchEvent(new CustomEvent(STEP_EVENT, { detail: step }))
}

// isStepKey reads ⌥[ / ⌥] (by key position, as ⌥ types other characters
// on a Mac) as a step, or null.
export function stepOf(e: Pick<KeyboardEvent, 'altKey' | 'metaKey' | 'ctrlKey' | 'code'>): 1 | -1 | null {
  if (!e.altKey || e.metaKey || e.ctrlKey) return null
  if (e.code === 'BracketLeft') return -1
  if (e.code === 'BracketRight') return 1
  return null
}

// useTerminalSteps selects the previous or next of order when a step is
// asked for, without wrapping around.
export function useTerminalSteps(order: string[]): void {
  const ids = useRef(order)
  useEffect(() => {
    ids.current = order
  })
  useEffect(() => {
    const onStep = (e: Event) => {
      const step = (e as CustomEvent<number>).detail === -1 ? -1 : 1
      const { activeId, select } = useTerminalStore.getState()
      const list = ids.current
      const next = list[nextIndex(activeId ? list.indexOf(activeId) : -1, list.length, step)]
      if (next && next !== activeId) select(next)
    }
    window.addEventListener(STEP_EVENT, onStep)
    return () => window.removeEventListener(STEP_EVENT, onStep)
  }, [])
}
