import { useState } from 'react'
import { refreshQuota } from '../../lib/api'
import { resetLabel, windowLabel } from '../../lib/format'
import { useSessionStore } from '../../stores/session'

const agentName: Record<string, string> = { claude: 'Claude', codex: 'Codex' }

// QuotaWidget shows subscription rate-limit bars for every known agent.
export default function QuotaWidget() {
  const quotas = useSessionStore((s) => s.quotas)
  const loadQuotas = useSessionStore((s) => s.loadQuotas)
  const [error, setError] = useState<string | null>(null)

  if (quotas.length === 0) return null

  return (
    <div className="quotas" aria-label="Quotas">
      {quotas.map((q) => (
        <section key={q.agent} className="quota">
          <header>
            <span className="quota-agent">
              {agentName[q.agent] ?? q.agent}
              {q.plan && <span className="plan">{q.plan}</span>}
            </span>
            <button
              className="btn btn-ghost btn-icon refresh"
              aria-label={`refresh ${q.agent} quotas`}
              title="Refresh"
              onClick={() =>
                refreshQuota(q.agent)
                  .then(() => loadQuotas())
                  .catch((e) => setError(message(e)))
              }
            >
              ↻
            </button>
          </header>
          {q.windows.map((w) => {
            const pct = Math.min(100, Math.max(0, w.usedPct))
            const level = pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'low'
            const reset = resetLabel(w.resetsAt)
            return (
              <div key={w.name} className="window">
                <div className="window-line">
                  <span>{windowLabel(w)}</span>
                  <span className="pct">{Math.round(w.usedPct)}%</span>
                </div>
                <div className={`bar bar-${level}`}>
                  <div className="fill" style={{ width: `${pct}%` }} />
                </div>
                {reset && <small>{reset}</small>}
              </div>
            )
          })}
        </section>
      ))}
      {error && <span className="error">{error}</span>}
    </div>
  )
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
