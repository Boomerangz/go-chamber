import { useEffect, useState } from 'react'
import { useTerminalStore } from '../../stores/terminals'
import TerminalView from './TerminalView'

// TerminalPanel lists shells independent of sessions: a new terminal opens
// in the given directory (home by default) or in the active session's one.
export default function TerminalPanel({ sessionId }: { sessionId: string | null }) {
  const terminals = useTerminalStore((s) => s.terminals)
  const activeId = useTerminalStore((s) => s.activeId)
  const focusId = useTerminalStore((s) => s.focusId)
  const error = useTerminalStore((s) => s.error)
  const load = useTerminalStore((s) => s.load)
  const open = useTerminalStore((s) => s.open)
  const close = useTerminalStore((s) => s.close)
  const select = useTerminalStore((s) => s.select)
  const markExited = useTerminalStore((s) => s.markExited)
  const [cwd, setCwd] = useState('')

  useEffect(() => {
    void load()
  }, [load])

  return (
    <section className="terminals" aria-label="Terminals">
      <form
        className="new-terminal"
        onSubmit={(e) => {
          e.preventDefault()
          const dir = cwd.trim()
          void open(dir ? { cwd: dir } : {})
          setCwd('')
        }}
      >
        <input
          aria-label="terminal directory"
          placeholder="~ (home)"
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
        />
        <button type="submit">New terminal</button>
        {sessionId && (
          <button type="button" onClick={() => void open({ sessionId })}>
            In session dir
          </button>
        )}
      </form>
      {terminals.length > 0 && (
        <ul className="terminal-tabs" role="tablist">
          {terminals.map((t) => (
            <li key={t.id} role="presentation">
              <button
                role="tab"
                id={`terminal-tab-${t.id}`}
                aria-controls="terminal-panel"
                aria-selected={t.id === activeId}
                title={t.cwd}
                onClick={() => select(t.id)}
              >
                {t.title}
                {t.status === 'exited' && <span className="status"> exited {t.exitCode}</span>}
              </button>
              <button className="close-terminal" aria-label={`Close terminal ${t.title}`} onClick={() => void close(t.id)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error">{error}</p>}
      {activeId && (
        <div
          className="terminal-panel"
          id="terminal-panel"
          role="tabpanel"
          aria-labelledby={`terminal-tab-${activeId}`}
        >
          <TerminalView
            key={activeId}
            id={activeId}
            autoFocus={activeId === focusId}
            onExit={(code) => markExited(activeId, code)}
            onDisconnect={() => void load()}
          />
        </div>
      )}
    </section>
  )
}
