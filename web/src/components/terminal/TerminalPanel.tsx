import { useLayoutStore } from '../../stores/layout'
import { useTerminalStore } from '../../stores/terminals'
import NewTerminalForm from './NewTerminalForm'
import TerminalScreen from './TerminalScreen'

// TerminalPanel is the ad-hoc terminal docked next to the chat.
export default function TerminalPanel({ sessionId }: { sessionId: string | null }) {
  const terminals = useTerminalStore((s) => s.terminals)
  const activeId = useTerminalStore((s) => s.activeId)
  const error = useTerminalStore((s) => s.error)
  const close = useTerminalStore((s) => s.close)
  const select = useTerminalStore((s) => s.select)
  const setMode = useLayoutStore((s) => s.setMode)

  return (
    <section className="terminals panel" aria-label="Terminals">
      <header className="dock-header">
        <h2 className="section-title">Terminals</h2>
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Open in terminal mode" title="Open in terminal mode" onClick={() => setMode('terminal')}>
          <span aria-hidden="true">⤢</span>
        </button>
      </header>
      <NewTerminalForm sessionId={sessionId} />
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
      {!activeId && (
        <p className="terminal-hint">
          {terminals.length > 0 ? 'Pick a terminal tab to attach.' : 'Open a shell in your home folder or the session folder.'}
        </p>
      )}
      {activeId && <TerminalScreen id={activeId} />}
    </section>
  )
}
