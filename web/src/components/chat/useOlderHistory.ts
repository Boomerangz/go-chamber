import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

interface OlderHistory {
  before: number | null
  loading: boolean
  error: string | null
  load: () => Promise<void>
}

// Keep the same visible row when a page is prepended, including browsers
// that already adjusted scrollTop through their native scroll anchoring.
export function useOlderHistory(ref: RefObject<HTMLDivElement | null>, unpin: () => void, { before, loading, error, load }: OlderHistory, dep: unknown) {
  const anchor = useRef<{ row?: Element; top: number; height: number; scroll: number; before: number } | null>(null)
  const capture = useCallback(() => {
    const el = ref.current
    if (!el || before === null) return
    const edge = el.getBoundingClientRect().top
    const row = Array.from(el.querySelectorAll('[data-row]')).find((row) => row.getBoundingClientRect().bottom > edge)
    anchor.current = { row, top: row?.getBoundingClientRect().top ?? 0, height: el.scrollHeight, scroll: el.scrollTop, before }
  }, [ref, before])
  const more = useCallback(() => {
    if (loading || before === null || anchor.current) return
    capture()
    unpin()
    void load()
  }, [loading, before, capture, unpin, load])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const scroll = () => {
      if (loading && anchor.current) capture()
      if (el.scrollTop < 160 && el.scrollHeight > el.clientHeight && !error) more()
    }
    el.addEventListener('scroll', scroll, { passive: true })
    return () => el.removeEventListener('scroll', scroll)
  }, [ref, more, error, loading, capture])
  useLayoutEffect(() => {
    const saved = anchor.current
    const el = ref.current
    if (!saved || !el || loading || (saved.before === before && !error)) return
    if (!error) {
      el.scrollTop += saved.row?.isConnected
        ? saved.row.getBoundingClientRect().top - saved.top
        : saved.scroll + el.scrollHeight - saved.height - el.scrollTop
    }
    anchor.current = null
  }, [ref, before, loading, error, dep])
  return more
}
