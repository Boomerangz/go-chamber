import { useTerminalStore } from '../../stores/terminals'
import TerminalKeys from './TerminalKeys'
import TerminalView from './TerminalView'
import { reconnectTerminal } from './live'
import { markOf } from './marks'
import './terminal.css'

// TerminalScreen attaches the active terminal. Only one is mounted at a
// time: every attached view answers the shell's terminal queries.
export default function TerminalScreen({ id }: { id: string }) {
  const focusId = useTerminalStore((s) => s.focusId)
  const focusTick = useTerminalStore((s) => s.focusTick)
  const load = useTerminalStore((s) => s.load)
  const markExited = useTerminalStore((s) => s.markExited)
  return (
    <div className="terminal-panel" id="terminal-panel" role="tabpanel" aria-labelledby={`terminal-tab-${id}`}>
      <ConnectionLine id={id} />
      <TerminalKeys id={id} />
      <TerminalView
        key={id}
        id={id}
        autoFocus={id === focusId}
        focusKey={focusTick}
        onExit={(code) => markExited(id, code)}
        onDisconnect={() => void load()}
      />
    </div>
  )
}

// ConnectionLine says, above the screen, what the connection is doing while
// it is not simply live: being made, lost, or the shell has exited.
export function ConnectionLine({ id }: { id: string }) {
  const terminal = useTerminalStore((s) => s.terminals.find((t) => t.id === id))
  const conn = useTerminalStore((s) => s.conn[id])
  const opening = useTerminalStore((s) => s.opening)
  const open = useTerminalStore((s) => s.open)
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
          aria-busy={opening || undefined}
          onClick={() => void open({ cwd: terminal.cwd })}
        >
          {opening ? 'Opening…' : 'Open again here'}
        </button>
        <button type="button" className="btn btn-xs" aria-busy={closing || undefined} disabled={closing} onClick={() => void close(id)}>
          {closing ? 'Closing…' : 'Close'}
        </button>
      </>
    )
  } else if (conn?.state === 'connecting') {
    line = <span className="term-strip-word">connecting…</span>
  } else if (conn?.state === 'reconnecting') {
    line = (
      <span className="term-strip-word">
        reconnecting…{conn.attempt ? ` (attempt ${conn.attempt})` : ''}
      </span>
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
