import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Terminal } from '../../lib/terminal'
import { useTerminalStore } from '../../stores/terminals'
import { icon } from '../icon'

const REVERT_MS = 4000

interface Props {
  terminal: Terminal
  // label names the button; rows and tabs say which terminal, the header
  // says "this".
  label?: string
  className?: string
  size?: number
}

// CloseTerminalButton closes a terminal. A running shell asks first, in
// place ("kill shell? Close / Keep"), and the question goes away on its own
// after a few seconds; an exited one closes at once.
export default function CloseTerminalButton({ terminal, label, className = 'close-terminal', size = 14 }: Props) {
  const close = useTerminalStore((s) => s.close)
  const closing = useTerminalStore((s) => Boolean(s.closing[terminal.id]))
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), REVERT_MS)
    return () => clearTimeout(timer)
  }, [confirming])

  if (confirming && terminal.status === 'running') {
    return (
      <span className="term-confirm" role="group" aria-label={`Close terminal ${terminal.title}?`}>
        <span className="term-confirm-text">kill shell?</span>
        <button
          type="button"
          className="btn btn-danger btn-xs"
          onClick={() => {
            setConfirming(false)
            void close(terminal.id)
          }}
        >
          Close
        </button>
        <button type="button" className="btn btn-xs" autoFocus onClick={() => setConfirming(false)}>
          Keep
        </button>
      </span>
    )
  }
  const name = label ?? `Close terminal ${terminal.title}`
  return (
    <button
      type="button"
      className={className}
      aria-label={name}
      title={closing ? 'Closing…' : name}
      aria-busy={closing || undefined}
      disabled={closing}
      onClick={() => (terminal.status === 'running' ? setConfirming(true) : void close(terminal.id))}
    >
      <X {...icon(size)} />
    </button>
  )
}
