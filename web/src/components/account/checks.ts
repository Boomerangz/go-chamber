import { create } from 'zustand'
import type { AgentKind } from '../../lib/api'
import { useSessionStore } from '../../stores/session'

// The accounts that couldn't be checked, and why, so the sidebar footer
// says so once (with the quotas, when they failed too) instead of a red
// line per agent. retry asks every account again.
interface AccountChecks {
  failed: Partial<Record<AgentKind, string>>
  retry: number
  setFailed: (agent: AgentKind, why: string | null) => void
  retryAll: () => void
}

export const useAccountChecks = create<AccountChecks>((set) => ({
  failed: {},
  retry: 0,
  setFailed: (agent, why) =>
    set((s) => {
      if ((s.failed[agent] ?? null) === why) return s
      const failed = { ...s.failed }
      if (why === null) delete failed[agent]
      else failed[agent] = why
      return { failed }
    }),
  retryAll: () => set((s) => ({ failed: {}, retry: s.retry + 1 })),
}))

// followConnection asks every account again when live updates come back
// after a loss: a check that failed while go-chamber was out of reach would
// otherwise wait for a Retry. The quotas reload with the socket itself.
// It returns the unsubscribe.
export function followConnection(): () => void {
  let lost = false
  return useSessionStore.subscribe((s, prev) => {
    if (s.connection === 'offline') lost = true
    if (!lost || s.connection !== 'online' || prev.connection === 'online') return
    lost = false
    useAccountChecks.getState().retryAll()
  })
}
