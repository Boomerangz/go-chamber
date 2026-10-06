import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { icon } from '../icon'
import QuickSwitcher from './QuickSwitcher'
import { formatCombo, isTypingTarget, matches, nextIndex, type Combo } from '../../lib/hotkeys'
import { useLayoutStore, type Mode } from '../../stores/layout'
import { useSessionStore } from '../../stores/session'
import './shell.css'

interface Shortcut {
  combo: Combo
  label: string
  // anywhere lets the shortcut fire while typing (never inside the terminal).
  anywhere?: boolean
  run: () => void
}

// Shortcuts handled elsewhere, listed in the help so it is complete.
const local: { keys: string; label: string }[] = [
  { keys: formatCombo({ key: 'Enter', mod: true }), label: 'Send the message' },
  { keys: formatCombo({ key: '.', mod: true }), label: 'Stop the running turn' },
  { keys: 'Esc', label: 'In an empty composer: stop the turn, or leave it' },
  { keys: 'A · S · D', label: 'Allow, allow for session, deny a request' },
  { keys: '↑ ↓', label: 'Move through requests in the tray' },
]

function rows(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('.sidebar button.session')]
}

function stepSession(step: 1 | -1) {
  const all = rows()
  const current = all.findIndex((b) => b.getAttribute('aria-current') === 'true')
  const next = all[nextIndex(current, all.length, step)]
  next?.click()
  next?.scrollIntoView?.({ block: 'nearest' })
}

// nextWaiting opens the next session with a request waiting, after the open one.
function nextWaiting() {
  const { pendingRequests, activeId, selectSession } = useSessionStore.getState()
  const ids = [...new Set(pendingRequests.map((r) => r.sessionId))]
  if (ids.length === 0) return
  const next = ids[(ids.indexOf(activeId ?? '') + 1) % ids.length]!
  useLayoutStore.getState().setMode('agents')
  void selectSession(next)
}

function focusIn(selector: string, pane?: 'sessions' | 'chat') {
  useLayoutStore.getState().setMode('agents')
  if (pane) useSessionStore.getState().setPane(pane)
  requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus())
}

type Overlay = 'switcher' | 'help' | null

const modeKeys: [string, Mode][] = [['1', 'agents'], ['2', 'terminal'], ['3', 'diagnostics']]

type SetOverlay = (update: (o: Overlay) => Overlay) => void

function buildShortcuts(setOverlay: SetOverlay): Shortcut[] {
  return [
    { combo: { key: 'k', mod: true }, label: 'Go to a session or terminal', anywhere: true, run: () => setOverlay((o) => (o === 'switcher' ? null : 'switcher')) },
    { combo: { key: '?' }, label: 'Show shortcuts', run: () => setOverlay((o) => (o === 'help' ? null : 'help')) },
    { combo: { key: '/' }, label: 'Search sessions', run: () => focusIn('.session-search input, input[type="search"]', 'sessions') },
    { combo: { key: 'c' }, label: 'Write to the agent', run: () => focusIn('.composer textarea', 'chat') },
    { combo: { key: 'n' }, label: 'New session: choose a folder', run: () => focusIn('.new-session .folder-field input', 'sessions') },
    { combo: { key: 'j' }, label: 'Next session', run: () => stepSession(1) },
    { combo: { key: 'k' }, label: 'Previous session', run: () => stepSession(-1) },
    { combo: { key: 'r' }, label: 'Next session that needs you', run: nextWaiting },
    { combo: { key: 'f' }, label: 'Focus mode on or off', run: () => useLayoutStore.getState().toggleFocus() },
    { combo: { key: 't' }, label: 'Terminal dock on or off', run: () => useLayoutStore.getState().toggleDock('terminal') },
    ...modeKeys.map(([key, mode]) => ({
      combo: { key },
      label: `${mode[0]!.toUpperCase()}${mode.slice(1)}`,
      run: () => useLayoutStore.getState().setMode(mode),
    })),
  ]
}

// Hotkeys owns the app-wide shortcuts, the ⌘K switcher and the ? help.
export default function Hotkeys() {
  const [overlay, setOverlay] = useState<Overlay>(null)
  const shortcuts = useMemo(() => buildShortcuts(setOverlay), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return
      const typing = isTypingTarget(e.target)
      if (document.querySelector('dialog[open]') && !e.metaKey && !e.ctrlKey) return
      for (const s of shortcuts) {
        if (!matches(e, s.combo)) continue
        if (typing && (!s.anywhere || (e.target as HTMLElement).closest('.xterm'))) return
        e.preventDefault()
        s.run()
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shortcuts])

  const close = () => setOverlay(null)
  if (overlay === 'switcher') return <QuickSwitcher onClose={close} />
  if (overlay === 'help') return <ShortcutHelp shortcuts={shortcuts} onClose={close} />
  return null
}

function ShortcutHelp({ shortcuts, onClose }: { shortcuts: Shortcut[]; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (d && !d.open) d.showModal()
  }, [])
  const all = [...shortcuts.map((s) => ({ keys: formatCombo(s.combo), label: s.label })), ...local]
  return (
    <dialog
      ref={ref}
      className="shortcut-help"
      aria-label="Keyboard shortcuts"
      onClose={onClose}
      onCancel={onClose}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <header className="shortcut-head">
        <h2>Keyboard shortcuts</h2>
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Close" title="Close" onClick={onClose} autoFocus>
          <X {...icon(16)} />
        </button>
      </header>
      <dl className="shortcut-list">
        {all.map((s) => (
          <div key={s.keys + s.label}>
            <dt><kbd>{s.keys}</kbd></dt>
            <dd>{s.label}</dd>
          </div>
        ))}
      </dl>
      <p className="shortcut-note">Single keys work when you are not typing.</p>
    </dialog>
  )
}
