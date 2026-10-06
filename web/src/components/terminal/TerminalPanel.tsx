import { ChevronDown, Maximize2, Pencil, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { icon } from '../icon'
import { basename } from '../../lib/format'
import type { Terminal } from '../../lib/terminal'
import { useLayoutStore } from '../../stores/layout'
import { openKey, useTerminalStore } from '../../stores/terminals'
import FolderField from '../folders/FolderField'
import { LoadFailed, LoadingLine } from '../ui/Loading'
import CloseTerminalButton from './CloseTerminalButton'
import { OpenError } from './NewTerminalForm'
import TerminalScreen from './TerminalScreen'
import { markOf, sortForSession } from './marks'
import { stepOf, stepTerminal, useTerminalSteps } from './steps'
import './terminal.css'

// TerminalPanel is the ad-hoc terminal docked next to the chat: one row of
// tabs ending in "+", which opens a shell in the session's folder.
export default function TerminalPanel({ sessionId }: { sessionId: string | null }) {
  const terminals = useTerminalStore((s) => s.terminals)
  const loaded = useTerminalStore((s) => s.loaded)
  const loadError = useTerminalStore((s) => s.loadError)
  const load = useTerminalStore((s) => s.load)
  const activeId = useTerminalStore((s) => s.activeId)
  const setMode = useLayoutStore((s) => s.setMode)
  const sorted = sortForSession(terminals, sessionId)
  useTerminalSteps(sorted.map((t) => t.id))
  // A remembered or linked terminal attaches only once the list has it.
  const attached = activeId && terminals.some((t) => t.id === activeId) ? activeId : null

  return (
    <section className="terminals panel" aria-label="Terminals">
      <header className="dock-header">
        <h2 className="section-title">Terminals</h2>
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Open in terminal mode" title="Open in terminal mode" onClick={() => setMode('terminal')}>
          <Maximize2 {...icon(14)} />
        </button>
      </header>
      <div className="dock-tabs">
        {sorted.length > 0 && (
          <ul
            className="terminal-tabs"
            role="tablist"
            onKeyDown={(e) => {
              const step = stepOf(e)
              if (!step) return
              e.preventDefault()
              stepTerminal(step)
            }}
          >
            {sorted.map((t) => (
              <TerminalTab key={t.id} terminal={t} selected={t.id === activeId} />
            ))}
          </ul>
        )}
        <NewTerminalButton sessionId={sessionId} />
      </div>
      <OpenError />
      {loadError && (
        <LoadFailed onRetry={() => void load()}>
          {loaded || terminals.length > 0 ? `Couldn’t refresh shells: ${loadError}` : `Couldn’t load shells: ${loadError}`}
        </LoadFailed>
      )}
      {!loaded && terminals.length === 0 && !loadError && <LoadingLine>loading shells…</LoadingLine>}
      {loaded && !attached && (
        <p className="terminal-hint">
          {terminals.length > 0 ? 'Pick a terminal tab to attach.' : sessionId ? 'No shells yet. + opens one in the session folder.' : 'No shells yet. + opens one in your home folder.'}
        </p>
      )}
      {attached && <TerminalScreen id={attached} />}
    </section>
  )
}

function TerminalTab({ terminal: t, selected }: { terminal: Terminal; selected: boolean }) {
  const select = useTerminalStore((s) => s.select)
  const rename = useTerminalStore((s) => s.rename)
  const conn = useTerminalStore((s) => s.conn[t.id])
  const closing = useTerminalStore((s) => Boolean(s.closing[t.id]))
  const [draft, setDraft] = useState<string | null>(null)
  const mark = markOf(t, conn)
  const folder = basename(t.cwd) || t.cwd
  const save = () => {
    if (draft === null) return
    const next = draft.trim()
    setDraft(null)
    if (next && next !== t.title) void rename(t.id, next)
  }
  return (
    <li role="presentation" className={closing ? 'closing' : undefined} aria-busy={closing || undefined}>
      {draft !== null ? (
        <input
          className="title-input term-tab-input"
          aria-label="terminal name"
          value={draft}
          maxLength={200}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              save()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setDraft(null)
            }
          }}
        />
      ) : (
        <button
          role="tab"
          id={`terminal-tab-${t.id}`}
          aria-controls="terminal-panel"
          aria-selected={selected}
          title={`${t.title} — ${t.cwd}`}
          disabled={closing}
          onClick={() => select(t.id)}
          onDoubleClick={() => setDraft(t.title)}
        >
          <span className="term-dot" data-mark={mark.form} aria-hidden="true" />
          <span className="term-tab-text">
            <span className="term-tab-title">{t.title}</span>
            {folder !== t.title && <span className="term-tab-cwd">{folder}</span>}
          </span>
          {t.status === 'exited' && <span className={t.exitCode === 0 ? 'term-exit' : 'term-exit term-bad'}>exited {t.exitCode}</span>}
        </button>
      )}
      {selected && draft === null && (
        <button type="button" className="btn btn-ghost btn-icon term-tab-rename" aria-label={`Rename terminal ${t.title}`} title="Rename" onClick={() => setDraft(t.title)}>
          <Pencil {...icon(12)} />
        </button>
      )}
      <CloseTerminalButton terminal={t} size={13} />
    </li>
  )
}

// NewTerminalButton opens a shell in the session folder (or home without a
// session); its menu offers home and any other folder.
function NewTerminalButton({ sessionId }: { sessionId: string | null }) {
  const open = useTerminalStore((s) => s.open)
  const opening = useTerminalStore((s) => s.opening)
  const [menu, setMenu] = useState(false)
  const [cwd, setCwd] = useState('')
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const outside = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node) && !(e.target as Element).closest?.('.picker-backdrop')) setMenu(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [menu])
  const openIn = async (opts: { cwd?: string; sessionId?: string }) => {
    if (await open(opts)) {
      setMenu(false)
      setCwd('')
    }
  }
  const here = sessionId ? { sessionId } : {}
  const busyHere = Boolean(opening[openKey(here)])
  const busyHome = Boolean(opening[openKey({})])
  const busyFolder = Boolean(cwd.trim() && opening[openKey({ cwd: cwd.trim() })])
  const label = sessionId ? 'New terminal in session dir' : 'New terminal in home folder'
  return (
    <div
      className="term-new"
      ref={box}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && menu) {
          e.stopPropagation()
          setMenu(false)
        }
      }}
    >
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        aria-label={label}
        title={busyHere ? 'Opening…' : label}
        aria-busy={busyHere || undefined}
        onClick={() => void open(here)}
      >
        <Plus {...icon(15)} />
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-icon term-new-more"
        aria-label="Open a terminal elsewhere"
        title="Open a terminal elsewhere"
        aria-expanded={menu}
        aria-haspopup="true"
        onClick={() => setMenu((m) => !m)}
      >
        <ChevronDown {...icon(13)} />
      </button>
      {menu && (
        <div className="term-new-menu" role="group" aria-label="Open a terminal in">
          <button type="button" className="btn btn-xs" aria-busy={busyHome || undefined} onClick={() => void openIn({})}>
            {busyHome ? 'Opening…' : 'Home folder'}
          </button>
          <form
            className="term-new-folder"
            onSubmit={(e) => {
              e.preventDefault()
              const dir = cwd.trim()
              if (dir) void openIn({ cwd: dir })
            }}
          >
            <FolderField label="terminal directory" placeholder="another folder" value={cwd} onChange={setCwd} />
            <button type="submit" className="btn btn-xs" disabled={!cwd.trim()} aria-busy={busyFolder || undefined}>
              {busyFolder ? 'Opening…' : 'Open'}
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
