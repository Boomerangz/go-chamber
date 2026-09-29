import { lazy, Suspense, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { fileKind, filePath, fileUrl, langOf, SessionFiles } from '../../lib/files'

const Markdown = lazy(() => import('./Markdown'))

export function MdLink({ href, children }: { href?: string; children?: ReactNode }) {
  const sessionId = useContext(SessionFiles)
  const path = filePath(href)
  const [open, setOpen] = useState(false)
  if (!sessionId || !path) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    )
  }
  const kind = fileKind(path)
  if (kind === 'download') {
    return (
      <a href={fileUrl(sessionId, path, true)} download className="file-link">
        {children}
      </a>
    )
  }
  return (
    <>
      <a
        href={fileUrl(sessionId, path)}
        className="file-link"
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
          e.preventDefault()
          setOpen(true)
        }}
      >
        {children}
      </a>
      {open && <FileViewer sessionId={sessionId} path={path} onClose={() => setOpen(false)} />}
    </>
  )
}

type Loaded = { text: string } | { error: string }

function FileViewer({ sessionId, path, onClose }: { sessionId: string; path: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const kind = fileKind(path)
  const [loaded, setLoaded] = useState<Loaded>()
  useEffect(() => {
    const d = ref.current
    if (d && !d.open) d.showModal()
  }, [])
  useEffect(() => {
    if (kind === 'image') return
    let live = true
    fetch(fileUrl(sessionId, path), { credentials: 'same-origin' })
      .then(async (r) => (r.ok ? { text: await r.text() } : { error: await problem(r) }))
      .catch(() => ({ error: 'Could not load the file' }))
      .then((l) => live && setLoaded(l))
    return () => {
      live = false
    }
  }, [sessionId, path, kind])
  return (
    <dialog ref={ref} className="file-viewer" aria-label={path} onClose={onClose} onCancel={onClose}>
      <header className="file-viewer-bar">
        <span className="file-viewer-path" title={path}>
          {path}
        </span>
        <a className="btn btn-ghost" href={fileUrl(sessionId, path, true)} download>
          Download
        </a>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="file-viewer-body">
        {kind === 'image' ? (
          <img src={fileUrl(sessionId, path)} alt={path} />
        ) : !loaded ? (
          <p className="file-viewer-note">Loading…</p>
        ) : 'error' in loaded ? (
          <p className="file-viewer-note" role="alert">
            {loaded.error}
          </p>
        ) : (
          <Suspense fallback={<pre>{loaded.text}</pre>}>
            <Markdown text={kind === 'markdown' ? loaded.text : fence(loaded.text, langOf(path))} />
          </Suspense>
        )}
      </div>
    </dialog>
  )
}

function fence(text: string, lang = '') {
  const ticks = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)))
  return `${ticks}${lang}\n${text}\n${ticks}`
}

async function problem(r: Response) {
  if (r.status === 403) return 'This file is outside the session folder'
  if (r.status === 404) return 'File not found'
  return (await r.text()).trim() || `Error ${r.status}`
}
