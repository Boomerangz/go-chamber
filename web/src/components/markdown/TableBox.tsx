import { useEffect, useRef, useState, type ReactNode } from 'react'

// fadeOf names the edges a scroll box still has more past: "start" when it
// is scrolled away from its start, "end" when more lies past its end.
export function fadeOf(scrollLeft: number, scrollWidth: number, clientWidth: number): string {
  const edges: string[] = []
  if (scrollLeft > 1) edges.push('start')
  if (scrollLeft + clientWidth < scrollWidth - 1) edges.push('end')
  return edges.join(' ')
}

// TableBox is a markdown table's own scroll box: a table wider than the
// column scrolls here, not the transcript, and fades at the edge with more.
export default function TableBox({ children }: { children?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const [fade, setFade] = useState('')
  useEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setFade(fadeOf(el.scrollLeft, el.scrollWidth, el.clientWidth))
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    ro?.observe(el)
    const table = el.firstElementChild
    if (table) ro?.observe(table)
    return () => {
      el.removeEventListener('scroll', measure)
      ro?.disconnect()
    }
  }, [])
  return (
    <div ref={box} className="md-table" data-fade={fade || undefined}>
      <table>{children}</table>
    </div>
  )
}
