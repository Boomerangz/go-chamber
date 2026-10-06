import { ChevronRight } from 'lucide-react'
import { useRef, useState } from 'react'
import './HistoryPanel.css'
import type { ExternalSession } from '../../lib/api'
import { listHistory } from '../../lib/api'
import { relativeTime } from '../../lib/sessions'
import { describeError } from '../../stores/notices'
import { useSessionStore } from '../../stores/session'
import { icon } from '../icon'
import { LoadFailed, LoadingLine } from '../ui/Loading'

const keyOf = (s: ExternalSession) => `${s.agent}/${s.nativeId}`

// HistoryPanel lists conversations the agents recorded outside go-chamber
// (in a terminal, another client) and opens one as a session that resumes
// with the agent's own history. The list reloads each time the panel opens:
// new conversations appear while go-chamber runs.
export default function HistoryPanel() {
  const importHistory = useSessionStore((s) => s.importHistory)
  const [list, setList] = useState<ExternalSession[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const generation = useRef(0)

  const load = () => {
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
    else setFailed(key)
  }

  const q = filter.trim().toLowerCase()
  const shown = (list ?? []).filter((s) => !q || `${s.title ?? ''} ${s.cwd}`.toLowerCase().includes(q))

  return (
    <details className="history" onToggle={(e) => e.currentTarget.open && load()}>
      <summary className="section-title">
        <ChevronRight {...icon(13)} className="icon chevron" />
        History
      </summary>
      {error && (
        <div className="history-note">
          <LoadFailed onRetry={load}>{`Couldn't load conversations: ${error}`}</LoadFailed>
        </div>
      )}
      {list === null && loading && (
        <div className="history-note">
          <LoadingLine>loading conversations…</LoadingLine>
        </div>
      )}
      {list !== null && list.length === 0 && !error && <p className="history-note">No other conversations to open.</p>}
      {list !== null && list.length > 0 && (
        <>
          <input
            type="search"
            className="field history-filter"
            aria-label="filter history"
            placeholder="Filter by title or folder"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {shown.length === 0 && <p className="history-note">No matching conversations</p>}
          <ul className="sessions" aria-busy={loading || undefined}>
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
                  {failed === key && <p className="error history-error">Couldn't open the conversation</p>}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </details>
  )
}
