import { useState } from 'react'
import { refreshQuota } from '../../lib/api'
import { useSessionStore } from '../../stores/session'

// QuotaWidget shows subscription rate-limit bars for every known agent.
export default function QuotaWidget() {
  const quotas = useSessionStore((s) => s.quotas)
  const loadQuotas = useSessionStore((s) => s.loadQuotas)
  const [error, setError] = useState<string | null>(null)

  if (quotas.length === 0) return null

  return (
    <div className="quotas" aria-label="Quotas">
      {quotas.map((q) => (
        <section key={q.agent}>
          <header>
            <span>
              {q.agent}
              {q.plan ? ` · ${q.plan}` : ''}
            </span>
            <button
              className="refresh"
              aria-label={`refresh ${q.agent} quotas`}
              onClick={() =>
                refreshQuota(q.agent)
                  .then(() => loadQuotas())
                  .catch((e) => setError(message(e)))
              }
            >
              ↻
            </button>
          </header>
          {q.windows.map((w) => (
            <div key={w.name} className="window">
              <label>
                {w.name.replace(/_/g, ' ')} <span>{Math.round(w.usedPct)}%</span>
              </label>
              <div className="bar">
                <div className="fill" style={{ width: `${Math.min(100, Math.max(0, w.usedPct))}%` }} />
              </div>
              {w.resetsAt && <small>resets {new Date(w.resetsAt).toLocaleString()}</small>}
            </div>
          ))}
        </section>
      ))}
      {error && <span className="error">{error}</span>}
    </div>
  )
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
