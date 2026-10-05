import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import * as api from '../../lib/api'
import { useSessionStore } from '../../stores/session'
import { icon } from '../icon'
import './DiffPanel.css'

const statusLabel: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', T: 'type changed', '?': 'untracked' }

// DiffPanel shows what the session's folder changed: against the commit a
// worktree branched from, otherwise against HEAD.
export default function DiffPanel({ sessionId }: { sessionId: string | null }) {
  return <SessionDiffPanel key={sessionId} sessionId={sessionId} />
}

function SessionDiffPanel({ sessionId }: { sessionId: string | null }) {
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId))
  const [changes, setChanges] = useState<api.Changes | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  const diffRequest = useRef(0)
  useEffect(() => {
    const requests = diffRequest
    return () => { requests.current++ }
  }, [])
  const status = session?.status
  const [tick, setTick] = useState(0)

  // Reload on open, on Refresh and whenever the session changes status: a
  // finished turn is when files have changed.
  useEffect(() => {
    if (!sessionId) return
    let alive = true
    api.getChanges(sessionId).then(
      (c) => {
        if (!alive) return
        setChanges(c)
        setError(null)
      },
      (err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)),
    )
    return () => {
      alive = false
    }
  }, [sessionId, status, tick])

  const show = async (path: string) => {
    if (!sessionId) return
    const request = ++diffRequest.current
    setOpen(path)
    setDiff(null)
    setError(null)
    try {
      const result = await api.getFileDiff(sessionId, path)
      if (request === diffRequest.current) setDiff(result.diff)
    } catch (err) {
      if (request === diffRequest.current) setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (!sessionId) return <p className="tray-empty">Open a session to see its changes</p>
  return (
    <section className="diff-panel" aria-label="Changes">
      <header className="diff-head">
        <h2 className="section-title">Changes</h2>
        <button type="button" className="btn btn-icon" aria-label="Refresh changes" title="Refresh" onClick={() => setTick((t) => t + 1)}>
          <RefreshCw {...icon(14)} />
        </button>
      </header>
      {session?.worktree && <WorktreeBar session={session} worktree={session.worktree} />}
      {error && (
        <p className="diff-error" role="alert">
          {error}
        </p>
      )}
      {changes && !changes.repository && <p className="tray-empty">This folder is not a git repository.</p>}
      {changes?.repository && changes.files.length === 0 && <p className="tray-empty">No changes</p>}
      {changes?.repository && changes.files.length > 0 && (
        <ul className="diff-files">
          {changes.files.map((f) => (
            <li key={f.path}>
              <button type="button" aria-pressed={open === f.path} onClick={() => void show(f.path)}>
                <span className={`diff-status status-${f.status === '?' ? 'u' : f.status}`} title={statusLabel[f.status] ?? f.status}>
                  {statusLabel[f.status] ?? f.status}
                </span>
                <span className="diff-path">{f.path}</span>
              </button>
              {open === f.path && diff !== null && <DiffView diff={diff} />}
            </li>
          ))}
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

// DiffView renders a unified diff line by line.
export function DiffView({ diff }: { diff: string }) {
  if (!diff) return <p className="diff-none">No textual difference</p>
  return (
    <pre className="diff-view">
      {diff.replace(/\n$/, '').split('\n').map((line, i) => (
        <div key={i} className={lineClass(line)}>
          {line}
        </div>
      ))}
    </pre>
  )
}

function WorktreeBar({ session, worktree }: { session: api.Session; worktree: api.Worktree }) {
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = async (force: boolean) => {
    setBusy(true)
    try {
      await useSessionStore.getState().removeWorktree(session.id, force)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!force && msg.includes('uncommitted')) setDirty(true)
      else setError(msg)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="worktree-bar">
      <p>
        Worktree on branch <code>{worktree.branch}</code>. Merge it with
      </p>
      <code className="merge-hint">{`git -C ${worktree.repo} merge ${worktree.branch}`}</code>
      {dirty ? (
        <p className="worktree-dirty">
          The worktree has uncommitted changes.{' '}
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove(true)}>
            Remove anyway
          </button>
        </p>
      ) : (
        <button type="button" className="btn" disabled={busy} onClick={() => void remove(false)}>
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
