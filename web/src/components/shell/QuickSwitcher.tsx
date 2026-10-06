import { useEffect, useMemo, useRef, useState } from 'react'
import { SquareTerminal } from 'lucide-react'
import { icon } from '../icon'
import { switcherEntries, type SwitcherEntry } from '../../lib/switcher'
import { useLayoutStore } from '../../stores/layout'
import { useSessionStore } from '../../stores/session'
import { useTerminalStore } from '../../stores/terminals'
import './shell.css'

// QuickSwitcher jumps to any session or terminal by typing part of its name
// or folder: what waits for the owner is listed first.
export default function QuickSwitcher({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const [query, setQuery] = useState('')
  const [at, setAt] = useState(0)
  const sessions = useSessionStore((s) => s.sessions)
  const requests = useSessionStore((s) => s.pendingRequests)
  const terminals = useTerminalStore((s) => s.terminals)
  const entries = useMemo(() => {
    const waiting = new Map<string, number>()
    for (const r of requests) waiting.set(r.sessionId, (waiting.get(r.sessionId) ?? 0) + 1)
    return switcherEntries(sessions, terminals, waiting, query)
  }, [sessions, terminals, requests, query])
  const current = Math.min(at, entries.length - 1)

  useEffect(() => {
    const d = ref.current
    if (d && !d.open) d.showModal()
  }, [])

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [current])

  const open = (entry: SwitcherEntry) => {
    if (entry.kind === 'session') {
      useLayoutStore.getState().setMode('agents')
      void useSessionStore.getState().selectSession(entry.id)
    } else {
      useLayoutStore.getState().setMode('terminal')
      useTerminalStore.getState().select(entry.id)
    }
    onClose()
  }

  return (
    <dialog
      ref={ref}
      className="switcher"
      aria-label="Go to session or terminal"
      onClose={onClose}
      onCancel={onClose}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <input
        className="field switcher-input"
        autoFocus
        role="combobox"
        aria-expanded="true"
        aria-controls="switcher-list"
        aria-activedescendant={entries[current] ? `switch-${entries[current]!.kind}-${entries[current]!.id}` : undefined}
        aria-label="Go to"
        placeholder="Go to a session or terminal…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setAt(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const step = e.key === 'ArrowDown' ? 1 : -1
            setAt((i) => (entries.length ? (Math.max(0, i) + step + entries.length) % entries.length : 0))
          } else if (e.key === 'Enter' && entries[current]) {
            e.preventDefault()
            open(entries[current]!)
          }
        }}
      />
      <ul ref={list} id="switcher-list" className="switcher-list" role="listbox" aria-label="Sessions and terminals">
        {entries.map((entry, i) => (
          <li
            key={`${entry.kind}-${entry.id}`}
            id={`switch-${entry.kind}-${entry.id}`}
            role="option"
            aria-selected={i === current}
            className="switcher-row"
            onMouseMove={() => i !== current && setAt(i)}
            onClick={() => open(entry)}
          >
            {entry.kind === 'terminal' ? (
              <SquareTerminal {...icon(14)} />
            ) : (
              <span className={`switcher-mark status status-${entry.status}`} aria-hidden="true" />
            )}
            <span className="switcher-title">{entry.title}</span>
            <span className="switcher-detail">{entry.detail}</span>
            {entry.waiting > 0 && <span className="badge">{entry.waiting}</span>}
          </li>
        ))}
        {entries.length === 0 && <li className="switcher-empty">Nothing matches “{query}”</li>}
      </ul>
      <footer className="switcher-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
        <span><kbd>↵</kbd> open</span>
        <span><kbd>Esc</kbd> close</span>
      </footer>
    </dialog>
  )
}
