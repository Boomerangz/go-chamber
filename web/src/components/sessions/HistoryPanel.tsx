import { useState } from 'react'
import './HistoryPanel.css'
import type { ExternalSession } from '../../lib/api'
import { listHistory } from '../../lib/api'
import { relativeTime } from '../../lib/sessions'
import { useSessionStore } from '../../stores/session'

// HistoryPanel lists conversations the agents recorded outside go-chamber
// (in a terminal, another client) and opens one as a session that resumes
// with the agent's own history. The list loads when the panel is opened.
export default function HistoryPanel() {
  const importHistory = useSessionStore((s) => s.importHistory)
  const [list, setList] = useState<ExternalSession[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const load = () => {
    setError(null)
    listHistory().then(setList, (err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }

  const open = async (s: ExternalSession) => {
    const key = `${s.agent}/${s.nativeId}`
    setBusy(key)
    await importHistory(s.agent, s.nativeId)
    setBusy(null)
    setList((prev) => prev?.filter((x) => `${x.agent}/${x.nativeId}` !== key) ?? null)
  }

  const q = filter.trim().toLowerCase()
  const shown = (list ?? []).filter((s) => !q || `${s.title ?? ''} ${s.cwd}`.toLowerCase().includes(q))

  return (
    <details className="history" onToggle={(e) => e.currentTarget.open && list === null && load()}>
      <summary>History</summary>
      {error && <p className="history-note">{error}</p>}
      {list === null && !error && <p className="history-note">Loading…</p>}
      {list !== null && list.length === 0 && <p className="history-note">No other conversations to open.</p>}
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
          <ul className="sessions">
            {shown.map((s) => {
              const key = `${s.agent}/${s.nativeId}`
              return (
                <li key={key}>
                  <button className="session" disabled={busy !== null} onClick={() => void open(s)}>
                    <span className={`avatar avatar-sm avatar-${s.agent}`} aria-hidden="true">
                      {s.agent === 'claude' ? 'C' : 'X'}
                    </span>
                    <span className="session-text">
                      <span className="session-title">{s.title || s.nativeId}</span>
                      <span className="session-meta">
                        <span className="history-cwd">{s.cwd}</span>
                        <span className="session-time">{busy === key ? 'opening…' : relativeTime(s.updatedAt)}</span>
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </details>
  )
}
