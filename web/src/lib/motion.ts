// Motion policy: short, typographic movement that conveys state; what needs
// the owner (a request) and what reorders springs with a slight overshoot.
// Under reduced motion nothing travels; a brief fade keeps changes noticeable.

export const DURATION = { fast: 0.12, base: 0.2 } as const
export const EASE_OUT = [0.16, 1, 0.3, 1] as const
export const SPRING = { type: 'spring', visualDuration: 0.32, bounce: 0.22 } as const

type Transition = { duration: number; ease: typeof EASE_OUT | 'linear' } | typeof SPRING

type Origin = 'below' | 'margin'

export interface Enter {
  initial: Record<string, number>
  animate: Record<string, number>
  exit: Record<string, number>
  transition: Transition
}

// enter describes how an item joins the page: settling 2px up, or springing
// in from the left margin (agent requests).
export function enter(reduced: boolean, from: Origin = 'below'): Enter {
  if (reduced) {
    return {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
      transition: { duration: DURATION.fast, ease: 'linear' },
    }
  }
  if (from === 'margin') {
    return { initial: { opacity: 0, x: -16 }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0 }, transition: SPRING }
  }
  return {
    initial: { opacity: 0, y: 2 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0 },
    transition: { duration: DURATION.base, ease: EASE_OUT },
  }
}

// settle is the transition for layout changes such as list reordering.
export function settle(reduced: boolean) {
  return reduced ? { duration: 0 } : SPRING
}
