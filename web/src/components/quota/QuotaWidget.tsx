import { ChevronDown, RotateCw } from 'lucide-react'
import { icon } from '../icon'
import AgentAvatar from '../AgentAvatar'
import { useCallback, useState } from 'react'
import { refreshQuota, type AgentKind } from '../../lib/api'
import { hasReset, resetLabel, windowLabel } from '../../lib/format'
import { useNow } from '../../lib/now'
import { usePending } from '../../lib/pending'
import { relativeTime } from '../../lib/sessions'
import { describeError } from '../../stores/notices'
import { useSessionStore } from '../../stores/session'
import { LoadFailed, LoadingLine } from '../ui/Loading'
import { useAccountChecks } from '../account/checks'
import './QuotaWidget.css'
import { failedTo } from '../../lib/failed'

const agentName: Record<string, string> = { claude: 'Claude', codex: 'Codex' }

// QuotaWidget shows subscription rate-limit bars for every known agent.
export default function QuotaWidget() {
  const quotas = useSessionStore((s) => s.quotas)
  const status = useSessionStore((s) => s.quotasStatus)
  const loadError = useSessionStore((s) => s.quotasError)
  const loadQuotas = useSessionStore((s) => s.loadQuotas)
  const now = useNow(60_000)
  const [error, setError] = useState<string | null>(null)
  // With an account check failed too, the accounts line says both.
  const accountsDown = useAccountChecks((s) => Object.keys(s.failed).length > 0)

  // The line stays when nothing is known yet, so the footer doesn't jump
  // once the first numbers arrive.
  if (quotas.length === 0) {
    if (status === 'loading') return <LoadingLine>loading quotas…</LoadingLine>
    if (status === 'error') return accountsDown ? null : <LoadFailed onRetry={() => void loadQuotas()}>{failedTo('load quotas', loadError)}</LoadFailed>
    return (
      <div className="quotas-none">
        <span>no quotas reported yet</span>
        <RefreshButton agents={['claude', 'codex']} label="Refresh quotas" onError={setError} />
        {error && <span className="error" role="alert">{error}</span>}
      </div>
    )
  }

  return (
    <details className="quotas-details">
      <summary>
        {quotas.map((q) => {
          // The fullest window is the one that limits: name it and its reset.
          const fullest = q.windows.reduce<(typeof q.windows)[number] | undefined>((a, w) => (!a || w.usedPct > a.usedPct ? w : a), undefined)
          const top = Math.max(0, Math.min(100, fullest?.usedPct ?? 0))
          const reset = fullest ? resetLabel(fullest.resetsAt, new Date(now)) : null
          return (
            <span key={q.agent} className="quota-mini">
              {/* the agent by its letter box, as everywhere it is named in a
                  row; the name stays for screen readers */}
              <AgentAvatar agent={q.agent} />
              <span className="sr-only">{agentName[q.agent] ?? q.agent}</span>
              <span className={`bar bar-${level(top)}`} aria-hidden="true">
                <span className="fill" style={{ transform: `scaleX(${top / 100})` }} />
              </span>
              <Pct value={top} stale={fullest !== undefined && hasReset(fullest.resetsAt, new Date(now))} />
              {fullest && (
                <span className="quota-when">
                  {windowLabel(fullest).replace(/ window$/, '')}
                  {reset && ` · ${reset}`}
                </span>
              )}
            </span>
          )
        })}
        <ChevronDown {...icon(14)} className="icon chevron" />
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
                <RefreshButton agents={[q.agent]} label={`Refresh ${agentName[q.agent] ?? q.agent} quotas`} onError={setError} />
              </header>
              {q.windows.map((w) => {
                const pct = Math.min(100, Math.max(0, w.usedPct))
                const reset = resetLabel(w.resetsAt, new Date(now))
                return (
                  <div key={w.name} className="window">
                    <div className="window-line">
                      <span>{windowLabel(w)}</span>
                      <Pct value={w.usedPct} stale={hasReset(w.resetsAt, new Date(now))} />
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

// Pct prints a window's usage; after its reset the number is old, so it is
// shown in the unsettled form until fresh numbers arrive.
function Pct({ value, stale }: { value: number; stale: boolean }) {
  return (
    <span className="pct" data-stale={stale || undefined} title={stale ? 'Usage from before the reset; refresh for new numbers' : undefined}>
      {Math.round(value)}%
    </span>
  )
}

// RefreshButton asks agents for fresh numbers; one request at a time. It
// fails only when every agent it asked refused.
function RefreshButton({ agents, label, onError }: { agents: AgentKind[]; label: string; onError: (e: string | null) => void }) {
  const loadQuotas = useSessionStore((s) => s.loadQuotas)
  const refresh = useCallback(async () => {
    const results = await Promise.allSettled(agents.map((a) => refreshQuota(a)))
    const refused = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (refused && results.every((r) => r.status === 'rejected')) {
      onError(describeError(refused.reason))
      return
    }
    onError(null)
    await loadQuotas()
  }, [agents, loadQuotas, onError])
  const [run, pending] = usePending(refresh)
  return (
    <button
      className="btn btn-ghost btn-icon refresh"
      aria-label={label}
      aria-busy={pending || undefined}
      title={pending ? 'Refreshing…' : 'Refresh'}
      onClick={() => void run()}
    >
      {pending ? <span className="busy-mark" aria-hidden="true" /> : <RotateCw {...icon(14)} />}
    </button>
  )
}

function level(pct: number): 'low' | 'mid' | 'high' {
  return pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'low'
}
