import { useEffect, useMemo, useRef } from 'react'
import { X } from 'lucide-react'
import { icon } from '../icon'
import QuickSwitcher from './QuickSwitcher'
import { replacingHistory } from './routeSync'
import { useOverlay, type Overlay } from './overlay'
import { formatCombo, isMac, isStrayFocus, isTypingTarget, matches, nextIndex, notePointer, type Combo } from '../../lib/hotkeys'
import Keys from '../ui/Keys'
import { terminalShortcuts } from '../../lib/terminal-keys'
import { useLayoutStore, type Mode } from '../../stores/layout'
import { useSessionStore } from '../../stores/session'
import './shell.css'

// The help lists shortcuts in these groups, in this order.
const GROUPS = ['Navigate', 'Chat', 'Requests', 'Terminal'] as const
type Group = (typeof GROUPS)[number]

interface Shortcut {
  combo: Combo
  label: string
  group: Group
  // anywhere lets the shortcut fire while typing (never inside the terminal).
  anywhere?: boolean
  run: () => void
}

// Shortcuts handled elsewhere, listed in the help so it is complete.
const local: { keys: string; label: string; group: Group }[] = [
  { keys: `Enter · ${formatCombo({ key: 'Enter', mod: true })}`, label: 'Send the message', group: 'Chat' },
  { keys: formatCombo({ key: 'Enter', shift: true }), label: 'New line in the message', group: 'Chat' },
  { keys: formatCombo({ key: '.', mod: true }), label: 'Stop the running turn', group: 'Chat' },
  { keys: 'Esc', label: 'In an empty composer: stop the turn, or leave it', group: 'Chat' },
  { keys: 'a · s · d', label: 'Allow, allow for session, deny a request (request focused)', group: 'Requests' },
  { keys: '↑ ↓', label: 'Move through requests in the tray', group: 'Requests' },
  { keys: 'j · k', label: 'In Changes: next, previous file', group: 'Navigate' },
  ...terminalShortcuts(isMac).map((s) => ({ ...s, group: 'Terminal' as const })),
]

function rows(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('.sidebar button.session')]
}

function stepSession(step: 1 | -1) {
  const all = rows()
  const current = all.findIndex((b) => b.getAttribute('aria-current') === 'true')
  const next = all[nextIndex(current, all.length, step)]
  // Stepping is browsing, not navigating: Back still leaves the last session opened on purpose.
  replacingHistory(() => next?.click())
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
  // Focus hides the sidebar: leave it when the target lives there.
  if (pane === 'sessions' && useLayoutStore.getState().focus) useLayoutStore.getState().toggleFocus()
  if (pane) useSessionStore.getState().setPane(pane)
  requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus())
}


const modeKeys: [string, Mode][] = [['1', 'agents'], ['2', 'terminal'], ['3', 'diagnostics']]

type SetOverlay = (update: (o: Overlay) => Overlay) => void

function buildShortcuts(setOverlay: SetOverlay): Shortcut[] {
  return [
    { combo: { key: 'k', mod: true }, group: 'Navigate', label: 'Go to a session or terminal', anywhere: true, run: () => setOverlay((o) => (o === 'switcher' ? null : 'switcher')) },
    { combo: { key: '?' }, group: 'Navigate', label: 'Show shortcuts', run: () => setOverlay((o) => (o === 'help' ? null : 'help')) },
    { combo: { key: '/' }, group: 'Navigate', label: 'Search sessions', run: () => focusIn('.session-search input, input[type="search"]', 'sessions') },
    { combo: { key: 'n' }, group: 'Navigate', label: 'New session: choose a folder', run: () => focusIn('.new-session .folder-field input', 'sessions') },
    { combo: { key: 'j' }, group: 'Navigate', label: 'Next session', run: () => stepSession(1) },
    { combo: { key: 'k' }, group: 'Navigate', label: 'Previous session', run: () => stepSession(-1) },
    { combo: { key: 'r' }, group: 'Requests', label: 'Next session that needs you', run: nextWaiting },
    { combo: { key: 'f' }, group: 'Navigate', label: 'Focus mode on or off', run: () => useLayoutStore.getState().toggleFocus() },
    { combo: { key: 'b', mod: true }, group: 'Navigate', label: 'Sessions list on or off', anywhere: true, run: () => useLayoutStore.getState().toggleSidebar() },
    { combo: { key: 'd' }, group: 'Navigate', label: 'Changes dock on or off', run: () => useLayoutStore.getState().toggleDock('changes') },
    ...modeKeys.map(([key, mode]) => ({
      combo: { key },
      group: 'Navigate' as const,
      label: `${mode[0]!.toUpperCase()}${mode.slice(1)} mode`,
      run: () => useLayoutStore.getState().setMode(mode),
    })),
    { combo: { key: 'c' }, group: 'Chat', label: 'Write to the agent', run: () => focusIn('.composer textarea', 'chat') },
    { combo: { key: 't' }, group: 'Terminal', label: 'Terminal dock on or off', run: () => useLayoutStore.getState().toggleDock('terminal') },
  ]
}

// Hotkeys owns the app-wide shortcuts, the ⌘K switcher and the ? help.
export default function Hotkeys() {
  const overlay = useOverlay((s) => s.overlay)
  const shortcuts = useMemo(
    () => buildShortcuts((update) => useOverlay.setState((s) => ({ overlay: update(s.overlay) }))),
    [],
  )

  useEffect(() => () => useOverlay.setState({ overlay: null }), [])

  // Closing an overlay gives the focus back to what had it before it
  // opened, unless something else (a chat the switcher opened) took it.
  useEffect(() => {
    let opener: HTMLElement | null = null
    return useOverlay.subscribe((now, before) => {
      if (now.overlay && !before.overlay) {
        opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
        return
      }
      if (now.overlay || !before.overlay) return
      const back = opener
      opener = null
      if (!back) return
      requestAnimationFrame(() => {
        const at = document.activeElement
        if ((!at || at === document.body) && back.isConnected) back.focus()
      })
    })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Tab moves focus by the keyboard: whatever it lands on is no stray.
      if (e.key === 'Tab') notePointer(null)
      if (e.defaultPrevented || e.isComposing) return
      const typing = isTypingTarget(e.target)
      if (document.querySelector('dialog[open]') && !e.metaKey && !e.ctrlKey) return
      for (const s of shortcuts) {
        if (!matches(e, s.combo)) continue
        if (typing && (!s.anywhere || (e.target as HTMLElement).closest('.xterm'))) return
        // A word typed at a button a click left focused is not a command.
        if (!s.combo.mod && isStrayFocus(e.target)) return
        e.preventDefault()
        s.run()
        return
      }
    }
    const onPointer = (e: PointerEvent) => notePointer(e.target)
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointer, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointer, true)
    }
  }, [shortcuts])

  const close = () => useOverlay.setState({ overlay: null })
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
  const all = [...shortcuts.map((s) => ({ keys: formatCombo(s.combo), label: s.label, group: s.group })), ...local]
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
      {/* the list scrolls on a short screen; it takes focus so the keys can scroll it */}
      <div className="shortcut-groups" role="group" aria-label="All shortcuts" tabIndex={0}>
        {GROUPS.map((group) => (
          <section key={group} aria-label={group}>
            <h3 className="section-title">{group}</h3>
            <dl className="shortcut-list">
              {all
                .filter((s) => s.group === group)
                .map((s) => (
                  <div key={s.keys + s.label}>
                    <dt><Keys keys={s.keys} /></dt>
                    <dd>{s.label}</dd>
                  </div>
                ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="shortcut-note">Single keys work when you are not typing, and not on a button you just clicked.</p>
    </dialog>
  )
}
