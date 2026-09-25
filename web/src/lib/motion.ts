// Motion policy: short, typographic movement that conveys state. Under
// reduced motion nothing travels; a brief fade keeps changes noticeable.

export const DURATION = { fast: 0.12, base: 0.2 } as const
export const EASE_OUT = [0.16, 1, 0.3, 1] as const

type Origin = 'below' | 'margin'

export interface Enter {
  initial: Record<string, number>
  animate: Record<string, number>
  exit: Record<string, number>
  transition: { duration: number; ease: typeof EASE_OUT | 'linear' }
}

// enter describes how an item joins the page: settling 2px up, or sliding in
// from the left margin (agent requests).
export function enter(reduced: boolean, from: Origin = 'below'): Enter {
  if (reduced) {
    return {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
      transition: { duration: DURATION.fast, ease: 'linear' },
    }
  }
  const axis: Record<string, number> = from === 'margin' ? { x: -12 } : { y: 2 }
  const rest: Record<string, number> = from === 'margin' ? { x: 0 } : { y: 0 }
  return {
    initial: { opacity: 0, ...axis },
    animate: { opacity: 1, ...rest },
    exit: { opacity: 0 },
    transition: { duration: DURATION.base, ease: EASE_OUT },
  }
}

// settle is the transition for layout changes such as list reordering.
export function settle(reduced: boolean) {
  return reduced ? { duration: 0 } : { duration: DURATION.base, ease: EASE_OUT }
}
