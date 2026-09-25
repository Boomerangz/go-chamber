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
    <details className="quotas-details">
      <summary aria-label="Quota summary">
        {quotas.map((q) => {
          const top = Math.max(0, ...q.windows.map((w) => Math.min(100, w.usedPct)))
          return (
            <span key={q.agent} className="quota-mini">
              <span>{agentName[q.agent] ?? q.agent}</span>
              <span className={`bar bar-${level(top)}`}>
                <span className="fill" style={{ width: `${top}%` }} />
              </span>
              <span className="pct">{Math.round(top)}%</span>
            </span>
          )
        })}
        <span className="chevron" aria-hidden="true" />
      </summary>
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
              const reset = resetLabel(w.resetsAt)
              return (
                <div key={w.name} className="window">
                  <div className="window-line">
                    <span>{windowLabel(w)}</span>
                    <span className="pct">{Math.round(w.usedPct)}%</span>
                  </div>
                  <div className={`bar bar-${level(pct)}`}>
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
    </details>
  )
}

function level(pct: number): 'low' | 'mid' | 'high' {
  return pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'low'
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
