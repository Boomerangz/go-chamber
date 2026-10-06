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
    const onScroll = () => setPinnedTo(el.scrollHeight - el.scrollTop - el.clientHeight < 48)
    // Images load after layout and push the end down; follow them.
    const onLoad = () => {
      if (pinnedRef.current) el.scrollTop = el.scrollHeight
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('load', onLoad, true)
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('load', onLoad, true)
    }
  }, [setPinnedTo])
  useLayoutEffect(() => {
    const el = ref.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [dep])
  const stick = useCallback(() => {
    setPinnedTo(true)
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [setPinnedTo])
  const unpin = useCallback(() => setPinnedTo(false), [setPinnedTo])
  const isPinned = useCallback(() => pinnedRef.current, [])
  const unread = pinned ? 0 : news.filter((key) => !base.has(key)).length
  const state = useMemo(() => ({ pinned, unread, stick, unpin, isPinned }), [pinned, unread, stick, unpin, isPinned])
  return [ref, state] as const
}
