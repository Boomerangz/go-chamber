import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

// Place is where the owner was reading a session: at its end (pinned), or a
// row of the transcript and how far below the top of the view its top was.
export type Place = { pinned: true } | { pinned: false; anchor: string; offset: number }

// Places live as long as the page: a reload starts every session at its end.
const places = new Map<string, Place>()

// placeOf reads the place in a scrolled transcript: the first row whose
// bottom is below the top of the view.
export function placeOf(box: HTMLElement, pinned: boolean): Place | undefined {
  if (pinned) return { pinned: true }
  const top = box.getBoundingClientRect().top
  for (const row of box.querySelectorAll<HTMLElement>('[data-row]')) {
    const r = row.getBoundingClientRect()
    if (r.bottom > top) return { pinned: false, anchor: row.dataset.row!, offset: r.top - top }
  }
  return undefined
}

// restorePlace scrolls the transcript so the anchor row sits where it was;
// false when the row is not (yet) in the transcript.
export function restorePlace(box: HTMLElement, place: Place & { pinned: false }): boolean {
  const row = box.querySelector<HTMLElement>(`[data-row="${CSS.escape(place.anchor)}"]`)
  if (!row) return false
  box.scrollTop += row.getBoundingClientRect().top - box.getBoundingClientRect().top - place.offset
  return true
}

interface Stick {
  isPinned: () => boolean
  unpin: () => void
  recheck: () => void
}

// useReadingPlace remembers where the owner was reading each session and
// takes them back there on return, once the transcript is shown. A session
// read to its end opens at its end, as before. It reports whether a place
// was restored, so the "new since you left" landing can step aside.
export function useReadingPlace(
  sessionId: string | undefined,
  box: RefObject<HTMLElement | null>,
  stick: Stick,
  shown: boolean,
  ready: boolean,
): RefObject<boolean> {
  const settled = useRef(false)
  const restored = useRef(false)
  useLayoutEffect(() => {
    const el = box.current
    if (settled.current || !sessionId || !el || !shown) return
    const place = places.get(sessionId)
    if (!place || place.pinned) {
      settled.current = true
      return
    }
    if (restorePlace(el, place)) {
      stick.unpin()
      stick.recheck()
      restored.current = true
      settled.current = true
    } else if (ready) {
      settled.current = true
    }
  })
  useEffect(() => {
    const el = box.current
    if (!el || !sessionId) return
    let frame = 0
    const save = () => {
      frame = 0
      // Until the place is restored, scrolling is the page's, not the owner's.
      if (!settled.current) return
      const place = placeOf(el, stick.isPinned())
      if (place) places.set(sessionId, place)
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(save)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [box, sessionId, stick])
  return restored
}
