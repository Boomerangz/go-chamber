import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetStore, useSessionStore } from '../../stores/session'
import type { Session } from '../../lib/api'
import Sidebar from './Sidebar'

vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof import('../../lib/api')>()),
  getAccount: vi.fn(async () => ({ agent: 'codex', loggedIn: true, email: 'dev@example.com' })),
  listHistory: vi.fn(async () => []),
  listFolders: vi.fn(),
}))

const session: Session = { id: 's1', title: 'One', agent: 'claude', cwd: '/src/app', status: 'idle' }

beforeEach(() => {
  localStorage.clear()
  resetStore()
  useSessionStore.setState({ searchMessages: vi.fn(async () => {}), sessionsStatus: 'ready' })
  Element.prototype.scrollIntoView = vi.fn()
})

function setup(onCreate = vi.fn(async () => true), sessions: Session[] = []) {
  useSessionStore.setState({ sessions })
  render(<Sidebar sessions={sessions} onCreate={onCreate} />)
  return onCreate
}

describe('Sidebar new session', () => {
  it('asks for a folder first, pointing at the field', async () => {
    const onCreate = setup()
    await userEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(onCreate).not.toHaveBeenCalled()
    const field = screen.getByLabelText('working directory')
    expect(field).toHaveFocus()
    expect(field).toHaveAttribute('aria-invalid', 'true')
    await userEvent.type(field, '/tmp')
    expect(field).not.toHaveAttribute('aria-invalid')
  })

  it('asks for a branch when starting in a worktree', async () => {
    const onCreate = setup()
    await userEvent.type(screen.getByLabelText('working directory'), '/repo')
    await userEvent.click(screen.getByLabelText('In a new worktree'))
    await userEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(onCreate).not.toHaveBeenCalled()
    expect(screen.getByLabelText('branch name')).toHaveFocus()
    expect(screen.getByLabelText('branch name')).toHaveAttribute('aria-invalid', 'true')
  })

  it('shows the start in progress and blocks a second start', async () => {
    let finish!: (ok: boolean) => void
    const onCreate = setup(vi.fn(() => new Promise<boolean>((r) => (finish = r))), [session])
    await userEvent.type(screen.getByLabelText('working directory'), '/tmp')
    await userEvent.click(screen.getByRole('button', { name: 'New session' }))
    const busy = screen.getByRole('button', { name: 'Starting…' })
    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'New Claude session in /src/app' })).toBeDisabled()
    await userEvent.click(busy)
    expect(onCreate).toHaveBeenCalledTimes(1)
    finish(true)
    expect(await screen.findByRole('button', { name: 'New session' })).not.toHaveAttribute('aria-busy')
  })

  it('clears the branch after a worktree session starts', async () => {
    const onCreate = setup()
    await userEvent.type(screen.getByLabelText('working directory'), '/repo')
    await userEvent.click(screen.getByLabelText('In a new worktree'))
    await userEvent.type(screen.getByLabelText('branch name'), 'fix-it')
    await userEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(onCreate).toHaveBeenCalledWith('claude', '/repo', 'fix-it')
    await waitFor(() => expect(screen.getByLabelText('branch name')).toHaveValue(''))
  })

  it('keeps the branch when the start failed', async () => {
    setup(vi.fn(async () => false))
    await userEvent.type(screen.getByLabelText('working directory'), '/repo')
    await userEvent.click(screen.getByLabelText('In a new worktree'))
    await userEvent.type(screen.getByLabelText('branch name'), 'fix-it')
    await userEvent.click(screen.getByRole('button', { name: 'New session' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'New session' })).not.toHaveAttribute('aria-busy'))
    expect(screen.getByLabelText('branch name')).toHaveValue('fix-it')
  })

  it('remembers the chosen agent', async () => {
    setup()
    await userEvent.click(screen.getByRole('radio', { name: 'Codex' }))
    expect(localStorage.getItem('gc.lastAgent')).toBe('codex')
  })

  it('starts with the remembered agent', () => {
    localStorage.setItem('gc.lastAgent', 'codex')
    setup()
    expect(screen.getByRole('radio', { name: 'Codex' })).toHaveAttribute('aria-checked', 'true')
  })

  it('ignores a remembered value that is not an agent', () => {
    localStorage.setItem('gc.lastAgent', 'gpt')
    setup()
    expect(screen.getByRole('radio', { name: 'Claude' })).toHaveAttribute('aria-checked', 'true')
  })

  it('starts a session in a group with the chosen agent', async () => {
    const onCreate = setup(undefined, [session])
    await userEvent.click(screen.getByRole('radio', { name: 'Codex' }))
    await userEvent.click(screen.getByRole('button', { name: 'New Codex session in /src/app' }))
    expect(onCreate).toHaveBeenCalledWith('codex', '/src/app', undefined)
  })
})

describe('Sidebar footer', () => {
  it('has a sign-out form for phones, where the topbar hides it', async () => {
    setup()
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    const button = screen.getByRole('button', { name: 'Sign out' })
    const form = button.closest('form')!
    expect(form).toHaveAttribute('action', '/logout')
    expect(form).toHaveAttribute('method', 'post')
    expect(form).toHaveClass('sidebar-signout')
  })
})
