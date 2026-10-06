import { CornerLeftUp, Folder, FolderGit2, X } from 'lucide-react'
import { icon } from '../icon'
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { listFolders, type FolderListing } from '../../lib/api'
import { crumbs, filterFolders, isPathInput } from '../../lib/folders'
import { basename } from '../../lib/format'
import { describeError } from '../../stores/notices'
import { LoadingLine } from '../ui/Loading'
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

// FolderPicker browses the server's folders. Browsers can't hand out
// absolute paths of local folders, so the listing comes from go-chamber.
export default function FolderPicker({ start = '', recent = [], onPick, onClose }: FolderPickerProps) {
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [hidden, setHidden] = useState(hiddenRemembered)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const filter = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)
  // generation makes the last navigation win: a slow listing of a folder
  // left behind must not replace the one asked for after it.
  const generation = useRef(0)

  const go = (path: string, showHidden = hidden) => {
    const mine = ++generation.current
    setLoading(true)
    listFolders(path, showHidden)
      .then((l) => {
        if (mine !== generation.current) return
        setListing(l)
        setQuery('')
        setError(null)
      })
      .catch((e: unknown) => mine === generation.current && setError(describeError(e)))
      .finally(() => {
        if (mine !== generation.current) return
        setLoading(false)
        filter.current?.focus()
      })
  }

  useEffect(() => {
    let alive = true
    const mine = ++generation.current
    const current = () => alive && mine === generation.current
    const showHidden = hiddenRemembered()
    listFolders(start, showHidden)
      .catch(() => listFolders('', showHidden))
      .then((l) => current() && setListing(l))
      .catch((e: unknown) => current() && setError(describeError(e)))
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
      <div className="picker panel" role="dialog" aria-modal="true" aria-label="Choose a folder" onKeyDown={trapTab}>
        <header className="picker-header">
          <h2>Choose a folder</h2>
          <button type="button" className="btn btn-ghost btn-icon" aria-label="Close folder picker" onClick={onClose}>
            <X {...icon(16)} />
          </button>
        </header>

        {listing && (
          <nav className="crumbs" aria-label="Folder path">
            {crumbs(listing.path, listing.home).map((c, i, all) => (
              <span key={c.path} className="crumb">
                <button type="button"
                  className={i === all.length - 1 ? 'crumb-current' : undefined}
                  aria-current={i === all.length - 1 ? 'page' : undefined}
                  onClick={() => go(c.path)}
                >
                  {c.label}
                </button>
                {i < all.length - 1 && <span aria-hidden="true">/</span>}
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
            aria-label="filter folders"
            placeholder="Filter, or type a path and press Enter"
            value={query}
            autoFocus
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
              <button type="button" key={p} className="chip" title={p} onClick={() => go(p)}>
                {basename(p)}
              </button>
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

        {error && (
          <p className="error picker-error" role="alert">
            {error}
            {!listing && (
              <button type="button" className="btn btn-xs" onClick={() => go('')}>
                Go home
              </button>
            )}
          </p>
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
          <button type="button" className="btn btn-primary" disabled={!listing} onClick={() => listing && onPick(listing.path)}>
            Use this folder
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
