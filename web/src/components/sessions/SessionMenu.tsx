import { Ellipsis } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { interrupt, type Session } from '../../lib/api'
import { usePending } from '../../lib/pending'
import { sessionTitle } from '../../lib/sessions'
import { fail, notify } from '../../stores/notices'
import { useSessionStore } from '../../stores/session'
import { icon } from '../icon'
import './SessionMenu.css'

// Where the menu opens: under its button, or at the pointer for a right click.
interface Anchor {
  x: number
  y: number
  // alignRight lines the menu's right edge up with x (under the button).
  alignRight: boolean
}

type Step = 'menu' | 'rename' | 'delete'

// the sheet keeps this far from the window's edges (a phone's gutter there)
const edge = () => (window.innerWidth <= 720 ? 14 : 8)

// neighbourOf finds where focus goes once a row leaves the list (archived,
// unarchived or deleted): the next row, else the previous one. Rows nested
// in the leaving one leave with it.
function neighbourOf(trigger: React.RefObject<HTMLElement | null>): () => void {
  const item = trigger.current?.parentElement
  const rows = [...document.querySelectorAll<HTMLElement>('button.session')]
  const own = item?.querySelector<HTMLElement>(':scope > button.session')
  const at = own ? rows.indexOf(own) : -1
  const others = (list: HTMLElement[]) => list.filter((r) => !item?.contains(r))
  const next = at < 0 ? [] : [...others(rows.slice(at + 1)), ...others(rows.slice(0, at)).reverse()]
  return () => {
    const target = next.find((r) => r.isConnected) ?? document.querySelector<HTMLElement>('input[aria-label="Search sessions"]')
    target?.focus()
  }
}

// SessionMenu is a session row's "⋯" button and its menu: Rename, Archive
// or Unarchive, and Delete after an in-place question. Right-clicking the
// row (the list item the menu sits in) opens it too. It renders next to
// the row's button, inside the row's list item.
export default function SessionMenu({ session }: { session: Session }) {
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [step, setStep] = useState<Step>('menu')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const title = sessionTitle(session)

  const close = useCallback((refocus = false) => {
    setAnchor(null)
    setStep('menu')
    if (refocus) triggerRef.current?.focus()
  }, [])

  // A right click anywhere on the row opens the menu at the pointer. A
  // subagent row inside handles its own click first and marks it handled.
  useEffect(() => {
    const row = triggerRef.current?.parentElement
    if (!row) return
    const onContext = (e: MouseEvent) => {
      if (e.defaultPrevented) return
      e.preventDefault()
      setStep('menu')
      setAnchor({ x: e.clientX, y: e.clientY, alignRight: false })
    }
    row.addEventListener('contextmenu', onContext)
    return () => row.removeEventListener('contextmenu', onContext)
  }, [])

  const openFromButton = () => {
    if (anchor) {
      close()
      return
    }
    const r = triggerRef.current!.getBoundingClientRect()
    setStep('menu')
    setAnchor({ x: r.right, y: r.bottom + 2, alignRight: true })
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-ghost btn-icon session-menu-trigger"
        aria-label={`Actions for ${title}`}
        title="Actions"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={openFromButton}
      >
        <Ellipsis {...icon(14)} />
      </button>
      {anchor &&
        createPortal(
          <MenuSheet
            session={session}
            title={title}
            anchor={anchor}
            step={step}
            setStep={setStep}
            onClose={close}
            trigger={triggerRef}
          />,
          document.body,
        )}
    </>
  )
}

function MenuSheet(props: {
  session: Session
  title: string
  anchor: Anchor
  step: Step
  setStep: (s: Step) => void
  onClose: (refocus?: boolean) => void
  trigger: React.RefObject<HTMLButtonElement | null>
}) {
  const { session, title, anchor, step, setStep, onClose, trigger } = props
  const sheet = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const archived = Boolean(session.archivedAt)
  const running = session.status === 'running'

  const renameSession = useSessionStore((s) => s.renameSession)
  const archiveSession = useSessionStore((s) => s.archiveSession)
  const unarchiveSession = useSessionStore((s) => s.unarchiveSession)
  const deleteSession = useSessionStore((s) => s.deleteSession)
  const [archive, archiving] = usePending(
    useCallback(async () => {
      const refocus = neighbourOf(trigger)
      const ok = await (archived ? unarchiveSession(session.id) : archiveSession(session.id))
      if (ok) {
        onClose()
        refocus()
        // The row leaves the list: say where it went, and offer it back.
        if (!archived) {
          notify({
            kind: 'info',
            text: `Archived ${title.length > 60 ? `${title.slice(0, 59)}…` : title}`,
            key: `archive-${session.id}`,
            action: { label: 'Undo', run: () => void unarchiveSession(session.id) },
          })
        }
      }
      return ok
    }, [archived, archiveSession, unarchiveSession, onClose, session.id, title, trigger]),
  )
  // Any session's turn stops from here, the archived ones included.
  const [stop, stopping] = usePending(
    useCallback(async () => {
      try {
        await interrupt(session.id)
      } catch (err) {
        fail("Couldn't stop the turn", err)
        return false
      }
      onClose(true)
      return true
    }, [onClose, session.id]),
  )
  // A deleted session's row leaves with its menu: stay busy until then.
  const [remove, deleting] = usePending(
    useCallback(async () => {
      const refocus = neighbourOf(trigger)
      const ok = await deleteSession(session.id)
      if (ok) {
        onClose()
        refocus()
      }
      return ok
    }, [deleteSession, onClose, session.id, trigger]),
    { holdOnSuccess: true },
  )

  // Fit the sheet on screen: flip above or shift left when it would spill.
  useLayoutEffect(() => {
    const el = sheet.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    let left = anchor.alignRight ? anchor.x - width : anchor.x
    let top = anchor.y
    const inset = edge()
    left = Math.max(inset, Math.min(left, window.innerWidth - width - inset))
    if (top + height > window.innerHeight - inset) top = Math.max(inset, anchor.y - height - (anchor.alignRight ? 30 : 0))
    setPos({ left, top })
  }, [anchor, step])

  // The first item takes focus when the menu opens: once it is placed, as a
  // hidden element can't take focus.
  const placed = pos !== null
  useEffect(() => {
    if (placed && step === 'menu') sheet.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [step, placed])

  // A click or a scroll elsewhere closes it; the sheet doesn't follow the list.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (sheet.current?.contains(target) || trigger.current?.contains(target)) return
      onClose()
    }
    // The sheet follows its row while the row stays on screen: a live list
    // update above shifts the row (and scroll anchoring fires a scroll) without
    // the owner doing anything. Once the row scrolls out of view it closes.
    let last = trigger.current?.getBoundingClientRect().top ?? 0
    const onScroll = () => {
      const row = trigger.current?.getBoundingClientRect()
      if (!row) return
      if (row.bottom < 0 || row.top > window.innerHeight) {
        onClose()
        return
      }
      const dy = row.top - last
      last = row.top
      if (dy !== 0) setPos((p) => (p ? { left: p.left, top: p.top + dy } : p))
    }
    const onResize = () => onClose()
    document.addEventListener('pointerdown', onDown)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [onClose, trigger])

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose(true)
      return
    }
    if (e.key === 'Tab') {
      onClose()
      return
    }
    if (step !== 'menu') return
    if (e.key === 'Enter' || e.key === ' ') {
      // Activate here: left to the browser, the same key press can land on
      // the next step's focused button too (Keep, which would close it).
      e.preventDefault()
      ;(document.activeElement as HTMLElement | null)?.click()
      return
    }
    const items = [...(sheet.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[e.key]
    if (next === undefined) return
    e.preventDefault()
    items[(next + items.length) % items.length]?.focus()
  }

  return (
    <div
      ref={sheet}
      className="session-menu"
      role={step === 'menu' ? 'menu' : 'dialog'}
      aria-label={title}
      style={pos ? { left: pos.left, top: pos.top } : { left: anchor.x, top: anchor.y, visibility: 'hidden' }}
      onKeyDown={onMenuKey}
    >
      {step === 'menu' && (
        <>
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => setStep('rename')}>
            Rename
          </button>
          {running && (
            <button type="button" role="menuitem" tabIndex={-1} aria-busy={stopping || undefined} onClick={() => void stop()}>
              {stopping ? 'Stopping…' : 'Stop turn'}
            </button>
          )}
          <button type="button" role="menuitem" tabIndex={-1} aria-busy={archiving || undefined} onClick={() => void archive()}>
            {archiving ? (archived ? 'Unarchiving…' : 'Archiving…') : archived ? 'Unarchive' : 'Archive'}
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="session-menu-danger"
            aria-disabled={running || undefined}
            onClick={() => !running && setStep('delete')}
          >
            Delete…
            {running && <span className="session-menu-hint">stop first</span>}
          </button>
        </>
      )}
      {step === 'rename' && (
        <RenameField
          value={session.title ?? ''}
          onDone={(next) => {
            if (next !== null && next !== (session.title ?? '')) void renameSession(session.id, next)
            onClose(true)
          }}
        />
      )}
      {step === 'delete' && (
        <div className="session-menu-confirm" role="group" aria-label={`Delete ${title}?`}>
          <p>
            Delete from go-chamber? The agent's transcript on disk stays.
          </p>
          <div className="session-menu-actions">
            <button type="button" className="btn btn-danger btn-xs" aria-busy={deleting || undefined} onClick={() => void remove()}>
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
            <button type="button" className="btn btn-xs" autoFocus onClick={() => onClose(true)}>
              Keep
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// RenameField edits the name in the menu: Enter saves, Escape keeps it.
function RenameField({ value, onDone }: { value: string; onDone: (next: string | null) => void }) {
  const [draft, setDraft] = useState(value)
  return (
    <input
      className="field session-menu-input"
      aria-label="Session name"
      value={draft}
      maxLength={200}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onDone(draft.trim())
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onDone(null)
        }
      }}
    />
  )
}
