import type { Session } from '../../lib/api'
import { recentFolders } from '../../lib/folders'
import { basename } from '../../lib/format'
import { useTerminalStore } from '../../stores/terminals'
import NewTerminalForm from './NewTerminalForm'
import TerminalScreen from './TerminalScreen'

// TerminalWorkspace is terminal mode: shells on their own, apart from agent
// sessions, with the active one filling the screen.
export default function TerminalWorkspace({ sessions }: { sessions: Session[] }) {
  const terminals = useTerminalStore((s) => s.terminals)
  const activeId = useTerminalStore((s) => s.activeId)
  const error = useTerminalStore((s) => s.error)
  const open = useTerminalStore((s) => s.open)
  const close = useTerminalStore((s) => s.close)
  const select = useTerminalStore((s) => s.select)
  const active = terminals.find((t) => t.id === activeId)
  const projects = recentFolders(sessions, 6)

  return (
    <section className="term-workspace" aria-label="Terminals">
      <aside className="term-sidebar panel">
        <NewTerminalForm />
        {projects.length > 0 && (
          <div className="term-projects">
            <h2 className="section-title">Projects</h2>
            <div className="term-chips">
              {projects.map((dir) => (
                <button
                  key={dir}
                  type="button"
                  className="chip"
                  title={dir}
                  aria-label={`Open terminal in ${basename(dir)}`}
                  onClick={() => void open({ cwd: dir })}
                >
                  <span aria-hidden="true">›_</span> {basename(dir)}
                </button>
              ))}
            </div>
          </div>
        )}
        <h2 className="section-title">
          Shells {terminals.length > 0 && <span className="count">{terminals.length}</span>}
        </h2>
        {terminals.length === 0 ? (
          <p className="terminal-hint">No shells yet.</p>
        ) : (
          <ul className="term-list" role="tablist" aria-orientation="vertical">
            {terminals.map((t) => (
              <li key={t.id} role="presentation" className="term-row">
                <button
                  role="tab"
                  id={`terminal-tab-${t.id}`}
                  aria-controls="terminal-panel"
                  aria-selected={t.id === activeId}
                  onClick={() => select(t.id)}
                >
                  <span className={`term-dot term-${t.status}`} aria-hidden="true" />
                  <span className="term-text">
                    <span className="term-title">
                      {t.title}
                      {t.status === 'exited' && <span className="status"> exited {t.exitCode}</span>}
                    </span>
                    <span className="term-cwd" title={t.cwd}>{t.cwd}</span>
                  </span>
                </button>
                <button className="close-terminal" aria-label={`Close terminal ${t.title}`} onClick={() => void close(t.id)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="error">{error}</p>}
      </aside>
      <div className="term-main panel">
        {active ? (
          <>
            <header className="term-header">
              <span className={`term-dot term-${active.status}`} aria-hidden="true" />
              <span className="term-title">{active.title}</span>
              <span className="term-cwd">{active.cwd}</span>
              <span className="term-shell">{basename(active.shell)}</span>
            </header>
            <TerminalScreen id={active.id} />
          </>
        ) : (
          <div className="hero">
            <span className="hero-mark term-mark" aria-hidden="true">
              ›_
            </span>
            <h2>Terminal</h2>
            <p>{terminals.length > 0 ? 'Pick a terminal to attach.' : 'Open a shell in a folder or one of your projects.'}</p>
          </div>
        )}
      </div>
    </section>
  )
}
