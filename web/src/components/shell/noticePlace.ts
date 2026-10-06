import { useLayoutEffect, useState, type CSSProperties } from 'react'
import { useLayoutStore } from '../../stores/layout'
import { useSessionStore } from '../../stores/session'

// Where notices may sit: the top of what is being read, never over a
// control. The open chat's transcript (below its header, above the
// composer), else the empty workspace. Without either on screen, CSS keeps
// the stack clear of the dock rail on desktop and above the pane bar on a
// phone.
const ANCHORS = ['.layout > .chat .scroll', '.layout > .chat.empty']

const INSET = 12
const WIDTH = 420

function visibleRect(selector: string): DOMRect | null {
  const el = document.querySelector(selector)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 ? r : null
}

export function noticePlace(): CSSProperties | null {
  for (const selector of ANCHORS) {
    const r = visibleRect(selector)
    if (!r) continue
    return {
      top: Math.round(r.top + INSET),
      right: Math.round(window.innerWidth - r.right + INSET),
      bottom: 'auto',
      left: 'auto',
      width: Math.round(Math.max(0, Math.min(WIDTH, r.width - 2 * INSET))),
    }
  }
  return null
}

const same = (a: CSSProperties | null, b: CSSProperties | null) =>
  a === b || (a !== null && b !== null && a.top === b.top && a.right === b.right && a.width === b.width)

// useNoticePlace follows the anchor while notices are shown: on resize, and
// whenever the workspace changes (a session opens, a pane or the dock
// switches, the header wraps).
export function useNoticePlace(active: boolean): CSSProperties | null {
  const [place, setPlace] = useState<CSSProperties | null>(null)
  useLayoutEffect(() => {
    if (!active) return
    let frame = 0
    const update = () => {
      const next = noticePlace()
      setPlace((prev) => (same(prev, next) ? prev : next))
    }
    const later = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(update)
    }
    update()
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(later) : null
    resize?.observe(document.body)
    const layout = document.querySelector('.layout')
    if (layout) resize?.observe(layout)
    for (const selector of ANCHORS) {
      const el = document.querySelector(selector)
      if (el) resize?.observe(el)
    }
    window.addEventListener('resize', later)
    const unsubscribe = [useSessionStore.subscribe(later), useLayoutStore.subscribe(later)]
    return () => {
      cancelAnimationFrame(frame)
      resize?.disconnect()
      window.removeEventListener('resize', later)
      unsubscribe.forEach((u) => u())
    }
  }, [active])
  return active ? place : null
}
