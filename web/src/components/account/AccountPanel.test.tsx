import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AccountPanel from './AccountPanel'
import * as api from '../../lib/api'

vi.mock('../../lib/api', () => ({ getAccount: vi.fn(), startLogin: vi.fn() }))

afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe('AccountPanel', () => {
  it('shows the account once the device-code login completes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const out = { agent: 'codex', loggedIn: false } as api.AccountInfo
    vi.mocked(api.getAccount).mockResolvedValue(out)
    vi.mocked(api.startLogin).mockResolvedValue({ userCode: 'ABCD', url: 'https://example.com/device' } as api.LoginChallenge)
    render(<AccountPanel agent="codex" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in to Codex' }))
    expect(await screen.findByText('ABCD')).toBeTruthy()

    vi.mocked(api.getAccount).mockResolvedValue({ ...out, loggedIn: true, email: 'dev@example.com', plan: 'plus' })
    await vi.advanceTimersByTimeAsync(3000)
    expect(await screen.findByText(/Signed in as dev@example.com/)).toBeTruthy()
    expect(screen.queryByText('ABCD')).toBeNull()
  })
})
