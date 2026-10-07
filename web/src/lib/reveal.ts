export interface Span {
  // top is measured from the start of the scrolled content.
  top: number
  height: number
}

// revealTop is the scroll position that brings el into view the way
// scrollIntoView({ block: 'nearest' }) does (a taller element from its
// top), but never so far that less than keep px of what is above el stays
// in view.
export function revealTop(scrollTop: number, viewHeight: number, el: Span, keep: number): number {
  const bottom = el.top + el.height
  if (el.top >= scrollTop && bottom <= scrollTop + viewHeight) return scrollTop
  const nearest = el.height > viewHeight || el.top < scrollTop ? el.top : bottom - viewHeight
  return Math.max(0, Math.min(nearest, el.top - keep))
}

// scrollParent is the nearest ancestor of el that scrolls vertically.
export function scrollParent(el: Element): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY
    if (y === 'auto' || y === 'scroll') return p
  }
  return null
}
