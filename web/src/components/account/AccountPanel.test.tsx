import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AccountPanel from './AccountPanel'
import * as api from '../../lib/api'

vi.mock('../../lib/api', () => ({ getAccount: vi.fn(), startLogin: vi.fn() }))

afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})

const out = { agent: 'codex', loggedIn: false } as api.AccountInfo
const challenge = { loginId: 'l1', userCode: 'ABCD', url: 'https://example.com/device' } as api.LoginChallenge

async function startSignIn() {
  vi.mocked(api.getAccount).mockResolvedValue(out)
  vi.mocked(api.startLogin).mockResolvedValue(challenge)
  render(<AccountPanel agent="codex" />)
  await userEvent.click(await screen.findByRole('button', { name: 'Sign in to Codex' }))
  expect(await screen.findByText('ABCD')).toBeTruthy()
}

describe('AccountPanel', () => {
  it('shows the account once the device-code login completes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await startSignIn()
    vi.mocked(api.getAccount).mockResolvedValue({ ...out, loggedIn: true, email: 'dev@example.com', plan: 'plus' })
    await vi.advanceTimersByTimeAsync(3000)
    expect(await screen.findByText(/Signed in as dev@example.com/)).toBeTruthy()
    expect(screen.queryByText('ABCD')).toBeNull()
  })

  it('checks the account before offering to sign in', async () => {
    let resolve!: (a: api.AccountInfo) => void
    vi.mocked(api.getAccount).mockReturnValue(new Promise((r) => (resolve = r)))
    render(<AccountPanel agent="codex" />)
    expect(screen.getByText('checking account…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in to Codex' })).toBeNull()
    await act(async () => resolve({ ...out, loggedIn: true, email: 'dev@example.com' }))
    expect(screen.getByText(/Signed in as dev@example.com/)).toBeInTheDocument()
    expect(screen.queryByText('checking account…')).toBeNull()
  })

  it('shows the code request in progress', async () => {
    vi.mocked(api.getAccount).mockResolvedValue(out)
    let resolve!: (c: api.LoginChallenge) => void
    vi.mocked(api.startLogin).mockReturnValue(new Promise((r) => (resolve = r)))
    render(<AccountPanel agent="codex" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in to Codex' }))
    const busy = screen.getByRole('button', { name: 'Requesting code…' })
    expect(busy).toHaveAttribute('aria-busy', 'true')
    await userEvent.click(busy)
    expect(api.startLogin).toHaveBeenCalledTimes(1)
    await act(async () => resolve(challenge))
    expect(screen.getByText('ABCD')).toBeInTheDocument()
  })

  it('copies the device code', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')
    await startSignIn()
    await user.click(screen.getByRole('button', { name: 'Copy code' }))
    expect(writeText).toHaveBeenCalledWith('ABCD')
    expect(await screen.findByText('copied')).toBeInTheDocument()
  })

  it('cancels a sign-in', async () => {
    await startSignIn()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('ABCD')).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign in to Codex' })).toBeInTheDocument()
  })

  it('stops waiting when the code expires and offers a new one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await startSignIn()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15 * 60_000)
    })
    expect(screen.getByText(/Code expired/)).toBeInTheDocument()
    expect(screen.queryByText('ABCD')).toBeNull()
    const calls = vi.mocked(api.getAccount).mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(vi.mocked(api.getAccount).mock.calls.length).toBe(calls)
    await userEvent.click(screen.getByRole('button', { name: 'New code' }))
    expect(api.startLogin).toHaveBeenCalledTimes(2)
    expect(await screen.findByText('ABCD')).toBeInTheDocument()
  })

  it('shows polling failures and clears errors on retry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await startSignIn()
    vi.mocked(api.getAccount).mockRejectedValueOnce(new Error('codex stopped'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(screen.getByText('codex stopped')).toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    await waitFor(() => expect(screen.queryByText('codex stopped')).toBeNull())
  })

  it('clears a failed code request when trying again', async () => {
    vi.mocked(api.getAccount).mockResolvedValue(out)
    vi.mocked(api.startLogin).mockRejectedValueOnce(new Error('no network'))
    render(<AccountPanel agent="codex" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in to Codex' }))
    expect(await screen.findByText('no network')).toBeInTheDocument()
    vi.mocked(api.startLogin).mockResolvedValueOnce(challenge)
    await userEvent.click(screen.getByRole('button', { name: 'Sign in to Codex' }))
    expect(await screen.findByText('ABCD')).toBeInTheDocument()
    expect(screen.queryByText('no network')).toBeNull()
  })
})
