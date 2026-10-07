import { CornerLeftUp, Folder, FolderGit2, FolderOpen, X } from 'lucide-react'
import { icon } from '../icon'
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { listFolders, type FolderListing } from '../../lib/api'
import { crumbs, filterFolders, isPathInput } from '../../lib/folders'
import { basename } from '../../lib/format'
import { describeError } from '../../stores/notices'
import { touchScreen } from '../../lib/pointer'
import { LoadFailed, LoadingLine } from '../ui/Loading'
import './FolderPicker.css'

const HIDDEN_KEY = 'gc.folders.hidden'

function hiddenRemembered(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === '1'
  } catch {
    return false
  }
}

function rememberHidden(on: boolean) {
  try {
    localStorage.setItem(HIDDEN_KEY, on ? '1' : '0')
  } catch {
    // Storage blocked: the choice lasts for this picker only.
  }
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'

export interface FolderPickerProps {
  // start is the folder shown first; home when empty.
  start?: string
  recent?: string[]
  onPick: (path: string) => void
  onClose: () => void
}

// failedName says which folder couldn't be listed: by name over another
// folder's listing, as "this folder" when its own path is what shows.
function failedName(path: string, listing: FolderListing | null): string {
  if (path === '') return 'your home folder'
  if (!listing) return 'this folder'
  return basename(path)
}

// FolderPicker browses the server's folders. Browsers can't hand out
// absolute paths of local folders, so the listing comes from go-chamber.
export default function FolderPicker({ start = '', recent = [], onPick, onClose }: FolderPickerProps) {
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [hidden, setHidden] = useState(hiddenRemembered)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // target is the folder being listed; failed is the last one that failed.
  const [target, setTarget] = useState<string | null>(null)
  const [failed, setFailed] = useState<{ path: string; hidden: boolean } | null>(null)
  // missing names a start folder that wasn't there, so home is shown.
  const [missing, setMissing] = useState<string | null>(null)
  const filter = useRef<HTMLInputElement>(null)
  // On a touch screen the filter waits to be tapped: focused unasked it
  // opens the keyboard, which leaves the list a row or two.
  const [touch] = useState(touchScreen)
  const sheet = useRef<HTMLDivElement>(null)
  const focusStart = () => (touch ? sheet.current?.focus({ preventScroll: true }) : filter.current?.focus())
  useEffect(() => {
    if (touch) sheet.current?.focus({ preventScroll: true })
  }, [touch])
  const list = useRef<HTMLUListElement>(null)
  // generation makes the last navigation win: a slow listing of a folder
  // left behind must not replace the one asked for after it.
  const generation = useRef(0)

  const go = (path: string, showHidden = hidden) => {
    const mine = ++generation.current
    setLoading(true)
    setTarget(path)
    listFolders(path, showHidden)
      .then((l) => {
        if (mine !== generation.current) return
        setListing(l)
        setQuery('')
        setError(null)
        setFailed(null)
        setMissing(null)
      })
      .catch((e: unknown) => {
        if (mine !== generation.current) return
        setError(describeError(e))
        setFailed({ path, hidden: showHidden })
      })
      .finally(() => {
        if (mine !== generation.current) return
        setLoading(false)
        setTarget(null)
        focusStart()
      })
  }

  useEffect(() => {
    let alive = true
    const mine = ++generation.current
    const current = () => alive && mine === generation.current
    const showHidden = hiddenRemembered()
    listFolders(start, showHidden)
      .catch(() =>
        listFolders('', showHidden).then((l) => {
          if (current() && start) setMissing(start)
          return l
        }),
      )
      .then((l) => current() && setListing(l))
      .catch((e: unknown) => {
        if (!current()) return
        setError(describeError(e))
        setFailed({ path: start, hidden: showHidden })
      })
      .finally(() => current() && setLoading(false))
    return () => {
      alive = false
    }
  }, [start])

  const rows = () => Array.from(list.current?.querySelectorAll<HTMLButtonElement>('.folder-row') ?? [])

  // Arrow keys walk the filter and the folder rows; up from the first row
  // returns to the filter.
  const onListKey = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const all = rows()
    if (all.length === 0) return
    e.preventDefault()
    const at = all.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown') all[Math.min(at + 1, all.length - 1)].focus()
    else if (at <= 0) filter.current?.focus()
    else all[at - 1].focus()
  }

  // Tab stays inside the picker while it is open.
  const trapTab = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return
    const all = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE))
    if (all.length === 0) return
    const first = all[0]
    const last = all[all.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const shown = listing ? filterFolders(listing.folders, query) : []

  return createPortal(
    <div className="picker-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={sheet} tabIndex={-1} className="picker panel" role="dialog" aria-modal="true" aria-label="Choose a folder" onKeyDown={trapTab}>
        <header className="picker-header">
          <h2>Choose a folder</h2>
          <button type="button" className="btn btn-ghost btn-icon" aria-label="Close folder picker" onClick={onClose}>
            <X {...icon(16)} />
          </button>
        </header>

        {/* the path stays on screen when its listing failed: where it failed */}
        {(listing || failed?.path) && (
          <nav className="crumbs" aria-label="Folder path">
            {crumbs(listing?.path ?? failed!.path, listing?.home ?? '').map((c, i, all) => (
              <span key={c.path} className="crumb">
                <button type="button"
                  className={i === all.length - 1 ? 'crumb-current' : undefined}
                  aria-current={i === all.length - 1 ? 'page' : undefined}
                  onClick={() => go(c.path)}
                >
                  {c.label}
                </button>
                {/* the root is a slash already: no second one after it */}
                {i < all.length - 1 && c.label !== '/' && <span aria-hidden="true">/</span>}
              </span>
            ))}
          </nav>
        )}

        <form
          className="picker-filter"
          onSubmit={(e) => {
            // The picker is portaled out of the field's form, but React
            // still bubbles submit through the component tree.
            e.preventDefault()
            e.stopPropagation()
            const q = query.trim()
            if (isPathInput(q)) go(q)
            else if (shown.length === 1) go(shown[0].path)
          }}
        >
          <input
            ref={filter}
            className="field"
            aria-label="Filter folders"
            placeholder="Filter, or type a path and press Enter"
            value={query}
            autoFocus={!touch}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Backspace' && query === '' && listing?.parent) {
                e.preventDefault()
                go(listing.parent)
              } else onListKey(e)
            }}
          />
        </form>

        {recent.length > 0 && !query && (
          <div className="recent" aria-label="Recent folders">
            <span className="section-title">Recent</span>
            {recent.map((p) => (
              <span key={p} className="recent-folder">
                <button type="button" className="chip" title={`Use ${p}`} onClick={() => onPick(p)}>
                  <span className="chip-label">{basename(p)}</span>
                </button>
                <button type="button" className="btn btn-ghost btn-icon recent-open" aria-label={`Browse inside ${p}`} title={`Browse inside ${p}`} onClick={() => go(p)}>
                  <FolderOpen {...icon(14)} />
                </button>
              </span>
            ))}
          </div>
        )}

        <ul ref={list} className="folder-list" aria-busy={loading} onKeyDown={onListKey}>
          {!listing && loading && (
            <li className="folder-loading">
              <LoadingLine>loading…</LoadingLine>
            </li>
          )}
          {listing?.parent && !query && (
            <li>
              <button type="button" className="folder-row folder-up" onClick={() => go(listing.parent!)}>
                <CornerLeftUp {...icon(14)} className="icon folder-icon" />
                <span className="folder-name">..</span>
              </button>
            </li>
          )}
          {shown.map((f) => (
            <li key={f.path} className="folder-item">
              <button
                type="button"
                className="folder-row"
                aria-busy={target === f.path || undefined}
                title={`${f.path} · double-click to select`}
                onClick={() => go(f.path)}
                onDoubleClick={() => onPick(f.path)}
              >
                {f.repo ? (
                  <FolderGit2 {...icon(14)} className="icon folder-icon folder-icon-repo" />
                ) : (
                  <Folder {...icon(14)} className="icon folder-icon" />
                )}
                <span className="folder-name">{f.name}</span>
                {f.repo && <span className="repo-badge">git</span>}
              </button>
              <button type="button" className="btn btn-xs pick" aria-label={`Select ${f.name}`} onClick={() => onPick(f.path)}>
                Select
              </button>
            </li>
          ))}
          {listing && !loading && shown.length === 0 && (
            <li className="folder-empty">{query ? 'No matching folders' : 'No subfolders'}</li>
          )}
        </ul>

        {missing && listing && !error && <p className="picker-note">{`${missing} not found, showing home`}</p>}
        {error && failed && (
          <div className="picker-failed">
            <LoadFailed onRetry={() => go(failed.path, failed.hidden)}>{`Couldn't list ${failedName(failed.path, listing)}: ${error}`}</LoadFailed>
            {!listing && failed.path !== '' && (
              <button type="button" className="btn btn-xs" onClick={() => go('')}>
                Go home
              </button>
            )}
          </div>
        )}

        <footer className="picker-footer">
          <label className="hidden-toggle">
            <input
              type="checkbox"
              checked={hidden}
              onChange={(e) => {
                setHidden(e.target.checked)
                rememberHidden(e.target.checked)
                if (listing) go(listing.path, e.target.checked)
              }}
            />
            Hidden
          </label>
          <span className="picker-path" title={listing?.path}>
            <bdi>{listing?.path ?? ''}</bdi>
          </span>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!listing || loading}
            aria-busy={(listing && loading) || undefined}
            onClick={() => listing && !loading && onPick(listing.path)}
          >
            Use this folder
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
