import { useState } from 'react'
import Markdown from '../markdown/Markdown'

// Hidden thinking can grow for many streaming batches. Parse it only when
// the user opens the block, using the latest text rather than a cached prefix.
export default function ReasoningView({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <details className="item reasoning" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Thinking</summary>
      {open && <Markdown text={text} />}
    </details>
  )
}
