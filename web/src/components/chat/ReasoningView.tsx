import { useEffect, useState } from 'react'
import Markdown from '../markdown/Markdown'

// lastLine is the newest non-empty line of streaming thoughts, for the preview.
function lastLine(text: string): string | undefined {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.replace(/[*_`#>]+/g, '').trim()
    if (line) return line
  }
  return undefined
}

// thoughtFor reads how long the agent thought, as the summary says it.
function thoughtFor(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  return s < 60 ? `Thought for ${s}s` : `Thought for ${Math.floor(s / 60)}m ${s % 60}s`
}

// Hidden thinking can grow for many streaming batches. Parse it only when
// the user opens the block, using the latest text rather than a cached prefix.
// While it streams, the summary shows its newest line; once done, how long
// the thinking took when this view saw it start, or just "Thought".
export default function ReasoningView({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false)
  // started is set only when the view saw the thinking begin.
  const [started] = useState(() => (streaming ? Date.now() : null))
  const [took, setTook] = useState<number | null>(null)
  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- the end is read from the clock once
    if (!streaming && started !== null) setTook((t) => t ?? Date.now() - started)
  }, [streaming, started])
  const preview = streaming && !open ? lastLine(text) : undefined
  return (
    <details className="item reasoning" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className={streaming ? 'streaming' : undefined}>
        <span className="reasoning-label">{streaming ? 'Thinking…' : took !== null ? thoughtFor(took) : 'Thought'}</span>
        {preview && (
          <span className="reasoning-preview" title={preview}>
            {preview}
          </span>
        )}
      </summary>
      {open && <Markdown text={text} />}
    </details>
  )
}
