import { useEffect, useState } from 'react'

// matches reads a media query once; false where matchMedia is missing (tests).
export function matches(query: string): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.(query).matches
}

// useMedia follows a media query, e.g. the phone layout at (max-width: 720px).
export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => matches(query))
  useEffect(() => {
    const list = typeof window !== 'undefined' ? window.matchMedia?.(query) : undefined
    if (!list) return
    const update = () => setOn(list.matches)
    update()
    list.addEventListener?.('change', update)
    return () => list.removeEventListener?.('change', update)
  }, [query])
  return on
}

// isMac picks the shortcut glyphs: ⌘ on Apple devices, Ctrl elsewhere.
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
}
