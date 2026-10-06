import { Copy, SquareTerminal } from 'lucide-react'
import { icon } from '../icon'
import type { Session } from '../../lib/api'
import { recentFolders } from '../../lib/folders'
import { basename } from '../../lib/format'
import { fail, notify } from '../../stores/notices'
import { useTerminalStore } from '../../stores/terminals'
import EditableTitle from '../title/EditableTitle'
import { LoadFailed, LoadingLine } from '../ui/Loading'
import CloseTerminalButton from './CloseTerminalButton'
import NewTerminalForm from './NewTerminalForm'
import TerminalScreen from './TerminalScreen'
import { markOf } from './marks'
import './terminal.css'

const copyPath = async (path: string) => {
  try {
    await navigator.clipboard.writeText(path)
    notify({ kind: 'info', text: 'Copied the folder path', key: 'copy-cwd' })
  } catch (err) {
    fail('Copy failed', err)
  }
}

// TerminalWorkspace is terminal mode: shells on their own, apart from agent
// sessions, with the active one filling the screen.
export default function TerminalWorkspace({ sessions }: { sessions: Session[] }) {
  const terminals = useTerminalStore((s) => s.terminals)
  const loaded = useTerminalStore((s) => s.loaded)
  const loadError = useTerminalStore((s) => s.loadError)
  const load = useTerminalStore((s) => s.load)
  const activeId = useTerminalStore((s) => s.activeId)
  const missingId = useTerminalStore((s) => s.missingId)
  const conn = useTerminalStore((s) => s.conn)
  const closing = useTerminalStore((s) => s.closing)
  const opening = useTerminalStore((s) => s.opening)
  const rename = useTerminalStore((s) => s.rename)
  const open = useTerminalStore((s) => s.open)
  const select = useTerminalStore((s) => s.select)
  const active = terminals.find((t) => t.id === activeId)
  const projects = recentFolders(sessions, 6)

  let list: React.ReactNode
  if (!loaded && terminals.length === 0) {
    list = loadError ? (
      <LoadFailed onRetry={() => void load()}>{`Couldn’t load shells: ${loadError}`}</LoadFailed>
    ) : (
      <LoadingLine>loading shells…</LoadingLine>
    )
  } else if (terminals.length === 0) {
    list = <p className="terminal-hint">No shells yet.</p>
  } else {
    list = (
      <ul className="term-list" role="tablist" aria-orientation="vertical">
        {terminals.map((t) => {
          const mark = markOf(t, conn[t.id])
          const isClosing = Boolean(closing[t.id])
          return (
            <li key={t.id} role="presentation" className={isClosing ? 'term-row closing' : 'term-row'} aria-busy={isClosing || undefined}>
              <button
                role="tab"
                id={`terminal-tab-${t.id}`}
                aria-controls="terminal-panel"
                aria-selected={t.id === activeId}
                disabled={isClosing}
                onClick={() => select(t.id)}
              >
                <span className="term-dot" data-mark={mark.form} title={mark.label} aria-hidden="true" />
                <span className="term-text">
                  <span className="term-title">
                    {t.title}
                    {t.status === 'exited' && <span className={t.exitCode === 0 ? 'term-exit' : 'term-exit term-bad'}> exited {t.exitCode}</span>}
                  </span>
                  <span className="term-cwd" title={t.cwd}>{t.cwd}</span>
                </span>
              </button>
              <CloseTerminalButton terminal={t} />
            </li>
          )
        })}
      </ul>
    )
  }

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
                  aria-busy={opening || undefined}
                  onClick={() => void open({ cwd: dir })}
                >
                  <SquareTerminal {...icon(13)} /> {basename(dir)}
                </button>
              ))}
            </div>
          </div>
        )}
        <h2 className="section-title">
          Shells {terminals.length > 0 && <span className="count">{terminals.length}</span>}
        </h2>
        {list}
      </aside>
      <div className="term-main panel">
        {active ? (
          <>
            <header className="term-header">
              <span className="term-dot" data-mark={markOf(active, conn[active.id]).form} aria-hidden="true" />
              <EditableTitle className="term-title" value={active.title} label="terminal" onRename={(title) => rename(active.id, title)} />
              <span className="term-cwd" title={active.cwd}>{active.cwd}</span>
              <span className="term-shell">{basename(active.shell)}</span>
              <span className="term-header-actions">
                <button type="button" className="btn btn-ghost btn-icon" aria-label="Copy folder path" title="Copy folder path" onClick={() => void copyPath(active.cwd)}>
                  <Copy {...icon(14)} />
                </button>
                <CloseTerminalButton terminal={active} label="Close this shell" className="btn btn-ghost btn-icon" />
              </span>
            </header>
            <TerminalScreen id={active.id} />
          </>
        ) : (
          <div className="hero">
            <h2>Terminal</h2>
            {missingId && <p className="term-missing">terminal no longer exists</p>}
            <p>{terminals.length > 0 ? 'Pick a terminal to attach.' : 'Open a shell in a folder or one of your projects.'}</p>
            <button type="button" className="btn btn-primary" aria-busy={opening || undefined} onClick={() => void open({})}>
              {opening ? 'Opening…' : 'Open shell in ~'}
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
