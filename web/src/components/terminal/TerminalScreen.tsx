import { ArrowDown, ChevronDown, ChevronUp, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTerminalStore } from '../../stores/terminals'
import { icon } from '../icon'
import TerminalKeys from './TerminalKeys'
import TerminalView from './TerminalView'
import { endFind, findInTerminal, onFindResults, reconnectTerminal, scrollToBottom, type FindResult } from './live'
import { markOf } from './marks'
import './terminal.css'

// TerminalScreen attaches the active terminal. Only one is mounted at a
// time: every attached view answers the shell's terminal queries.
export default function TerminalScreen({ id }: { id: string }) {
  const focusId = useTerminalStore((s) => s.focusId)
  const focusTick = useTerminalStore((s) => s.focusTick)
  const load = useTerminalStore((s) => s.load)
  const markExited = useTerminalStore((s) => s.markExited)
  const finding = useTerminalStore((s) => s.finding === id)
  const unseen = useTerminalStore((s) => Boolean(s.unseen[id]))
  const exited = useTerminalStore((s) => s.terminals.find((t) => t.id === id)?.status === 'exited')
  return (
    <div className="terminal-panel" id="terminal-panel" role="tabpanel" aria-labelledby={`terminal-tab-${id}`}>
      <ConnectionLine id={id} />
      {finding && <FindBar id={id} />}
      {!exited && <TerminalKeys id={id} />}
      <div className="term-screen">
        <TerminalView
          key={id}
          id={id}
          autoFocus={id === focusId}
          focusKey={focusTick}
          onExit={(code) => markExited(id, code)}
          onDisconnect={() => void load()}
        />
        <ZoomLevel />
        {unseen && (
          <button type="button" className="btn btn-xs term-new-output" onClick={() => scrollToBottom(id)}>
            <ArrowDown {...icon(14)} /> new output
          </button>
        )}
      </div>
    </div>
  )
}

const ZOOM_SHOWN_MS = 1200

// ZoomLevel says the text size for a moment after it changes.
function ZoomLevel() {
  const size = useTerminalStore((s) => s.fontSize)
  const [shown, setShown] = useState<number | null>(null)
  const first = useRef<number | null>(size)
  useEffect(() => {
    if (size === first.current) return
    first.current = null
    setShown(size)
    const timer = setTimeout(() => setShown(null), ZOOM_SHOWN_MS)
    return () => clearTimeout(timer)
  }, [size])
  if (shown === null) return null
  return (
    <span className="term-zoom" role="status" aria-label="Text size">
      {shown}px
    </span>
  )
}

// FindBar searches the terminal's scrollback from the newest output up:
// Enter for the next older match, Shift+Enter for a newer one, Escape to go
// back to the shell.
export function FindBar({ id }: { id: string }) {
  const setFinding = useTerminalStore((s) => s.setFinding)
  const [term, setTerm] = useState('')
  const [result, setResult] = useState<FindResult | null>(null)
  const [missed, setMissed] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => onFindResults(id, setResult), [id])
  // ⌘F again while the bar is open selects the term to type over it.
  const tick = useTerminalStore((s) => s.findTick)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [tick])
  const find = (value: string, opts: { backwards?: boolean; incremental?: boolean } = {}) => {
    const found = findInTerminal(id, value, opts)
    setMissed(Boolean(value) && !found)
    if (!value) setResult(null)
  }
  const close = () => {
    setFinding(id, false)
    endFind(id)
  }
  let status = ''
  if (term && result && result.count > 0) status = result.index >= 0 ? `${result.index + 1} of ${result.count}` : `${result.count} found`
  else if (term && (missed || result?.count === 0)) status = 'no matches'
  return (
    <div className="term-strip term-find" role="search" aria-label="Find in terminal">
      <input
        ref={input}
        className="field term-find-input"
        type="search"
        aria-label="Find in terminal"
        placeholder="Find in scrollback"
        value={term}
        autoFocus
        onChange={(e) => {
          setTerm(e.target.value)
          find(e.target.value, { incremental: true, backwards: true })
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            find(term, { backwards: !e.shiftKey })
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            close()
          }
        }}
      />
      <span className="term-strip-word term-find-count" aria-live="polite">{status}</span>
      <button type="button" className="btn btn-ghost btn-icon" aria-label="Older match" title="Older match (Enter)" disabled={!term} onClick={() => find(term, { backwards: true })}>
        <ChevronUp {...icon(14)} />
      </button>
      <button type="button" className="btn btn-ghost btn-icon" aria-label="Newer match" title="Newer match (Shift+Enter)" disabled={!term} onClick={() => find(term)}>
        <ChevronDown {...icon(14)} />
      </button>
      <button type="button" className="btn btn-ghost btn-icon" aria-label="Close find" title="Close (Esc)" onClick={close}>
        <X {...icon(14)} />
      </button>
    </div>
  )
}

// ConnectionLine says, above the screen, what the connection is doing while
// it is not simply live: being made, lost, or the shell has exited.
export function ConnectionLine({ id }: { id: string }) {
  const terminal = useTerminalStore((s) => s.terminals.find((t) => t.id === id))
  const conn = useTerminalStore((s) => s.conn[id])
  const reopening = useTerminalStore((s) => Boolean(s.opening[`reopen:${id}`]))
  const reopen = useTerminalStore((s) => s.reopen)
  const close = useTerminalStore((s) => s.close)
  const closing = useTerminalStore((s) => Boolean(s.closing[id]))
  if (!terminal) return null
  const { form } = markOf(terminal, conn)
  let line: React.ReactNode = null
  if (terminal.status === 'exited') {
    line = (
      <>
        <span className={terminal.exitCode === 0 ? 'term-strip-word' : 'term-strip-word term-bad'}>exited {terminal.exitCode}</span>
        <button
          type="button"
          className="btn btn-xs"
          aria-busy={reopening || undefined}
          title="Start a new terminal in the same folder, in place of this one"
          onClick={() => void reopen(id)}
        >
          {reopening ? 'Opening…' : 'Open again here'}
        </button>
        <button type="button" className="btn btn-xs" aria-busy={closing || undefined} disabled={closing || reopening} onClick={() => void close(id)}>
          {closing ? 'Closing…' : 'Close'}
        </button>
      </>
    )
  } else if (conn?.state === 'connecting') {
    line = <span className="term-strip-word">connecting…</span>
  } else if (conn?.state === 'reconnecting') {
    line = (
      <>
        <span className="term-strip-word">
          reconnecting…{conn.attempt ? ` (attempt ${conn.attempt})` : ''}
        </span>
        <button type="button" className="btn btn-xs" onClick={() => reconnectTerminal(id)}>
          Reconnect now
        </button>
      </>
    )
  } else if (conn?.state === 'disconnected') {
    line = (
      <>
        <span className="term-strip-word">disconnected</span>
        <button type="button" className="btn btn-xs" onClick={() => reconnectTerminal(id)}>
          Reconnect
        </button>
      </>
    )
  }
  if (!line) return null
  return (
    <div className="term-strip" role="status" aria-live="polite">
      <span className="term-dot" data-mark={form} aria-hidden="true" />
      {line}
    </div>
  )
}
