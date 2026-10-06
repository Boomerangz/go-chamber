import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import type { ThemedToken } from 'shiki/core'
import { ChevronsDownUp, ChevronsUpDown, Copy, Eye, RefreshCw, WrapText } from 'lucide-react'
import * as api from '../../lib/api'
import { parseDiff, SIGNS, totals, type DiffStat as Counts, type DiffLine } from '../../lib/diff'
import { langOf } from '../../lib/files'
import { isTypingTarget } from '../../lib/hotkeys'
import { usePending } from '../../lib/pending'
import { useLayoutStore } from '../../stores/layout'
import { describeError, fail, notify } from '../../stores/notices'
import { useSessionStore } from '../../stores/session'
import { icon } from '../icon'
import { FileViewer } from '../markdown/FileLink'
import { LoadFailed, LoadingLine } from '../ui/Loading'
import MidCut from '../ui/MidCut'
import PathText from '../ui/PathText'
import { diffBody } from './diffBody'
import './DiffPanel.css'

const statusLabel: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed', '?': 'untracked' }
// The status is the form of the square mark: added solid, changed hollow,
// deleted struck, untracked dashed (not yet part of the repository).
const statusMark: Record<string, string> = { A: 'solid', C: 'solid', M: 'hollow', R: 'hollow', T: 'hollow', D: 'struck', '?': 'dashed' }

// A diff longer than this shows its head until asked for the rest: React
// renders every line as an element.
const DIFF_LINE_LIMIT = 2000
// While a turn runs the list is checked this often, so the panel follows
// the agent's edits instead of waiting for the turn to end.
export const POLL_MS = 5000

// countLines counts the added and removed lines of a unified diff.
function countLines(diff: string): Counts {
  return totals(parseDiff(diff).map((l) => ({ added: l.kind === 'add' ? 1 : 0, removed: l.kind === 'del' ? 1 : 0 })))
}

const count = (n: number) => n.toLocaleString('en-US')

const clock = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

function splitPath(path: string): { base: string; dir: string } {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? { base: path, dir: '' } : { base: path.slice(cut + 1), dir: path.slice(0, cut + 1) }
}

const copy = async (text: string, what: string, key: string) => {
  try {
    await navigator.clipboard.writeText(text)
    notify({ kind: 'info', text: `Copied the ${what}`, key })
  } catch (err) {
    fail('Copy failed', err)
  }
}

// signature changes when a file's listed change does; a poll refetches an
// open diff only then.
const signature = (f: api.FileChange) => `${f.status}:${f.added ?? ''}:${f.removed ?? ''}`

interface FileDiff {
  loading: boolean
  text?: string
  error?: string
}

// DiffPanel shows what the session's folder changed: against the commit a
// worktree branched from, otherwise against HEAD.
export default function DiffPanel({ sessionId }: { sessionId: string | null }) {
  return <SessionDiffPanel key={sessionId} sessionId={sessionId} />
}

function SessionDiffPanel({ sessionId }: { sessionId: string | null }) {
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId))
  const wrap = useLayoutStore((s) => s.wrap)
  const toggleWrap = useLayoutStore((s) => s.toggleWrap)
  const [changes, setChanges] = useState<api.Changes | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  // settled names the last reload that finished; a different key means a
  // reload is on its way.
  const [settled, setSettled] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  // asked is the reload the owner asked for (Refresh, Retry): only that one
  // says "refreshing…"; a poll or a turn ending reloads quietly.
  const [asked, setAsked] = useState<number | null>(null)
  // open lists the expanded files; diffs holds what each one loaded.
  const [open, setOpen] = useState<string[]>([])
  const [diffs, setDiffs] = useState<Record<string, FileDiff>>({})
  const [counts, setCounts] = useState<Record<string, Counts>>({})
  const [viewing, setViewing] = useState<string | null>(null)
  const requests = useRef<Record<string, number>>({})
  const signatures = useRef<Record<string, string>>({})
  const polled = useRef(false)
  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
  }, [open])
  useEffect(() => {
    const pending = requests
    return () => {
      for (const path of Object.keys(pending.current)) pending.current[path]++
    }
  }, [])
  const status = session?.status
  const [tick, setTick] = useState(0)
  const [poll, setPoll] = useState(0)
  const reloadKey = `${status}:${tick}:${poll}`
  const loading = settled !== reloadKey
  const refreshing = loading && asked === tick

  const fetchDiff = useCallback(async (path: string) => {
    if (!sessionId) return
    const request = (requests.current[path] = (requests.current[path] ?? 0) + 1)
    // A refetch keeps showing the old diff until the new one lands.
    setDiffs((d) => ({ ...d, [path]: { text: d[path]?.text, loading: true } }))
    try {
      const result = await api.getFileDiff(sessionId, path)
      if (request !== requests.current[path]) return
      setDiffs((d) => ({ ...d, [path]: { text: result.diff, loading: false } }))
      setCounts((c) => ({ ...c, [path]: countLines(result.diff) }))
    } catch (err) {
      if (request === requests.current[path]) setDiffs((d) => ({ ...d, [path]: { text: d[path]?.text, loading: false, error: describeError(err) } }))
    }
  }, [sessionId])

  const forget = useCallback((paths: string[]) => {
    if (paths.length === 0) return
    for (const path of paths) requests.current[path] = (requests.current[path] ?? 0) + 1
    setDiffs((d) => {
      const next = { ...d }
      for (const path of paths) delete next[path]
      return next
    })
  }, [])

  // Reload on open, on Refresh, whenever the session changes status (a
  // finished turn is when files have changed) and on each poll while it
  // runs. Open files follow: all of them on a reload, only those whose
  // listed change moved on a poll.
  useEffect(() => {
    if (!sessionId) return
    let alive = true
    const key = `${status}:${tick}:${poll}`
    const quiet = polled.current
    polled.current = false
    api.getChanges(sessionId).then(
      (c) => {
        if (!alive) return
        setChanges(c)
        setListError(null)
        setSettled(key)
        setUpdatedAt(new Date())
        const before = signatures.current
        signatures.current = Object.fromEntries(c.files.map((f) => [f.path, signature(f)]))
        const listed = new Set(c.files.map((f) => f.path))
        const gone = openRef.current.filter((p) => !listed.has(p))
        if (gone.length) {
          setOpen((o) => o.filter((p) => listed.has(p)))
          forget(gone)
        }
        for (const path of openRef.current) {
          if (listed.has(path) && (!quiet || before[path] !== signatures.current[path])) void fetchDiff(path)
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
  }, [sessionId, status, tick, poll, fetchDiff, forget])

  // Poll while a turn runs and the page is in view.
  const running = status === 'running'
  const loadingRef = useRef(loading)
  useEffect(() => {
    loadingRef.current = loading
  }, [loading])
  useEffect(() => {
    if (!sessionId || !running) return
    const timer = setInterval(() => {
      if (loadingRef.current || document.visibilityState === 'hidden') return
      polled.current = true
      setPoll((p) => p + 1)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [sessionId, running])

  const toggle = (path: string) => {
    if (open.includes(path)) {
      setOpen((o) => o.filter((p) => p !== path))
      forget([path])
      return
    }
    setOpen((o) => [...o, path])
    void fetchDiff(path)
  }
  const files = changes?.files ?? []
  const allOpen = files.length > 0 && files.every((f) => open.includes(f.path))
  const expandAll = () => {
    const closed = files.map((f) => f.path).filter((p) => !open.includes(p))
    setOpen((o) => [...o, ...closed])
    for (const path of closed) void fetchDiff(path)
  }
  const collapseAll = () => {
    forget(open)
    setOpen([])
  }
  const refresh = () => {
    if (loading) return
    setAsked(tick + 1)
    setTick((t) => t + 1)
  }

  // j / k move between files while the panel has focus.
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return
    if (e.key !== 'j' && e.key !== 'k') return
    const heads = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('.diff-file-toggle')]
    if (heads.length === 0) return
    const current = heads.findIndex((b) => b.closest('li')?.contains(e.target as Node))
    const next = current < 0 ? (e.key === 'j' ? 0 : heads.length - 1) : Math.min(heads.length - 1, Math.max(0, current + (e.key === 'j' ? 1 : -1)))
    e.preventDefault()
    heads[next]!.focus()
    heads[next]!.scrollIntoView?.({ block: 'nearest' })
  }

  const [head, headHeight] = useHeight<HTMLElement>()
  const total = totals(files)
  const counted = files.every((f) => f.added !== undefined || f.binary)
  const root = changes?.root

  if (!sessionId) return <p className="tray-empty">Open a session to see its changes</p>
  return (
    <section className="diff-panel" aria-label="Changes" onKeyDown={onKey} style={headHeight ? ({ '--diff-head-h': `${headHeight}px` } as CSSProperties) : undefined}>
      <header className="diff-head" ref={head}>
        <h2 className="section-title">Changes</h2>
        {changes?.repository && files.length > 0 && counted && (
          <span className="diff-total" aria-label={`${files.length} ${files.length === 1 ? 'file' : 'files'}, ${total.added} added, ${total.removed} removed lines`}>
            {files.length} {files.length === 1 ? 'file' : 'files'} <span>+{total.added}</span> <span>−{total.removed}</span>
          </span>
        )}
        <span className="diff-updated">{refreshing && changes ? 'refreshing…' : updatedAt ? `updated ${clock(updatedAt)}` : ''}</span>
        <span className="diff-actions">
          <button type="button" className="btn btn-ghost btn-icon" aria-label="Wrap long lines" title="Wrap long lines" aria-pressed={wrap} onClick={toggleWrap}>
            <WrapText {...icon(14)} />
          </button>
          {files.length > 1 && (
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              aria-label={allOpen ? 'Collapse all' : 'Expand all'}
              title={allOpen ? 'Collapse all' : 'Expand all'}
              onClick={allOpen ? collapseAll : expandAll}
            >
              {allOpen ? <ChevronsDownUp {...icon(14)} /> : <ChevronsUpDown {...icon(14)} />}
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label="Refresh changes"
            title={refreshing || !changes ? 'Refreshing…' : 'Refresh'}
            aria-busy={(loading && (refreshing || !changes)) || undefined}
            onClick={refresh}
          >
            <RefreshCw {...icon(14)} />
          </button>
        </span>
      </header>
      {session?.worktree && (
        <WorktreeBar session={session} worktree={session.worktree} changed={files.length} commits={changes?.commits ?? 0} />
      )}
      {listError && (
        <LoadFailed onRetry={refresh}>{`Couldn't load changes: ${listError}`}</LoadFailed>
      )}
      {!changes && loading && !listError && <LoadingLine>loading changes…</LoadingLine>}
      {changes && !changes.repository && <p className="tray-empty">This folder is not a git repository.</p>}
      {changes?.repository && files.length === 0 && <p className="tray-empty">No changes</p>}
      {changes?.repository && files.length > 0 && (
        <ul className="diff-files">
          {files.map((f) => (
            <FileRow
              key={f.path}
              file={f}
              counts={f.added !== undefined || f.binary ? { added: f.added ?? 0, removed: f.removed ?? 0 } : counts[f.path]}
              isOpen={open.includes(f.path)}
              diff={diffs[f.path]}
              wrap={wrap}
              onToggle={() => toggle(f.path)}
              onRetry={() => void fetchDiff(f.path)}
              onView={f.status === 'D' ? undefined : () => setViewing(f.path)}
            />
          ))}
        </ul>
      )}
      {viewing && (
        <FileViewer sessionId={sessionId} path={root ? `${root.replace(/\/$/, '')}/${viewing}` : viewing} label={viewing} onClose={() => setViewing(null)} />
      )}
    </section>
  )
}

function FileRow(props: {
  file: api.FileChange
  counts?: Counts
  isOpen: boolean
  diff?: FileDiff
  wrap: boolean
  onToggle: () => void
  onRetry: () => void
  onView?: () => void
}) {
  const { file: f, counts, isOpen, diff, wrap } = props
  const { base, dir } = splitPath(f.path)
  const from = splitPath(f.from ?? '')
  const label = statusLabel[f.status] ?? f.status
  const busy = Boolean(diff?.loading)
  return (
    <li className="diff-file" aria-busy={busy || undefined}>
      <div className="diff-file-head">
        <button type="button" className="diff-file-toggle" aria-expanded={isOpen} title={f.from ? `${f.from} → ${f.path}` : f.path} onClick={props.onToggle}>
          {/* a narrow panel keeps only the mark; the word stays for screen readers and the tooltip */}
          <span className="diff-status" data-mark={statusMark[f.status] ?? 'hollow'} title={label}>
            <span className="diff-status-word">{label}</span>
          </span>
          <span className="diff-path">
            {/* a rename: the old path shows on the line only beside the whole
                new one; otherwise it drops (the title still names it) */}
            {f.from && (
              <span className="diff-from-part">
                <span className="diff-from">
                  {from.dir && <span className="diff-from-dir">{from.dir}</span>}
                  <MidCut text={from.base} className="diff-from-base" />
                </span>
                <span className="diff-arrow"> → </span>
              </span>
            )}
            <span className="diff-new">
              {dir && <span className="diff-dir">{dir}</span>}
              <MidCut text={base} className="diff-base" />
            </span>
          </span>
          {busy && diff?.text !== undefined && <span className="busy-mark" aria-hidden="true" />}
          {f.binary ? (
            <span className="diff-counts">binary</span>
          ) : (
            counts && (
              <span className="diff-counts">
                <span>+{counts.added}</span>
                <span>−{counts.removed}</span>
              </span>
            )
          )}
        </button>
        <span className="diff-file-actions">
          <button type="button" className="btn btn-ghost btn-icon" aria-label="Copy path" title="Copy path" onClick={() => void copy(f.path, 'path', 'copy-path')}>
            <Copy {...icon(14)} />
          </button>
          {props.onView ? (
            <button type="button" className="btn btn-ghost btn-icon" aria-label="View file" title="View file" onClick={props.onView}>
              <Eye {...icon(14)} />
            </button>
          ) : (
            // A deleted file has nothing to view; the gap keeps the counts in line.
            <span className="diff-action-gap" aria-hidden="true" />
          )}
        </span>
      </div>
      {isOpen && f.binary && <BinaryLine onView={props.onView} />}
      {isOpen && !f.binary && diff?.error && <LoadFailed onRetry={props.onRetry}>{`Couldn't load the diff: ${diff.error}`}</LoadFailed>}
      {isOpen && !f.binary && !diff?.error && diff?.text === undefined && <LoadingLine>loading diff…</LoadingLine>}
      {isOpen && !f.binary && !diff?.error && diff?.text !== undefined && <DiffView diff={diff.text} path={f.path} wrap={wrap} onView={props.onView} />}
    </li>
  )
}

// useHeight follows an element's height, for what sticks under it.
function useHeight<T extends HTMLElement>(): [(el: T | null) => void, number | undefined] {
  const [height, setHeight] = useState<number>()
  const observer = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (!el || typeof ResizeObserver === 'undefined') return
    observer.current = new ResizeObserver(() => setHeight(Math.round(el.getBoundingClientRect().height)))
    observer.current.observe(el)
  }, [])
  return [ref, height]
}

// BinaryLine stands in for a diff git can't print.
function BinaryLine({ onView }: { onView?: () => void }) {
  return (
    <p className="diff-none">
      <span>binary file</span>
      {onView && (
        <>
          {' · '}
          <button type="button" className="act-link diff-view-link" onClick={onView}>
            View
          </button>
        </>
      )}
    </p>
  )
}

// useTokens colours the code of a diff's lines in the file's language once
// its grammar loads; until then (or for an unknown language) lines stay ink.
function useTokens(lines: DiffLine[], lang: string | undefined): (ThemedToken[] | undefined)[] | undefined {
  const code = useMemo(() => lines.filter((l) => l.kind !== 'meta' && l.kind !== 'hunk').map((l) => l.text).join('\n'), [lines])
  const [result, setResult] = useState<{ code: string; tokens: ThemedToken[][] }>()
  useEffect(() => {
    if (!lang || !code) return
    let live = true
    import('../../lib/highlight')
      .then(({ tokenize }) => tokenize(code, lang))
      .then((t) => live && t && setResult({ code, tokens: t }))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [code, lang])
  return useMemo(() => {
    if (result?.code !== code) return undefined
    let i = 0
    return lines.map((l) => (l.kind === 'meta' || l.kind === 'hunk' ? undefined : result.tokens[i++]))
  }, [lines, result, code])
}

// DiffView renders a unified diff with old and new line numbers and a sign
// column, the first DIFF_LINE_LIMIT lines until asked for all.
export function DiffView({ diff, path = '', wrap = false, onView }: { diff: string; path?: string; wrap?: boolean; onView?: () => void }) {
  const [all, setAll] = useState(false)
  const body = useMemo(() => diffBody(parseDiff(diff)), [diff])
  const lines = body.lines
  const shown = useMemo(() => (all ? lines : lines.slice(0, DIFF_LINE_LIMIT)), [all, lines])
  const tokens = useTokens(shown, langOf(path))
  if (body.binary) return <BinaryLine onView={onView} />
  const note = body.note && <p className="diff-note">{body.note}</p>
  if (lines.length === 0) return note || <p className="diff-none">No textual difference</p>
  const widest = shown.reduce((n, l) => Math.max(n, l.old ?? 0, l.new ?? 0), 0)
  const style = { '--ln': `${Math.max(2, String(widest).length)}ch` } as CSSProperties
  return (
    <>
      {note}
      <pre className="diff-view" data-wrap={wrap || undefined} style={style}>
        {shown.map((line, i) => (
          <div key={i} className={`diff-${line.kind === 'meta' ? 'meta' : line.kind === 'hunk' ? 'hunk' : line.kind}`}>
            {line.kind === 'meta' || line.kind === 'hunk' ? (
              <span className="diff-code diff-wide">{line.text}</span>
            ) : (
              <>
                <span className="diff-ln" aria-hidden="true">{line.old ?? ''}</span>
                <span className="diff-ln" aria-hidden="true">{line.new ?? ''}</span>
                <span className="diff-sign">{SIGNS[line.kind]}</span>
                <span className="diff-code">{colour(line.text, tokens?.[i])}</span>
              </>
            )}
          </div>
        ))}
      </pre>
      {shown.length < lines.length && (
        <p className="diff-more">
          <span>{`showing ${count(shown.length)} of ${count(lines.length)} lines`}</span>
          {' · '}
          <button type="button" className="act-link" onClick={() => setAll(true)}>
            show all {count(lines.length)} lines
          </button>
        </p>
      )}
    </>
  )
}

function colour(text: string, tokens: ThemedToken[] | undefined): ReactNode {
  if (!tokens) return text
  return tokens.map((t, j) => (
    <span key={j} style={t.htmlStyle as CSSProperties}>
      {t.content}
    </span>
  ))
}

// lossOf says what removing a worktree loses. The listed changes are
// against the branch's start: with no commits yet every one of them is
// uncommitted; with commits, some may be committed, and those stay.
function lossOf(changed: number, commits: number): string {
  if (changed === 0) return 'It has uncommitted changes: they will be lost.'
  if (commits === 0) return `${changed} uncommitted ${changed === 1 ? 'change' : 'changes'} will be lost.`
  return 'Changes not yet committed will be lost.'
}

function WorktreeBar({ session, worktree, changed, commits }: { session: api.Session; worktree: api.Worktree; changed: number; commits: number }) {
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
      {commits > 0 ? (
        <>
          <p>
            Branch <code>{worktree.branch}</code> · {commits} {commits === 1 ? 'commit' : 'commits'} to merge
          </p>
          <div className="merge-row">
            <code className="merge-hint" title={merge}>{merge}</code>
            <button type="button" className="btn btn-ghost btn-icon" aria-label="Copy merge command" title="Copy merge command" onClick={() => void copy(merge, 'merge command', 'copy-merge')}>
              <Copy {...icon(14)} />
            </button>
          </div>
        </>
      ) : (
        <p>
          Worktree on branch <code>{worktree.branch}</code>, no commits yet: once it has some, they can be merged back.
        </p>
      )}
      {confirming || dirty ? (
        <div className="worktree-confirm" role="group" aria-label="Remove worktree?">
          <p>
            Remove the worktree folder <PathText path={worktree.path} />?
          </p>
          {losing && <p className="worktree-dirty">{lossOf(changed, commits)}</p>}
          <p>
            Branch {worktree.branch} is kept{commits > 0 ? `, with its ${commits} ${commits === 1 ? 'commit' : 'commits'}` : ''}.
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
