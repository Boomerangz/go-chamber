import { useLayoutEffect, useState, type CSSProperties } from 'react'
import { useLayoutStore } from '../../stores/layout'
import { useSessionStore } from '../../stores/session'

// Where notices may sit: never over a control. In the open chat that rules
// out the transcript column, whose messages carry their actions (Copy,
// Reuse, a subagent's Stop): the stack takes the margin right of the column
// when it fits there, else the transcript's end, just above the composer.
// With no session open it takes the empty workspace's top right. Without
// either on screen, CSS keeps the stack clear of the dock rail on desktop
// and above the pane bar on a phone.
const CHAT = '.layout > .chat'
const TRANSCRIPT = '.layout > .chat .scroll'
const COLUMN = '.layout > .chat .scroll > .items'
const EMPTY = '.layout > .chat.empty'

const INSET = 12
const WIDTH = 420
// A sheet narrower than this wraps its title word by word.
const MIN_WIDTH = 280

function visibleRect(selector: string): DOMRect | null {
  const el = document.querySelector(selector)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 ? r : null
}

export function noticePlace(): CSSProperties | null {
  const scroll = visibleRect(TRANSCRIPT)
  if (scroll) {
    const column = visibleRect(COLUMN) ?? scroll
    const margin = scroll.right - column.right - 2 * INSET
    if (margin >= MIN_WIDTH) {
      return {
        top: Math.round(scroll.top + INSET),
        right: Math.round(window.innerWidth - scroll.right + INSET),
        bottom: 'auto',
        left: 'auto',
        width: Math.round(Math.min(WIDTH, margin)),
      }
    }
    const right = Math.min(column.right, scroll.right - INSET)
    const left = Math.max(column.left, scroll.left + INSET)
    return {
      top: 'auto',
      right: Math.round(window.innerWidth - right),
      bottom: Math.round(window.innerHeight - scroll.bottom + INSET),
      left: 'auto',
      width: Math.round(Math.max(0, Math.min(WIDTH, right - left))),
    }
  }
  const r = visibleRect(EMPTY)
  if (!r) return null
  return {
    top: Math.round(r.top + INSET),
    right: Math.round(window.innerWidth - r.right + INSET),
    bottom: 'auto',
    left: 'auto',
    width: Math.round(Math.max(0, Math.min(WIDTH, r.width - 2 * INSET))),
  }
}

const same = (a: CSSProperties | null, b: CSSProperties | null) =>
  a === b ||
  (a !== null && b !== null && a.top === b.top && a.bottom === b.bottom && a.right === b.right && a.width === b.width)

// useNoticePlace follows the anchor while notices are shown: on resize, and
// whenever the workspace changes (a session opens, a pane or the dock
// switches, the header wraps). The chat column may be put back after the
// stack was placed (a fork opens, a pane comes back), and what sits above
// the composer may arrive later (the unmerged note): each update observes
// whatever anchor is on screen now, not only the ones there at first.
export function useNoticePlace(active: boolean): CSSProperties | null {
  const [place, setPlace] = useState<CSSProperties | null>(null)
  useLayoutEffect(() => {
    if (!active) return
    let frame = 0
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => later()) : null
    const mutation = typeof MutationObserver === 'function' ? new MutationObserver(() => later()) : null
    const watched = new Set<Element>()
    const watch = () => {
      for (const el of watched) {
        if (el.isConnected) continue
        watched.delete(el)
        resize?.unobserve(el)
      }
      const layout = document.querySelector('.layout')
      for (const el of [document.body, layout, ...[CHAT, TRANSCRIPT, COLUMN, EMPTY].map((s) => document.querySelector(s))]) {
        if (!el || watched.has(el)) continue
        watched.add(el)
        resize?.observe(el)
        // A chat column put in or taken out, or a transcript replaced.
        if (el === layout || el.matches(CHAT)) mutation?.observe(el, { childList: true })
      }
    }
    const update = () => {
      watch()
      const next = noticePlace()
      setPlace((prev) => (same(prev, next) ? prev : next))
    }
    function later() {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(update)
    }
    update()
    window.addEventListener('resize', later)
    const unsubscribe = [useSessionStore.subscribe(later), useLayoutStore.subscribe(later)]
    return () => {
      cancelAnimationFrame(frame)
      resize?.disconnect()
      mutation?.disconnect()
      window.removeEventListener('resize', later)
      unsubscribe.forEach((u) => u())
    }
  }, [active])
  return active ? place : null
}
