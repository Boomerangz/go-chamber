import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import UnmergedNote from './UnmergedNote'

vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof import('../../lib/api')>()),
  getUnmerged: vi.fn(),
}))
vi.mock('../../lib/clipboard', () => ({ copyText: vi.fn(async () => true) }))

const fork: api.Session = { id: 'f1', agent: 'claude', cwd: '/src/app', status: 'idle', nativeId: 'n2', forkOf: 'p1' }
const branch: api.Unmerged = { branch: 'chamber/fix', into: 'main', ahead: 2, merge: 'git -C /src/app merge chamber/fix' }

beforeEach(() => vi.clearAllMocks())

describe('UnmergedNote', () => {
  it("names the branch the fork left behind and copies its merge command", async () => {
    vi.mocked(api.getUnmerged).mockResolvedValue(branch)
    render(<UnmergedNote session={fork} />)
    const note = await screen.findByRole('status', { name: 'Unmerged branch' })
    expect(api.getUnmerged).toHaveBeenCalledWith('f1')
    expect(note).toHaveTextContent('Branch chamber/fix has 2 commits not in main')
    expect(note).toHaveTextContent('git -C /src/app merge chamber/fix')
    await userEvent.click(screen.getByRole('button', { name: 'Copy merge command' }))
    expect(copyText).toHaveBeenCalledWith('git -C /src/app merge chamber/fix')
  })

  it('says one commit', async () => {
    vi.mocked(api.getUnmerged).mockResolvedValue({ ...branch, ahead: 1 })
    render(<UnmergedNote session={fork} />)
    expect(await screen.findByRole('status', { name: 'Unmerged branch' })).toHaveTextContent('has 1 commit not in main')
  })

  it('shows nothing once the branch is merged, or when it could not be asked', async () => {
    vi.mocked(api.getUnmerged).mockResolvedValue(null)
    const { rerender } = render(<UnmergedNote session={fork} />)
    await waitFor(() => expect(api.getUnmerged).toHaveBeenCalled())
    expect(screen.queryByRole('status')).toBeNull()
    vi.mocked(api.getUnmerged).mockRejectedValue(new Error('boom'))
    rerender(<UnmergedNote session={{ ...fork, id: 'f2' }} />)
    await waitFor(() => expect(api.getUnmerged).toHaveBeenCalledWith('f2'))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('asks again when a turn ends: the owner may have merged meanwhile', async () => {
    vi.mocked(api.getUnmerged).mockResolvedValue(branch)
    const { rerender } = render(<UnmergedNote session={fork} />)
    await screen.findByRole('status', { name: 'Unmerged branch' })
    vi.mocked(api.getUnmerged).mockResolvedValue(null)
    rerender(<UnmergedNote session={{ ...fork, status: 'running' }} />)
    expect(api.getUnmerged).toHaveBeenCalledTimes(1)
    rerender(<UnmergedNote session={fork} />)
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  })

  it('asks nothing for a session that is not a fork, or works in a worktree', () => {
    render(<UnmergedNote session={{ ...fork, forkOf: undefined }} />)
    render(
      <UnmergedNote
        session={{ ...fork, worktree: { repo: '/src/app', path: '/wt/x', branch: 'chamber/x', base: 'b' } }}
      />,
    )
    expect(api.getUnmerged).not.toHaveBeenCalled()
  })
})
