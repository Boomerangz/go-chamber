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

beforeEach(() => {
  vi.clearAllMocks()
  resetStore()
})
afterEach(() => vi.useRealTimers())

describe('QuotaWidget', () => {
  it('keeps its line while no quotas are known', () => {
    render(<QuotaWidget />)
    expect(screen.getByText(/no quotas reported yet/i)).toBeInTheDocument()
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
