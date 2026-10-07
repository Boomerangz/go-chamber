import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

// useStickToBottom keeps the chat scrolled to the end while new output
// streams in, unless the user scrolled up to read; then it counts the news
// that arrived meanwhile for the "latest" button. news lists what is worth
// counting (replies and requests, not every tool line), by stable key.
export function useStickToBottom(dep: unknown, news: string[]) {
  const ref = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const newsRef = useRef(news)
  const [pinned, setPinned] = useState(true)
  const [base, setBase] = useState<ReadonlySet<string>>(() => new Set())
  const grown = useRef<ResizeObserver | null>(null)
  useEffect(() => {
    newsRef.current = news
  }, [news])
  const setPinnedTo = useCallback((next: boolean) => {
    if (pinnedRef.current === next) return
    pinnedRef.current = next
    setPinned(next)
    if (!next) setBase(new Set(newsRef.current))
  }, [])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // A box that shrank (a phone's bar or keyboard back, a strip above the
    // composer) can scroll in the same frame, before the resize is reported:
    // that is the box moving, not the owner leaving the end.
    let height = el.clientHeight
    const onScroll = () => {
      const shrank = el.clientHeight < height
      height = el.clientHeight
      if (shrank && pinnedRef.current) {
        el.scrollTop = el.scrollHeight
        return
      }
      setPinnedTo(el.scrollHeight - el.scrollTop - el.clientHeight < 48)
    }
    // Images load after layout and push the end down; follow them.
    const onLoad = () => {
      height = el.clientHeight
      if (pinnedRef.current) el.scrollTop = el.scrollHeight
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('load', onLoad, true)
    // Rows grow after they mount: a size measured a frame later, a row
    // off screen laid out once it comes near. Follow them too. The box
    // itself shrinks when a strip, a notice or the keyboard takes room
    // under it; a view at the end stays there.
    if (typeof ResizeObserver !== 'undefined') {
      grown.current = new ResizeObserver(onLoad)
      grown.current.observe(el)
      for (const child of el.children) grown.current.observe(child)
    }
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('load', onLoad, true)
      grown.current?.disconnect()
      grown.current = null
    }
  }, [setPinnedTo])
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // The transcript replaces its placeholder once loaded; watch what is there now.
    for (const child of el.children) grown.current?.observe(child)
    if (pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [dep])
  const stick = useCallback(() => {
    setPinnedTo(true)
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [setPinnedTo])
  const unpin = useCallback(() => setPinnedTo(false), [setPinnedTo])
  // recheck pins the view again when a jump left it at its end: a chat too
  // short to scroll sends no scroll event that would.
  const recheck = useCallback(() => {
    const el = ref.current
    if (el) setPinnedTo(el.scrollHeight - el.scrollTop - el.clientHeight < 48)
  }, [setPinnedTo])
  const isPinned = useCallback(() => pinnedRef.current, [])
  const unread = pinned ? 0 : news.filter((key) => !base.has(key)).length
  const state = useMemo(() => ({ pinned, unread, stick, unpin, recheck, isPinned }), [pinned, unread, stick, unpin, recheck, isPinned])
  return [ref, state] as const
}
