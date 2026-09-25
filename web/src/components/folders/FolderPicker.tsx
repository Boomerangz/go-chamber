import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { listFolders, type FolderListing } from '../../lib/api'
import { crumbs, filterFolders, isPathInput } from '../../lib/folders'
import { basename } from '../../lib/format'

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
  const [hidden, setHidden] = useState(false)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const filter = useRef<HTMLInputElement>(null)

  const go = (path: string, showHidden = hidden) => {
    setLoading(true)
    listFolders(path, showHidden)
      .then((l) => {
        setListing(l)
        setQuery('')
        setError(null)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setLoading(false)
        filter.current?.focus()
      })
  }

  useEffect(() => {
    let alive = true
    listFolders(start)
      .catch(() => listFolders(''))
      .then((l) => alive && setListing(l))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [start])

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
      <div className="picker panel" role="dialog" aria-modal="true" aria-label="Choose a folder">
        <header className="picker-header">
          <h2>Choose a folder</h2>
          <button type="button" className="btn btn-ghost btn-icon" aria-label="Close folder picker" onClick={onClose}>
            ×
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

        <ul className="folder-list" aria-busy={loading}>
          {listing?.parent && !query && (
            <li>
              <button type="button" className="folder-row folder-up" onClick={() => go(listing.parent!)}>
                <span className="folder-icon" aria-hidden="true">
                  ↰
                </span>
                <span className="folder-name">..</span>
              </button>
            </li>
          )}
          {shown.map((f) => (
            <li key={f.path} className="folder-item">
              <button type="button" className="folder-row" onClick={() => go(f.path)}>
                <span className={f.repo ? 'folder-icon folder-icon-repo' : 'folder-icon'} aria-hidden="true" />
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

        {error && <p className="error">{error}</p>}

        <footer className="picker-footer">
          <label className="hidden-toggle">
            <input
              type="checkbox"
              checked={hidden}
              onChange={(e) => {
                setHidden(e.target.checked)
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
