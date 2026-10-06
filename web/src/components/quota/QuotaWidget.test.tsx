import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../lib/api'
import { resetStore, useSessionStore } from '../../stores/session'
import QuotaWidget from './QuotaWidget'

vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof import('../../lib/api')>()),
  refreshQuota: vi.fn(),
  getQuotas: vi.fn(),
}))

const snapshot = (updatedAt?: string): api.QuotaSnapshot => ({
  agent: 'codex',
  plan: 'plus',
  updatedAt,
  windows: [{ name: 'primary', usedPct: 25, status: '300m' } as api.QuotaWindow],
})

const realLoadQuotas = useSessionStore.getState().loadQuotas

beforeEach(() => {
  vi.clearAllMocks()
  resetStore()
  useSessionStore.setState({ loadQuotas: realLoadQuotas })
})
afterEach(() => vi.useRealTimers())

describe('QuotaWidget', () => {
  it('says a window whose reset time passed has reset, and marks its percentage as old', () => {
    useSessionStore.setState({
      quotasStatus: 'ready',
      quotas: [{ ...snapshot(), windows: [{ name: 'primary', usedPct: 30, status: '300m', resetsAt: '2020-01-01T00:00:00Z' } as api.QuotaWindow] }],
    })
    render(<QuotaWidget />)
    const pcts = document.querySelectorAll('.pct')
    expect(pcts.length).toBeGreaterThan(0)
    for (const pct of pcts) {
      expect(pct).toHaveAttribute('data-stale')
      expect(pct).toHaveAttribute('title', expect.stringContaining('before the reset'))
    }
    expect(screen.getAllByText(/· reset$|^reset$/).length).toBeGreaterThan(0)
  })

  it('keeps its line while no quotas are known', () => {
    useSessionStore.setState({ quotasStatus: 'ready' })
    render(<QuotaWidget />)
    expect(screen.getByText(/no quotas reported yet/i)).toBeInTheDocument()
  })

  it('says quotas are loading before saying there are none', () => {
    render(<QuotaWidget />)
    expect(screen.getByText('loading quotas…')).toBeInTheDocument()
    expect(screen.queryByText(/no quotas reported yet/i)).toBeNull()
  })

  it('says loading quotas failed, with a retry', async () => {
    const loadQuotas = vi.fn(async () => {})
    useSessionStore.setState({ quotasStatus: 'error', loadQuotas })
    render(<QuotaWidget />)
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(loadQuotas).toHaveBeenCalled()
  })

  it('asks the agents for numbers when none were reported', async () => {
    vi.mocked(api.refreshQuota).mockImplementation(async (agent) => {
      if (agent === 'claude') throw new Error('unsupported')
      return snapshot()
    })
    vi.mocked(api.getQuotas).mockResolvedValue([snapshot()])
    useSessionStore.setState({ quotasStatus: 'ready' })
    render(<QuotaWidget />)
    await userEvent.click(screen.getByRole('button', { name: 'Refresh quotas' }))
    expect(api.refreshQuota).toHaveBeenCalledWith('codex')
    expect((await screen.findAllByText('25%')).length).toBeGreaterThan(0)
  })

  it('says why asking for numbers failed when every agent refused', async () => {
    vi.mocked(api.refreshQuota).mockRejectedValue(new Error('unsupported'))
    useSessionStore.setState({ quotasStatus: 'ready' })
    render(<QuotaWidget />)
    await userEvent.click(screen.getByRole('button', { name: 'Refresh quotas' }))
    expect(await screen.findByText('unsupported')).toBeInTheDocument()
  })

  it('names the fullest window and when it resets in the summary', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'))
    useSessionStore.setState({
      quotas: [{ ...snapshot(), windows: [{ name: 'primary', usedPct: 25, status: '300m', resetsAt: '2026-10-06T13:20:00Z' } as api.QuotaWindow] }],
    })
    render(<QuotaWidget />)
    expect(document.querySelector('summary')).toHaveTextContent('5h · resets in 1h 20m')
  })

  it('lets screen readers read the summary numbers', () => {
    useSessionStore.setState({ quotas: [snapshot()] })
    render(<QuotaWidget />)
    const summary = document.querySelector('summary')!
    expect(summary).not.toHaveAttribute('aria-label')
    expect(summary).toHaveTextContent('25%')
  })

  it('says how old each agent\'s numbers are, and keeps that current', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'))
    useSessionStore.setState({ quotas: [snapshot('2026-10-06T11:56:00Z')] })
    render(<QuotaWidget />)
    expect(screen.getByText('updated 4m ago')).toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(screen.getByText('updated 5m ago')).toBeInTheDocument()
  })

  it('shows a refresh in progress and ignores repeat clicks', async () => {
    let done!: (q: api.QuotaSnapshot) => void
    vi.mocked(api.refreshQuota).mockReturnValue(new Promise((r) => (done = r)))
    vi.mocked(api.getQuotas).mockResolvedValue([snapshot()])
    useSessionStore.setState({ quotas: [snapshot()] })
    render(<QuotaWidget />)
    const button = screen.getByRole('button', { name: 'refresh codex quotas' })
    await userEvent.click(button)
    await userEvent.click(button)
    expect(api.refreshQuota).toHaveBeenCalledTimes(1)
    expect(button).toHaveAttribute('aria-busy', 'true')
    await act(async () => done(snapshot()))
    await waitFor(() => expect(button).not.toHaveAttribute('aria-busy'))
  })

  it('shows a failed refresh and clears it once one succeeds', async () => {
    vi.mocked(api.refreshQuota).mockRejectedValueOnce(new Error('codex is offline'))
    vi.mocked(api.getQuotas).mockResolvedValue([snapshot()])
    useSessionStore.setState({ quotas: [snapshot()] })
    render(<QuotaWidget />)
    const button = screen.getByRole('button', { name: 'refresh codex quotas' })
    await userEvent.click(button)
    expect(await screen.findByText('codex is offline')).toBeInTheDocument()
    vi.mocked(api.refreshQuota).mockResolvedValueOnce(snapshot())
    await userEvent.click(button)
    await waitFor(() => expect(screen.queryByText('codex is offline')).toBeNull())
  })
})
