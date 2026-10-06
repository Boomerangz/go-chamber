import { ChevronDown, RotateCw } from 'lucide-react'
import { icon } from '../icon'
import { useCallback, useState } from 'react'
import { refreshQuota, type AgentKind } from '../../lib/api'
import { resetLabel, windowLabel } from '../../lib/format'
import { useNow } from '../../lib/now'
import { usePending } from '../../lib/pending'
import { relativeTime } from '../../lib/sessions'
import { describeError } from '../../stores/notices'
import { useSessionStore } from '../../stores/session'
import './QuotaWidget.css'

const agentName: Record<string, string> = { claude: 'Claude', codex: 'Codex' }

// QuotaWidget shows subscription rate-limit bars for every known agent.
export default function QuotaWidget() {
  const quotas = useSessionStore((s) => s.quotas)
  const now = useNow(60_000)
  const [error, setError] = useState<string | null>(null)

  // The line stays when nothing is known yet, so the footer doesn't jump
  // once the first numbers arrive.
  if (quotas.length === 0) return <p className="quotas-none">no quotas reported yet</p>

  return (
    <details className="quotas-details">
      <summary>
        {quotas.map((q) => {
          const top = Math.max(0, ...q.windows.map((w) => Math.min(100, w.usedPct)))
          return (
            <span key={q.agent} className="quota-mini">
              <span>{agentName[q.agent] ?? q.agent}</span>
              <span className={`bar bar-${level(top)}`} aria-hidden="true">
                <span className="fill" style={{ transform: `scaleX(${top / 100})` }} />
              </span>
              <span className="pct">{Math.round(top)}%</span>
            </span>
          )
        })}
        <ChevronDown {...icon(13)} className="icon chevron" />
      </summary>
      <div className="quotas" aria-label="Quotas">
        {quotas.map((q) => {
          const age = relativeTime(q.updatedAt, new Date(now))
          return (
            <section key={q.agent} className="quota">
              <header>
                <span className="quota-agent">
                  {agentName[q.agent] ?? q.agent}
                  {q.plan && <span className="plan">{q.plan}</span>}
                </span>
                {age && <span className="quota-age">updated {age}</span>}
                <RefreshButton agent={q.agent} onError={setError} />
              </header>
              {q.windows.map((w) => {
                const pct = Math.min(100, Math.max(0, w.usedPct))
                const reset = resetLabel(w.resetsAt, new Date(now))
                return (
                  <div key={w.name} className="window">
                    <div className="window-line">
                      <span>{windowLabel(w)}</span>
                      <span className="pct">{Math.round(w.usedPct)}%</span>
                    </div>
                    <div className={`bar bar-${level(pct)}`}>
                      <div className="fill" style={{ transform: `scaleX(${pct / 100})` }} />
                    </div>
                    {reset && <small>{reset}</small>}
                  </div>
                )
              })}
            </section>
          )
        })}
        {error && <span className="error" role="alert">{error}</span>}
      </div>
    </details>
  )
}

// RefreshButton asks the agent for fresh numbers; one request at a time.
function RefreshButton({ agent, onError }: { agent: AgentKind; onError: (e: string | null) => void }) {
  const loadQuotas = useSessionStore((s) => s.loadQuotas)
  const refresh = useCallback(async () => {
    try {
      await refreshQuota(agent)
      onError(null)
      await loadQuotas()
    } catch (e) {
      onError(describeError(e))
    }
  }, [agent, loadQuotas, onError])
  const [run, pending] = usePending(refresh)
  return (
    <button
      className="btn btn-ghost btn-icon refresh"
      aria-label={`refresh ${agent} quotas`}
      aria-busy={pending || undefined}
      title={pending ? 'Refreshing…' : 'Refresh'}
      onClick={() => void run()}
    >
      {pending ? <span className="busy-mark" aria-hidden="true" /> : <RotateCw {...icon(13)} />}
    </button>
  )
}

function level(pct: number): 'low' | 'mid' | 'high' {
  return pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'low'
}
