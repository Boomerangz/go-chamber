import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../lib/api'
import { resetStore, useSessionStore } from '../../stores/session'
import QuotaWidget from './QuotaWidget'
import { useAccountChecks } from '../account/checks'

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
  it('replaces usage from before the reset with an unknown value', () => {
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
      expect(pct).toHaveTextContent('—')
    }
    expect(screen.queryByText('30%')).toBeNull()
    expect(document.querySelectorAll('.fill')).toHaveLength(0)
    expect(document.querySelector('summary')).toHaveTextContent('awaiting update')
    // it says when, so it doesn't read like a Reset command
    expect(screen.getByText(/^reset \d+d ago · awaiting update$/)).toBeInTheDocument()
  })

  it('uses a current window in the summary instead of an expired weekly limit', () => {
    useSessionStore.setState({ quotas: [{ agent: 'claude', windows: [
      { name: 'seven_day', usedPct: 99, resetsAt: '2020-01-01T00:00:00Z' },
      { name: 'five_hour', usedPct: 12 },
    ] }] })
    render(<QuotaWidget />)
    expect(document.querySelector('summary')).toHaveTextContent('12%5h')
    expect(document.querySelector('summary')).not.toHaveTextContent('7d')
    expect(screen.queryByText('99%')).toBeNull()
    expect(document.querySelectorAll('.fill')).toHaveLength(2)
  })

  it('expires usage while mounted and shows a fresh weekly report when it arrives', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-10-13T12:00:00Z'))
    useSessionStore.setState({ quotas: [{ agent: 'claude', windows: [
      { name: 'seven_day', usedPct: 99, resetsAt: '2026-10-13T12:00:30Z' },
    ] }] })
    render(<QuotaWidget />)
    expect(document.querySelector('summary')).toHaveTextContent('99%')
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(screen.queryByText('99%')).toBeNull()
    expect(document.querySelector('summary')).toHaveTextContent('awaiting update')
    act(() => useSessionStore.getState().applyIncoming({ seq: 1, sessionId: 's', type: 'quota', quota: {
      agent: 'claude', windows: [{ name: 'seven_day', usedPct: 2, resetsAt: '2026-10-20T12:00:30Z' }],
    } }))
    expect(document.querySelector('summary')).toHaveTextContent('2%')
    expect(screen.queryByText(/awaiting update/)).toBeNull()
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

  it('leaves a failed load to the accounts line when the accounts failed too', () => {
    useSessionStore.setState({ quotasStatus: 'error', quotasError: 'timed out' })
    useAccountChecks.setState({ failed: { claude: 'go-chamber is not reachable' } })
    const { container } = render(<QuotaWidget />)
    expect(container).toBeEmptyDOMElement()
    act(() => useAccountChecks.setState({ failed: {} }))
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load quotas: timed out")
  })

  it('names refresh buttons in sentence case', async () => {
    useSessionStore.setState({ quotasStatus: 'ready', quotas: [snapshot()] })
    render(<QuotaWidget />)
    expect(screen.getByRole('button', { name: 'Refresh Codex quotas', hidden: true })).toBeInTheDocument()
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
    const button = screen.getByRole('button', { name: 'Refresh Codex quotas' })
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
    const button = screen.getByRole('button', { name: 'Refresh Codex quotas' })
    await userEvent.click(button)
    expect(await screen.findByText('codex is offline')).toBeInTheDocument()
    vi.mocked(api.refreshQuota).mockResolvedValueOnce(snapshot())
    await userEvent.click(button)
    await waitFor(() => expect(screen.queryByText('codex is offline')).toBeNull())
  })
})
