import { useEffect, useRef, useState } from 'react'

interface Line { id: number; text: string }
interface Page { lines: Line[]; nextBefore: number; evictedThrough: number }

// History is plain text in its own reader. It never passes escape sequences
// back through the interactive terminal parser.
export default function TerminalHistory({ id, onClose }: { id: string; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [before, setBefore] = useState(0)
  const [evicted, setEvicted] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const request = useRef<AbortController | null>(null)
  const list = useRef<HTMLPreElement>(null)
  const load = async (cursor: number) => {
    const mine = ++generation.current
    request.current?.abort()
    const controller = new AbortController(); request.current = controller
    setLoading(true); setError('')
    try {
      const params = new URLSearchParams({ q: query, limit: '200' })
      if (cursor) params.set('before', String(cursor))
      const response = await fetch(`/api/terminals/${encodeURIComponent(id)}/history?${params}`, { credentials: 'same-origin', signal: controller.signal })
      if (!response.ok) throw new Error('Could not load terminal history')
      const page = await response.json() as Page
      if (mine !== generation.current) return
      const height = list.current?.scrollHeight ?? 0
      setLines((old) => cursor ? [...page.lines, ...old.filter((line) => !page.lines.some((next) => next.id === line.id))] : page.lines)
      setBefore(page.nextBefore); setEvicted(page.evictedThrough)
      if (cursor) requestAnimationFrame(() => { if (list.current && mine === generation.current) list.current.scrollTop += list.current.scrollHeight - height })
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'History unavailable') }
    finally { if (mine === generation.current) setLoading(false) }
  }
  useEffect(() => {
    const timer = setTimeout(() => void load(0), 150)
    return () => { clearTimeout(timer); generation.current++; request.current?.abort() }
    // load uses the current query; restarting the request is the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, query])
  return <section className="term-history" aria-label="Terminal history">
    <div className="term-strip">
      <input className="field" aria-label="Search terminal history" placeholder="Search history" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') onClose() }} autoFocus />
      <button type="button" className="btn btn-xs" onClick={onClose}>Back to terminal</button>
      <button type="button" className="btn btn-xs" onClick={() => void load(0)} disabled={loading}>Refresh history</button>
    </div>
    {evicted > 0 && <span role="status">Earlier history through line {evicted} was evicted.</span>}
    {error && <span role="alert">{error}</span>}
    {before > 0 && <button type="button" className="btn btn-xs" disabled={loading} onClick={() => void load(before)}>Load older</button>}
    <pre ref={list} tabIndex={0} className="term-history-lines">{lines.map((line) => <span key={line.id} data-line={line.id}>{line.text}{'\n'}</span>)}</pre>
    {loading && <span role="status">Loading history…</span>}
  </section>
}
