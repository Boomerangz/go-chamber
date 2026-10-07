import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AccountPanel, { Accounts } from './AccountPanel'
import { lastError, resetNotices } from '../../stores/notices'
import * as api from '../../lib/api'
import { resetStore, useSessionStore } from '../../stores/session'
import { useAccountChecks } from './checks'

vi.mock('../../lib/api', () => ({ getAccount: vi.fn(), startLogin: vi.fn() }))

afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
  resetNotices()
  resetStore()
  useAccountChecks.setState({ failed: {} })
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
  it('says a missing CLI is missing, and how to install it, instead of offering to sign in', async () => {
    vi.mocked(api.getAccount).mockResolvedValue({ agent: 'codex', loggedIn: false, cliMissing: true })
    render(<AccountPanel agent="codex" />)
    expect(await screen.findByText('Codex CLI not found on PATH')).toBeInTheDocument()
    expect(screen.getByText('npm install -g @openai/codex')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in to Codex' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

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
    expect(screen.getByText('checking Codex account…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in to Codex' })).toBeNull()
    await act(async () => resolve({ ...out, loggedIn: true, email: 'dev@example.com' }))
    expect(screen.getByText(/Signed in as dev@example.com/)).toBeInTheDocument()
    expect(screen.queryByText('checking Codex account…')).toBeNull()
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
    expect(screen.getByRole('button', { name: 'Sign in to Codex' })).toHaveFocus()
  })

  it('hands the focus to Copy code when the code replaces the Sign in button', async () => {
    await startSignIn()
    expect(screen.getByRole('button', { name: 'Copy code' })).toHaveFocus()
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

  it('says the check failed, with a retry, instead of offering to sign in', async () => {
    vi.mocked(api.getAccount).mockRejectedValueOnce(new Error('codex stopped'))
    render(<AccountPanel agent="codex" />)
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't check the Codex account: codex stopped")
    expect(screen.queryByRole('button', { name: 'Sign in to Codex' })).toBeNull()
    vi.mocked(api.getAccount).mockResolvedValueOnce({ ...out, loggedIn: true, email: 'dev@example.com' })
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText(/Signed in as dev@example.com/)).toBeInTheDocument()
  })

  it('says when the code could not be copied', async () => {
    const user = userEvent.setup()
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'))
    await startSignIn()
    await user.click(screen.getByRole('button', { name: 'Copy code' }))
    await waitFor(() => expect(lastError()).toBe('denied'))
  })
})

describe('Accounts', () => {
  it('says once, with one Retry, that the accounts and quotas could not be reached', async () => {
    const loadQuotas = vi.fn(async () => {})
    useSessionStore.setState({ quotasStatus: 'error', quotas: [], loadQuotas })
    vi.mocked(api.getAccount).mockRejectedValue(new TypeError('Failed to fetch'))
    render(<Accounts />)
    const line = await screen.findByRole('alert')
    await waitFor(() => expect(line).toHaveTextContent("Couldn't reach the accounts or quotas"))
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1)
    vi.mocked(api.getAccount).mockResolvedValue({ agent: 'claude', loggedIn: true, authMode: 'cli' })
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(loadQuotas).toHaveBeenCalled()
    expect(await screen.findAllByText(/Signed in with the CLI login/)).toHaveLength(2)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('names the one account it could not check', async () => {
    vi.mocked(api.getAccount).mockImplementation(async (agent) => {
      if (agent === 'codex') throw new Error('codex stopped')
      return { agent, loggedIn: true, authMode: 'cli' }
    })
    render(<Accounts />)
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't check the Codex account: codex stopped")
  })


  it('shows one line per agent, each on its own', async () => {
    vi.mocked(api.getAccount).mockImplementation(async (agent) =>
      agent === 'claude' ? { agent, loggedIn: true, authMode: 'cli' } : { ...out, loggedIn: true, email: 'dev@example.com' },
    )
    render(<Accounts />)
    expect(await screen.findByText(/Signed in as dev@example.com/)).toBeInTheDocument()
    expect(await screen.findByText(/Signed in with the CLI login/)).toBeInTheDocument()
    expect(screen.getByText('Claude')).toBeInTheDocument()
    expect(screen.getByText('Codex')).toBeInTheDocument()
  })
})

