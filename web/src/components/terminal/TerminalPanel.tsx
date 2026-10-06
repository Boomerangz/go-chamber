import { ChevronDown, Maximize2, Pencil, Plus } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { icon } from '../icon'
import { basename } from '../../lib/format'
import type { Terminal } from '../../lib/terminal'
import { useLayoutStore } from '../../stores/layout'
import { useSessionStore } from '../../stores/session'
import { openKey, useTerminalStore } from '../../stores/terminals'
import FolderField from '../folders/FolderField'
import { LoadFailed, LoadingLine } from '../ui/Loading'
import CloseTerminalButton from './CloseTerminalButton'
import { OpenError } from './NewTerminalForm'
import TerminalScreen from './TerminalScreen'
import { markOf, sortForSession } from './marks'
import { stepOf, stepTerminal, useTerminalSteps } from './steps'
import TermTitle from './TermTitle'
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
  const select = useTerminalStore((s) => s.select)
  const open = useTerminalStore((s) => s.open)
  const sorted = sortForSession(terminals, sessionId)
  useTerminalSteps(sorted.map((t) => t.id))
  // The dock is the open session's: its shells are those opened for it or
  // in its folder. A shell of another project that was attached when the
  // session opened (or restored with the page) stays in its tab until it
  // is picked here; one opened or picked here attaches.
  const cwd = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId)?.cwd)
  const belongs = (t: Terminal) => !sessionId || t.sessionId === sessionId || (cwd !== undefined && t.cwd === cwd)
  const [scope, setScope] = useState<{ session: string | null; loaded: boolean; carried: string | null }>({ session: sessionId, loaded, carried: activeId })
  // Adjusted during render: a new session, or the list arriving with a restored shell.
  if (scope.session !== sessionId || scope.loaded !== loaded) setScope({ session: sessionId, loaded, carried: activeId })
  const pick = (id: string) => {
    select(id)
    setScope((s) => ({ ...s, carried: null }))
  }
  const active = terminals.find((t) => t.id === activeId)
  // A remembered or linked terminal attaches only once the list has it.
  const attached = active && (belongs(active) || active.id !== scope.carried) ? active.id : null
  const own = sorted.filter(belongs)
  const folder = cwd ? basename(cwd) || cwd : null
  const hasTabs = sorted.length > 0
  const activeTitle = terminals.find((t) => t.id === activeId)?.title
  const strip = useRef<HTMLUListElement>(null)
  const [fade, setFade] = useState<Fade>(null)
  const measure = useCallback(() => setFade(strip.current ? fadeOf(strip.current) : null), [])
  // The selected tab is always whole on screen, also once renamed longer.
  useEffect(() => {
    strip.current?.querySelector('li:has([aria-selected="true"])')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    measure()
  }, [activeId, activeTitle, sorted.length, measure])
  useEffect(() => {
    const el = strip.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [measure, hasTabs])

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
            ref={strip}
            className="terminal-tabs"
            data-fade={fade ?? undefined}
            onScroll={measure}
            role="tablist"
            onKeyDown={(e) => {
              const step = stepOf(e)
              if (!step) return
              e.preventDefault()
              stepTerminal(step)
            }}
          >
            {sorted.map((t) => (
              <TerminalTab key={t.id} terminal={t} selected={t.id === attached} onPick={pick} />
            ))}
          </ul>
        )}
        <NewTerminalButton sessionId={sessionId} terminals={sorted} onPick={pick} />
      </div>
      <OpenError />
      {loadError && (
        <LoadFailed onRetry={() => void load()}>
          {loaded || terminals.length > 0 ? `Couldn't refresh shells: ${loadError}` : `Couldn't load shells: ${loadError}`}
        </LoadFailed>
      )}
      {!loaded && terminals.length === 0 && !loadError && <LoadingLine>loading shells…</LoadingLine>}
      {/* Nothing attaches unasked (each viewer answers the shell's queries), but the first is one click away. */}
      {loaded && !attached && (
        <p className="terminal-hint">
          {own[0] ? (
            <>
              No shell attached.{' '}
              <button type="button" className="act-link" onClick={() => pick(own[0]!.id)}>
                Attach {own[0].title}
              </button>
            </>
          ) : sessionId && folder && sorted.length > 0 ? (
            <>
              No shell in {folder}.{' '}
              <button type="button" className="act-link" onClick={() => void open({ sessionId })}>
                Open shell in {folder}
              </button>
            </>
          ) : sessionId ? (
            'No shells yet. + opens one in the session folder.'
          ) : (
            'No shells yet. + opens one in your home folder.'
          )}
        </p>
      )}
      {attached && <TerminalScreen id={attached} />}
    </section>
  )
}

type Fade = 'start' | 'end' | 'both' | null

// fadeOf names the edges of the strip with tabs hidden past them.
function fadeOf(el: HTMLElement): Fade {
  const start = el.scrollLeft > 1
  const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
  return start && end ? 'both' : start ? 'start' : end ? 'end' : null
}

// namesFolder is true when the title already says the folder ("repo60 2"
// in repo60), so it isn't repeated beside it.
function namesFolder(t: Terminal): boolean {
  const folder = basename(t.cwd) || t.cwd
  return t.title.toLowerCase().includes(folder.toLowerCase())
}

function TerminalTab({ terminal: t, selected, onPick }: { terminal: Terminal; selected: boolean; onPick: (id: string) => void }) {
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
          aria-label="Terminal name"
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
          onClick={() => onPick(t.id)}
          onDoubleClick={() => setDraft(t.title)}
        >
          <span className="term-dot" data-mark={mark.form} aria-hidden="true" />
          <span className="term-tab-text">
            <TermTitle title={t.title} className="term-tab-title" />
            {!namesFolder(t) && <span className="term-tab-cwd">{folder}</span>}
          </span>
          {t.status === 'exited' && <span className={t.exitCode === 0 ? 'term-exit' : 'term-exit term-bad'}>exited {t.exitCode}</span>}
        </button>
      )}
      {selected && draft === null && (
        <button type="button" className="btn btn-ghost btn-icon term-tab-rename" aria-label={`Rename terminal ${t.title}`} title="Rename" onClick={() => setDraft(t.title)}>
          <Pencil {...icon(14)} />
        </button>
      )}
      <CloseTerminalButton terminal={t} />
    </li>
  )
}

// NewTerminalButton opens a shell in the session folder (or home without a
// session); its menu lists every shell (more than the strip shows) and
// offers home and any other folder.
function NewTerminalButton({ sessionId, terminals, onPick }: { sessionId: string | null; terminals: Terminal[]; onPick: (id: string) => void }) {
  const open = useTerminalStore((s) => s.open)
  const activeId = useTerminalStore((s) => s.activeId)
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
        <Plus {...icon(16)} />
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-icon term-new-more"
        aria-label="More terminals"
        title="All terminals, or open one elsewhere"
        aria-expanded={menu}
        aria-haspopup="true"
        onClick={() => setMenu((m) => !m)}
      >
        <ChevronDown {...icon(14)} />
      </button>
      {menu && (
        <div className="term-new-menu">
          {terminals.length > 0 && (
            <ul className="term-all" role="group" aria-label="All terminals">
              {terminals.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    className="term-all-row"
                    aria-current={t.id === activeId || undefined}
                    title={t.cwd}
                    onClick={() => {
                      onPick(t.id)
                      setMenu(false)
                    }}
                  >
                    <TermTitle title={t.title} className="term-tab-title" />
                    {!namesFolder(t) && <span className="term-tab-cwd">{basename(t.cwd) || t.cwd}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="term-new-in" role="group" aria-label="Open a terminal in">
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
              <FolderField label="Terminal directory" placeholder="another folder" value={cwd} onChange={setCwd} />
              <button type="submit" className="btn btn-xs" disabled={!cwd.trim()} aria-busy={busyFolder || undefined}>
                {busyFolder ? 'Opening…' : 'Open'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
