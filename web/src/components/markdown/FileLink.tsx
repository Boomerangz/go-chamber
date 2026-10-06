import { lazy, Suspense, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Download, WrapText, X } from 'lucide-react'
import CodeView from './CodeView'
import CopyButton from './CopyButton'
import { icon } from '../icon'
import { LoadingLine } from '../ui/Loading'
import { fetchFile, fileKind, fileLine, filePath, fileUrl, langOf, PREVIEW_LIMIT, SessionFiles, type FetchedFile } from '../../lib/files'
import { useLayoutStore } from '../../stores/layout'

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
      {open && <FileViewer sessionId={sessionId} path={path} line={fileLine(href)} onClose={() => setOpen(false)} />}
    </>
  )
}

type Loaded = FetchedFile | { error: string }

const kib = (bytes: number) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`)

// FileViewer shows one file of the session folder in a dialog: images as
// images, markdown rendered, anything else as text unless it is binary.
// label is the path shown when path itself is longer (an absolute one).
export function FileViewer({
  sessionId,
  path,
  label = path,
  line,
  onClose,
}: {
  sessionId: string
  path: string
  label?: string
  line?: number
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const kind = fileKind(path)
  const wrap = useLayoutStore((s) => s.wrap)
  const toggleWrap = useLayoutStore((s) => s.toggleWrap)
  const [loaded, setLoaded] = useState<Loaded>()
  // opener has the focus before the dialog takes it; it gets it back on close.
  const [opener] = useState(() => (typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)))
  useEffect(() => {
    const d = ref.current
    if (d && !d.open) d.showModal?.()
    return () => {
      if (opener && opener !== document.body && opener.isConnected) opener.focus({ preventScroll: true })
    }
  }, [opener])
  useEffect(() => {
    if (kind === 'image') return
    let live = true
    fetchFile(sessionId, path).then(
      (l) => live && setLoaded(l),
      (err: unknown) => live && setLoaded({ error: err instanceof Error ? err.message : "Couldn't load the file" }),
    )
    return () => {
      live = false
    }
  }, [sessionId, path, kind])
  const download = fileUrl(sessionId, path, true)
  const failed = Boolean(loaded && 'error' in loaded)
  const text = kind === 'text' && loaded && 'text' in loaded
  return (
    <dialog
      ref={ref}
      className="file-viewer"
      aria-label={label}
      data-wrap={wrap || undefined}
      onClose={onClose}
      onCancel={onClose}
      // A click on the backdrop lands on the dialog itself.
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <header className="file-viewer-bar">
        <span className="file-viewer-path" title={label}>
          {label}
          {line ? <span className="file-viewer-line">:{line}</span> : null}
        </span>
        <span className="file-viewer-tools">
          <CopyButton text={label} label="Copy path" className="file-viewer-copy" iconOnly />
          {text && (
            <button type="button" className="btn btn-ghost btn-icon" aria-label="Wrap long lines" title="Wrap long lines" aria-pressed={wrap} onClick={toggleWrap}>
              <WrapText {...icon(14)} />
            </button>
          )}
          {!failed && (
            <a className="btn btn-ghost btn-icon" href={download} download aria-label="Download" title="Download">
              <Download {...icon(14)} />
            </a>
          )}
          <button type="button" className="btn btn-ghost btn-icon" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            <X {...icon(16)} />
          </button>
        </span>
      </header>
      <div className="file-viewer-body">
        {kind === 'image' ? (
          <ImageView src={fileUrl(sessionId, path)} alt={label} />
        ) : !loaded ? (
          <LoadingLine>loading file…</LoadingLine>
        ) : 'error' in loaded ? (
          <p className="file-viewer-note file-viewer-error" role="alert">
            {loaded.error}
          </p>
        ) : 'binary' in loaded ? (
          <p className="file-viewer-note">
            This file is binary. <a href={download} download>Download it</a> to open it.
          </p>
        ) : (
          <>
            {loaded.truncated && (
              <p className="file-viewer-note file-viewer-cut">
                Showing the first {kib(PREVIEW_LIMIT)} of {kib(loaded.size)}. <a href={download} download>Download full file</a>
              </p>
            )}
            {kind === 'markdown' ? (
              <Suspense fallback={<pre>{loaded.text}</pre>}>
                <Markdown text={loaded.text} />
              </Suspense>
            ) : (
              <CodeView text={loaded.text} lang={langOf(path)} mark={line} />
            )}
          </>
        )}
      </div>
    </dialog>
  )
}

function ImageView({ src, alt }: { src: string; alt: string }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  if (state === 'error') {
    return (
      <p className="file-viewer-note" role="alert">
        Couldn't load the image
      </p>
    )
  }
  return (
    <>
      {state === 'loading' && <LoadingLine>loading image…</LoadingLine>}
      <img src={src} alt={alt} data-loading={state === 'loading' || undefined} onLoad={() => setState('ready')} onError={() => setState('error')} />
    </>
  )
}
