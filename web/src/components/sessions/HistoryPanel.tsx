import { ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import './HistoryPanel.css'
import type { ExternalSession } from '../../lib/api'
import { listHistory } from '../../lib/api'
import { failedTo } from '../../lib/failed'
import { relativeTime } from '../../lib/sessions'
import { describeError, lastError } from '../../stores/notices'
import { useSessionStore } from '../../stores/session'
import { icon } from '../icon'
import { LoadFailed, LoadingLine } from '../ui/Loading'
import { revealTop, scrollParent } from '../../lib/reveal'

const keyOf = (s: ExternalSession) => `${s.agent}/${s.nativeId}`

// HistoryPanel lists conversations the agents recorded outside go-chamber
// (in a terminal, another client) and opens one as a session that resumes
// with the agent's own history. The list reloads each time the panel opens:
// new conversations appear while go-chamber runs.
// KEEP is the share of the sidebar's view the sessions keep when History opens.
const KEEP = 0.4

export default function HistoryPanel() {
  const importHistory = useSessionStore((s) => s.importHistory)
  const [list, setList] = useState<ExternalSession[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [reason, setReason] = useState<string | null>(null)
  const generation = useRef(0)
  // Opened at the bottom of the sidebar, the fold shows only its header:
  // once what it loaded is in, the whole of it is brought into view (its
  // top first when it is taller than the sidebar), but the sessions above
  // keep KEEP of the view: what waits there must not scroll out of sight.
  const fold = useRef<HTMLDetailsElement>(null)
  const reveal = useRef(false)
  useEffect(() => {
    if (!reveal.current || loading) return
    reveal.current = false
    const el = fold.current
    if (!el?.open) return
    const box = scrollParent(el)
    if (!box) {
      el.scrollIntoView?.({ block: 'nearest' })
      return
    }
    const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
    box.scrollTop = revealTop(box.scrollTop, box.clientHeight, { top, height: el.offsetHeight }, box.clientHeight * KEEP)
  }, [loading, list, error])

  const load = (show = false) => {
    reveal.current = show
    const mine = ++generation.current
    setError(null)
    setLoading(true)
    listHistory().then(
      (l) => {
        if (mine !== generation.current) return
        setList(l)
        setLoading(false)
      },
      (err: unknown) => {
        if (mine !== generation.current) return
        setError(describeError(err))
        setLoading(false)
      },
    )
  }

  const open = async (s: ExternalSession) => {
    const key = keyOf(s)
    setBusy(key)
    setFailed(null)
    const ok = await importHistory(s.agent, s.nativeId)
    setBusy(null)
    if (ok) setList((prev) => prev?.filter((x) => keyOf(x) !== key) ?? null)
    else {
      setFailed(key)
      setReason(lastError())
    }
  }

  const q = filter.trim().toLowerCase()
  const shown = (list ?? []).filter((s) => !q || `${s.title ?? ''} ${s.cwd}`.toLowerCase().includes(q))

  return (
    <details className="history" ref={fold} onToggle={(e) => e.currentTarget.open && load(true)}>
      <summary className="section-title">
        <ChevronRight {...icon(14)} className="icon chevron" />
        <span>History</span>
        <span className="history-hint">sessions started in the CLI</span>
      </summary>
      {error && (
        <div className="history-note">
          <LoadFailed onRetry={load}>{failedTo('load CLI sessions', error)}</LoadFailed>
        </div>
      )}
      {list === null && loading && (
        <div className="history-note">
          <LoadingLine>loading CLI sessions…</LoadingLine>
        </div>
      )}
      {list !== null && list.length === 0 && !error && <p className="history-note">No other CLI sessions to open.</p>}
      {list !== null && loading && (
        <div className="history-note">
          <LoadingLine>refreshing…</LoadingLine>
        </div>
      )}
      {list !== null && list.length > 0 && (
        <>
          <input
            type="search"
            className="field history-filter"
            aria-label="Filter history"
            placeholder="Filter by title or folder"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {shown.length === 0 && <p className="history-note">No matching CLI sessions</p>}
          {shown.length > 0 && <p className="history-note">Opening one moves it to your sessions, where it resumes.</p>}
          <ul className="sessions history-list" aria-busy={loading || undefined}>
            {shown.map((s) => {
              const key = keyOf(s)
              const title = s.title || s.nativeId
              return (
                <li key={key}>
                  <button
                    className="session"
                    disabled={busy !== null}
                    aria-busy={busy === key || undefined}
                    title={title}
                    onClick={() => void open(s)}
                  >
                    <span className={`avatar avatar-sm avatar-${s.agent}`} aria-hidden="true">
                      {s.agent === 'claude' ? 'C' : 'X'}
                    </span>
                    <span className="session-text">
                      <span className="session-title">{title}</span>
                      <span className="session-meta">
                        <span className="history-cwd" title={s.cwd}>
                          {s.cwd}
                        </span>
                        <span className="session-time">{busy === key ? 'opening…' : relativeTime(s.updatedAt)}</span>
                      </span>
                    </span>
                  </button>
                  {failed === key && <p className="error history-error">{failedTo('open the CLI session', reason)}</p>}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </details>
  )
}
