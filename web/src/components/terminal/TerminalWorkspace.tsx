import { ChevronDown, Copy, SquareTerminal } from 'lucide-react'
import { icon } from '../icon'
import type { Session } from '../../lib/api'
import { liveWorktrees, recentFolders } from '../../lib/folders'
import { basename } from '../../lib/format'
import { fail, notify } from '../../stores/notices'
import { useState } from 'react'
import { useMedia } from '../chat/useMedia'
import { openKey, useTerminalStore } from '../../stores/terminals'
import EditableTitle from '../title/EditableTitle'
import { LoadFailed, LoadingLine } from '../ui/Loading'
import PathText from '../ui/PathText'
import CloseTerminalButton from './CloseTerminalButton'
import NewTerminalForm from './NewTerminalForm'
import TerminalScreen from './TerminalScreen'
import { markOf } from './marks'
import TermTitle from './TermTitle'
import { stepOf, stepTerminal, useTerminalSteps } from './steps'
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
  useTerminalSteps(terminals.map((t) => t.id))
  // On a phone the list folds to one line while a shell is attached.
  const [listOpen, setListOpen] = useState(false)
  // There, unfolded, the shells come first and a new one waits behind "New shell".
  const narrow = useMedia('(max-width: 720px)')
  const [newOpen, setNewOpen] = useState(false)
  const openError = useTerminalStore((s) => s.openError)
  const foldNew = narrow && Boolean(active)
  const projects = recentFolders(sessions, 6)
  // A live worktree is a place of its own: its chip follows its repository's.
  const worktrees = liveWorktrees(sessions)

  let list: React.ReactNode
  const failed = loadError && (
    <LoadFailed onRetry={() => void load()}>
      {loaded || terminals.length > 0 ? `Couldn't refresh shells: ${loadError}` : `Couldn't load shells: ${loadError}`}
    </LoadFailed>
  )
  if (!loaded && terminals.length === 0) {
    list = failed || <LoadingLine>loading shells…</LoadingLine>
  } else if (terminals.length === 0) {
    list = <p className="terminal-hint">No shells yet.</p>
  } else {
    list = (
      <ul
        className="term-list"
        role="tablist"
        aria-orientation="vertical"
        onKeyDown={(e) => {
          const step = stepOf(e)
          if (!step) return
          e.preventDefault()
          stepTerminal(step)
        }}
      >
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
                onClick={() => {
                  select(t.id)
                  setListOpen(false)
                }}
              >
                <span className="term-dot" data-mark={mark.form} title={mark.label} aria-hidden="true" />
                <span className="term-text">
                  <span className="term-title">
                    <TermTitle title={t.title} />
                    {t.status === 'exited' && <span className={t.exitCode === 0 ? 'term-exit' : 'term-exit term-bad'}> exited {t.exitCode}</span>}
                  </span>
                  <PathText path={t.cwd} className="term-cwd" />
                </span>
              </button>
              <CloseTerminalButton terminal={t} />
            </li>
          )
        })}
      </ul>
    )
  }

  const newArea = (
    <div className="term-new-area" data-folded={(foldNew && !newOpen && !openError) || undefined}>
      <NewTerminalForm />
      {projects.length > 0 && (
        <div className="term-projects">
          <h2 className="section-title">Projects</h2>
          <div className="term-chips">
            {projects.flatMap((dir) => [
              <button
                key={dir}
                type="button"
                className="chip"
                title={dir}
                aria-label={`Open terminal in ${basename(dir)}`}
                aria-busy={opening[openKey({ cwd: dir })] || undefined}
                onClick={() => void open({ cwd: dir })}
              >
                <SquareTerminal {...icon(14)} />
                <span className="chip-label">{basename(dir)}</span>
              </button>,
              ...worktrees
                .filter((w) => w.repo === dir)
                .map((w) => (
                  <button
                    key={w.path}
                    type="button"
                    className="chip"
                    title={w.path}
                    aria-label={`Open terminal in ${basename(dir)} ⎇ ${w.branch}`}
                    aria-busy={opening[openKey({ cwd: w.path })] || undefined}
                    onClick={() => void open({ cwd: w.path })}
                  >
                    <SquareTerminal {...icon(14)} />
                    <span className="chip-label">
                      {basename(dir)} <span className="chip-branch">⎇ {w.branch}</span>
                    </span>
                  </button>
                )),
            ])}
          </div>
        </div>
      )}
    </div>
  )

  return (
    // Nothing attached on a phone: the list is the content (CSS drops the hero).
    <section className="term-workspace" aria-label="Terminals" data-attached={active ? 'true' : undefined} data-missing={missingId ? 'true' : undefined}>
      <aside className="term-sidebar panel" data-collapsed={(active && !listOpen) || undefined}>
        {active && (
          <button
            type="button"
            className="term-switch"
            aria-expanded={listOpen}
            onClick={() => {
              setListOpen((o) => !o)
              // the attached shell's row in view, however long the list
              requestAnimationFrame(() => document.getElementById(`terminal-tab-${active.id}`)?.scrollIntoView?.({ block: 'nearest' }))
            }}
          >
            <span className="section-title">Shells</span>
            <span className="count">{terminals.length}</span>
            <TermTitle title={active.title} className="term-switch-title" />
            <ChevronDown {...icon(14)} />
          </button>
        )}
        {!foldNew && newArea}
        <h2 className="section-title">
          Shells {terminals.length > 0 && <span className="count">{terminals.length}</span>}
        </h2>
        {(loaded || terminals.length > 0) && failed}
        {list}
        {foldNew && (
          <>
            <button
              type="button"
              className="term-new-toggle"
              aria-expanded={newOpen}
              onClick={(e) => {
                const toggle = e.currentTarget
                setNewOpen((o) => !o)
                requestAnimationFrame(() => toggle.nextElementSibling?.scrollIntoView?.({ block: 'nearest' }))
              }}
            >
              <span className="section-title">New shell</span>
              <ChevronDown {...icon(14)} />
            </button>
            {newArea}
          </>
        )}
      </aside>
      <div className="term-main panel">
        {active ? (
          <>
            <header className="term-header">
              <span className="term-dot" data-mark={markOf(active, conn[active.id]).form} aria-hidden="true" />
              <EditableTitle className="term-title" value={active.title} label="terminal" onRename={(title) => rename(active.id, title)} />
              <PathText path={active.cwd} className="term-cwd" />
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
            <button type="button" className="btn btn-primary" aria-busy={opening.home || undefined} onClick={() => void open({})}>
              {opening.home ? 'Opening…' : 'Open shell in ~'}
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
