import { useState } from 'react'
import Markdown from '../markdown/Markdown'

// Hidden thinking can grow for many streaming batches. Parse it only when
// the user opens the block, using the latest text rather than a cached prefix.
export default function ReasoningView({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <details className="item reasoning" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className={streaming ? 'streaming' : undefined}>{streaming ? 'Thinking…' : 'Thinking'}</summary>
      {open && <Markdown text={text} />}
    </details>
  )
}
