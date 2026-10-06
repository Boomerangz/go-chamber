import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { resetStore, useSessionStore } from '../../stores/session'
import type { DeleteOptions, Session } from '../../lib/api'
import { ApiError } from '../../lib/api'
import { useNotices } from '../../stores/notices'
import SessionMenu from './SessionMenu'

vi.mock('../../lib/home', () => ({ useHome: () => '/home/me' }))

const worktree = { repo: '/src/app', path: '/data/wt/app/fix', branch: 'chamber/fix', base: 'abc' }
const base: Session = { id: 's1', title: 'Fix it', agent: 'claude', cwd: worktree.path, status: 'idle', worktree }

let deleteSession: Mock<(id: string, opts?: DeleteOptions) => Promise<boolean>>
let removeWorktree: Mock<(id: string, force: boolean) => Promise<void>>

beforeEach(() => {
  resetStore()
  useNotices.setState({ notices: [] })
  deleteSession = vi.fn(async () => true)
  removeWorktree = vi.fn(async () => {})
  useSessionStore.setState({ deleteSession, removeWorktree })
})

function Row({ session = base }: { session?: Session }) {
  return (
    <ul>
      <li>
        <button>{session.title}</button>
        <SessionMenu session={session} />
      </li>
    </ul>
  )
}

const open = async () => userEvent.click(screen.getByRole('button', { name: 'Actions for Fix it' }))

describe('SessionMenu for a worktree session', () => {
  it('deletes the session alone unless asked to take the folder too', async () => {
    render(<Row />)
    await open()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete…' }))
    const box = screen.getByRole('checkbox', { name: 'Also remove the worktree folder (branch chamber/fix kept)' })
    expect(box).not.toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(deleteSession).toHaveBeenCalledWith('s1')

    await open()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete…' }))
    await userEvent.click(screen.getByRole('checkbox', { name: /Also remove the worktree folder/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(deleteSession).toHaveBeenLastCalledWith('s1', { removeWorktree: true })
  })

  it('offers no folder to remove once the worktree is gone, or for a plain session', async () => {
    const { unmount } = render(<Row session={{ ...base, worktree: { ...worktree, removed: true } }} />)
    await open()
    expect(screen.queryByRole('menuitem', { name: 'Remove worktree…' })).toBeNull()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete…' }))
    expect(screen.queryByRole('checkbox')).toBeNull()
    unmount()
    render(<Row session={{ ...base, worktree: undefined, cwd: '/src/app' }} />)
    await open()
    expect(screen.queryByRole('menuitem', { name: 'Remove worktree…' })).toBeNull()
  })

  it('removes the worktree folder after asking, keeping the branch', async () => {
    render(<Row />)
    await open()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Remove worktree…' }))
    const confirm = screen.getByRole('group', { name: 'Remove the worktree of Fix it?' })
    expect(confirm).toHaveTextContent('Branch chamber/fix is kept')
    expect(screen.getByRole('button', { name: 'Keep' })).toHaveFocus()
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(removeWorktree).toHaveBeenCalledWith('s1', false)
    await waitFor(() => expect(screen.queryByRole('group')).toBeNull())
    expect(useNotices.getState().notices.at(-1)?.text).toBe('Worktree removed, branch chamber/fix kept')
  })

  it('asks again before losing uncommitted changes', async () => {
    removeWorktree.mockRejectedValueOnce(new ApiError(409, 'worktree has uncommitted changes'))
    render(<Row />)
    await open()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Remove worktree…' }))
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(await screen.findByText('It has uncommitted changes: they will be lost.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Remove anyway' }))
    expect(removeWorktree).toHaveBeenLastCalledWith('s1', true)
  })

  it('says why a removal failed, in place', async () => {
    removeWorktree.mockRejectedValueOnce(new Error('boom'))
    render(<Row />)
    await open()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Remove worktree…' }))
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('boom')
  })

  it('offers no worktree removal while a turn runs', async () => {
    render(<Row session={{ ...base, status: 'running' }} />)
    await open()
    const item = screen.getByRole('menuitem', { name: /Remove worktree/ })
    expect(item).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(item)
    expect(screen.queryByRole('group')).toBeNull()
  })
})
