import { useEffect, useState, type RefObject } from 'react'
import type { OutlineEntry } from '../../lib/turns'
import './TurnOutline.css'

// TurnOutline is the transcript's table of contents, hung in the right
// margin where a wide screen has room for it: the turns by number and what
// each asked, the one being read marked, a click away from any. It shares
// the scroll of the transcript and stays at its top; narrower screens never
// show it (the CSS decides, by the transcript's width).
export default function TurnOutline({ entries, scrollRef, reduced }: { entries: OutlineEntry[]; scrollRef: RefObject<HTMLElement | null>; reduced: boolean }) {
  const [picked, setPicked] = usePicked(scrollRef)
  const measured = useCurrentTurn(entries, scrollRef)
  // A turn picked here is the one being read, even where the transcript
  // can't scroll it to the top (the end of a short one); the owner's own
  // scrolling hands the mark back to the measure.
  const current = picked && entries.some((e) => e.id === picked) ? picked : measured
  if (entries.length < 2) return null
  const go = (id: string) => {
    setPicked(id)
    scrollRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' })
  }
  return (
    <nav className="turn-outline" aria-label="Turns">
      <ol>
        {entries.map((e) => (
          <li key={e.id}>
            <button type="button" aria-current={e.id === current ? 'location' : undefined} title={e.text} onClick={() => go(e.id)}>
              <span className="turn-outline-n">{e.n}</span>
              <span className="turn-outline-text">{e.text}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}

// usePicked holds the turn picked in the outline until the owner scrolls
// the transcript by hand (wheel, touch or keys).
function usePicked(scrollRef: RefObject<HTMLElement | null>) {
  const state = useState<string>()
  const [, setPicked] = state
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return
    const drop = () => setPicked(undefined)
    const events = ['wheel', 'touchmove', 'keydown'] as const
    for (const e of events) root.addEventListener(e, drop, { passive: true })
    return () => {
      for (const e of events) root.removeEventListener(e, drop)
    }
  }, [scrollRef, setPicked])
  return state
}

// useCurrentTurn is the turn being read: the last whose row has reached the
// upper third of the transcript, or the last turn once the transcript is at
// its end (a short one never scrolls its last turn up there).
function useCurrentTurn(entries: OutlineEntry[], scrollRef: RefObject<HTMLElement | null>): string | undefined {
  const [current, setCurrent] = useState<string>()
  useEffect(() => {
    const root = scrollRef.current
    if (!root || entries.length < 2) return
    let frame = 0
    const measure = () => {
      frame = 0
      const atEnd = root.scrollHeight - root.scrollTop - root.clientHeight <= 2
      if (atEnd) return setCurrent(entries[entries.length - 1].id)
      const third = root.getBoundingClientRect().top + root.clientHeight / 3
      let at = entries[0].id
      for (const e of entries) {
        const row = root.querySelector<HTMLElement>(`[data-row="${CSS.escape(e.id)}"]`)
        if (row && row.getBoundingClientRect().top <= third) at = e.id
      }
      setCurrent(at)
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measure()
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      root.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [entries, scrollRef])
  return current
}
