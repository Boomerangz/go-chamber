import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, RefreshCw } from 'lucide-react'
import * as api from '../../lib/api'
import { usePending } from '../../lib/pending'
import { describeError, fail, notify } from '../../stores/notices'
import { useSessionStore } from '../../stores/session'
import { icon } from '../icon'
import { LoadFailed, LoadingLine } from '../ui/Loading'
import './DiffPanel.css'

const statusLabel: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', T: 'type changed', '?': 'untracked' }
// The status is the form of the square mark: added solid, changed hollow,
// deleted struck, untracked dashed (not yet part of the repository).
const statusMark: Record<string, string> = { A: 'solid', M: 'hollow', T: 'hollow', D: 'struck', '?': 'dashed' }

// A diff longer than this shows its head until asked for the rest: React
// renders every line as an element.
const DIFF_LINE_LIMIT = 2000

interface Counts {
  added: number
  removed: number
}

// countLines counts the added and removed lines of a unified diff.
function countLines(diff: string): Counts {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    else if (line.startsWith('-') && !line.startsWith('---')) removed++
  }
  return { added, removed }
}

const clock = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

function splitPath(path: string): { base: string; dir: string } {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? { base: path, dir: '' } : { base: path.slice(cut + 1), dir: path.slice(0, cut + 1) }
}

const copy = async (text: string, what: string) => {
  try {
    await navigator.clipboard.writeText(text)
    notify({ kind: 'info', text: `Copied the ${what}`, key: 'copy-merge' })
  } catch (err) {
    fail('Copy failed', err)
  }
}

// DiffPanel shows what the session's folder changed: against the commit a
// worktree branched from, otherwise against HEAD.
export default function DiffPanel({ sessionId }: { sessionId: string | null }) {
  return <SessionDiffPanel key={sessionId} sessionId={sessionId} />
}

function SessionDiffPanel({ sessionId }: { sessionId: string | null }) {
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId))
  const [changes, setChanges] = useState<api.Changes | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  // settled names the last reload that finished; a different key means a
  // reload is on its way.
  const [settled, setSettled] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [diff, setDiff] = useState<{ path: string; text: string } | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [counts, setCounts] = useState<Record<string, Counts>>({})
  const diffRequest = useRef(0)
  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
  }, [open])
  useEffect(() => {
    const requests = diffRequest
    return () => { requests.current++ }
  }, [])
  const status = session?.status
  const [tick, setTick] = useState(0)
  const reloadKey = `${status}:${tick}`
  const loading = settled !== reloadKey

  const fetchDiff = useCallback(async (path: string) => {
    if (!sessionId) return
    const request = ++diffRequest.current
    setDiffLoading(true)
    setDiffError(null)
    // A refetch of the open file keeps showing the old diff until the new
    // one lands; another file starts empty.
    setDiff((d) => (d?.path === path ? d : null))
    try {
      const result = await api.getFileDiff(sessionId, path)
      if (request !== diffRequest.current) return
      setDiff({ path, text: result.diff })
      setCounts((c) => ({ ...c, [path]: countLines(result.diff) }))
    } catch (err) {
      if (request === diffRequest.current) setDiffError(describeError(err))
    } finally {
      if (request === diffRequest.current) setDiffLoading(false)
    }
  }, [sessionId])

  // Reload on open, on Refresh and whenever the session changes status: a
  // finished turn is when files have changed. The open file follows.
  useEffect(() => {
    if (!sessionId) return
    let alive = true
    const key = `${status}:${tick}`
    api.getChanges(sessionId).then(
      (c) => {
        if (!alive) return
        setChanges(c)
        setListError(null)
        setSettled(key)
        setUpdatedAt(new Date())
        const current = openRef.current
        if (!current) return
        if (c.files.some((f) => f.path === current)) void fetchDiff(current)
        else {
          diffRequest.current++
          setOpen(null)
          setDiff(null)
        }
      },
      (err: unknown) => {
        if (!alive) return
        setListError(describeError(err))
        setSettled(key)
      },
    )
    return () => {
      alive = false
    }
  }, [sessionId, status, tick, fetchDiff])

  const toggle = (path: string) => {
    if (open === path) {
      diffRequest.current++
      setOpen(null)
      setDiff(null)
      setDiffError(null)
      setDiffLoading(false)
      return
    }
    setOpen(path)
    void fetchDiff(path)
  }
  const refresh = () => {
    if (!loading) setTick((t) => t + 1)
  }

  if (!sessionId) return <p className="tray-empty">Open a session to see its changes</p>
  return (
    <section className="diff-panel" aria-label="Changes">
      <header className="diff-head">
        <h2 className="section-title">Changes</h2>
        {updatedAt && <span className="diff-updated">updated {clock(updatedAt)}</span>}
        <button
          type="button"
          className="btn btn-icon"
          aria-label="Refresh changes"
          title={loading ? 'Refreshing…' : 'Refresh'}
          aria-busy={loading || undefined}
          onClick={refresh}
        >
          <RefreshCw {...icon(14)} />
        </button>
      </header>
      {session?.worktree && (
        <WorktreeBar session={session} worktree={session.worktree} changed={changes?.files.length ?? 0} />
      )}
      {listError && (
        <LoadFailed onRetry={refresh}>{`Couldn’t load changes: ${listError}`}</LoadFailed>
      )}
      {!changes && loading && !listError && <LoadingLine>loading changes…</LoadingLine>}
      {changes && !changes.repository && <p className="tray-empty">This folder is not a git repository.</p>}
      {changes?.repository && changes.files.length === 0 && <p className="tray-empty">No changes</p>}
      {changes?.repository && changes.files.length > 0 && (
        <ul className="diff-files">
          {changes.files.map((f) => {
            const { base, dir } = splitPath(f.path)
            const label = statusLabel[f.status] ?? f.status
            const count = counts[f.path]
            const isOpen = open === f.path
            return (
              <li key={f.path}>
                <button type="button" aria-expanded={isOpen} title={f.path} onClick={() => toggle(f.path)}>
                  <span className="diff-status" data-mark={statusMark[f.status] ?? 'hollow'}>
                    {label}
                  </span>
                  <span className="diff-path">
                    {dir && <span className="diff-dir">{dir}</span>}
                    <span className="diff-base">{base}</span>
                  </span>
                  {count && (
                    <span className="diff-counts">
                      <span>+{count.added}</span>
                      <span>−{count.removed}</span>
                    </span>
                  )}
                </button>
                {isOpen && diffError && (
                  <p className="diff-error" role="alert">
                    {diffError}
                  </p>
                )}
                {isOpen && !diffError && diff?.path !== f.path && diffLoading && <LoadingLine>loading diff…</LoadingLine>}
                {isOpen && diff?.path === f.path && <DiffView diff={diff.text} />}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function lineClass(line: string): string {
  if (line.startsWith('@@')) return 'diff-hunk'
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) return 'diff-meta'
  if (line.startsWith('+')) return 'diff-add'
  if (line.startsWith('-')) return 'diff-del'
  return 'diff-ctx'
}

// DiffView renders a unified diff line by line, the first DIFF_LINE_LIMIT
// lines until asked for all.
export function DiffView({ diff }: { diff: string }) {
  const [all, setAll] = useState(false)
  if (!diff) return <p className="diff-none">No textual difference</p>
  const lines = diff.replace(/\n$/, '').split('\n')
  const shown = all ? lines : lines.slice(0, DIFF_LINE_LIMIT)
  return (
    <>
      <pre className="diff-view">
        {shown.map((line, i) => (
          <div key={i} className={lineClass(line)}>
            {line}
          </div>
        ))}
      </pre>
      {shown.length < lines.length && (
        <button type="button" className="btn btn-xs diff-more" onClick={() => setAll(true)}>
          show all {lines.length} lines
        </button>
      )}
    </>
  )
}

function WorktreeBar({ session, worktree, changed }: { session: api.Session; worktree: api.Worktree; changed: number }) {
  const [confirming, setConfirming] = useState(false)
  // dirty: the server refused because of uncommitted changes the list
  // didn't show yet.
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [remove, busy] = usePending(
    async (force: boolean) => {
      setError(null)
      try {
        const result: unknown = await useSessionStore.getState().removeWorktree(session.id, force)
        if (result === false) return false
        notify({ kind: 'info', text: 'Worktree removed, branch kept' })
        return true
      } catch (err) {
        const msg = describeError(err)
        if (!force && msg.includes('uncommitted')) setDirty(true)
        else setError(msg)
        return false
      }
    },
    { holdOnSuccess: true },
  )
  const merge = `git -C ${worktree.repo} merge ${worktree.branch}`
  const losing = dirty || changed > 0
  return (
    <div className="worktree-bar">
      <p>
        Worktree on branch <code>{worktree.branch}</code>. Merge it with
      </p>
      <div className="merge-row">
        <code className="merge-hint">{merge}</code>
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Copy merge command" title="Copy merge command" onClick={() => void copy(merge, 'merge command')}>
          <Copy {...icon(14)} />
        </button>
      </div>
      {confirming || dirty ? (
        <div className="worktree-confirm" role="group" aria-label="Remove worktree?">
          <p className={losing ? 'worktree-dirty' : undefined}>
            remove folder {worktree.path}?{losing ? ' its uncommitted changes will be lost;' : ''} branch {worktree.branch} is kept
          </p>
          <div className="worktree-actions">
            <button
              type="button"
              className="btn btn-danger btn-xs"
              aria-busy={busy || undefined}
              onClick={() => void remove(losing)}
            >
              {busy ? 'Removing…' : losing ? 'Remove anyway' : 'Remove'}
            </button>
            <button
              type="button"
              className="btn btn-xs"
              disabled={busy}
              onClick={() => {
                setConfirming(false)
                setDirty(false)
              }}
            >
              Keep
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn btn-danger btn-xs" onClick={() => setConfirming(true)}>
          Remove worktree
        </button>
      )}
      {error && (
        <p className="diff-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
