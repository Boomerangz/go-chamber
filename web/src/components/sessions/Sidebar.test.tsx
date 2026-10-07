import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fail } from '../../stores/notices'
import { resetStore, useSessionStore } from '../../stores/session'
import type { Session } from '../../lib/api'
import Sidebar, { type SidebarProps } from './Sidebar'
import { resetCLIs } from '../../lib/clis'
import * as api from '../../lib/api'

vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof import('../../lib/api')>()),
  getAccount: vi.fn(async () => ({ agent: 'codex', loggedIn: true, email: 'dev@example.com' })),
  listHistory: vi.fn(async () => []),
  listFolders: vi.fn(),
  listAgents: vi.fn(async () => [
    { agent: 'claude', found: true, path: '/bin/claude' },
    { agent: 'codex', found: true, path: '/bin/codex' },
  ]),
}))

const session: Session = { id: 's1', title: 'One', agent: 'claude', cwd: '/src/app', status: 'idle' }

beforeEach(() => {
  localStorage.clear()
  resetStore()
  resetCLIs()
  useSessionStore.setState({ searchMessages: vi.fn(async () => {}), sessionsStatus: 'ready' })
  Element.prototype.scrollIntoView = vi.fn()
})

function setup(onCreate: SidebarProps['onCreate'] = vi.fn(async () => true), sessions: Session[] = []) {
  useSessionStore.setState({ sessions })
  render(<Sidebar sessions={sessions} onCreate={onCreate} />)
  return onCreate
}

describe('Sidebar new session', () => {
  it('offers only agents whose CLI is installed, and says why not', async () => {
    localStorage.setItem('gc.lastAgent', 'codex')
    vi.mocked(api.listAgents).mockResolvedValueOnce([
      { agent: 'claude', found: true, path: '/bin/claude' },
      { agent: 'codex', found: false, hint: 'npm install -g @openai/codex' },
    ])
    const onCreate = setup()
    const codex = screen.getByRole('radio', { name: /Codex/ })
    await waitFor(() => expect(codex).toBeDisabled())
    expect(codex).toHaveAttribute('title', 'Codex CLI not found on PATH. Install it with npm install -g @openai/codex')
    expect(screen.getByRole('radio', { name: /Claude/ })).toHaveAttribute('aria-checked', 'true')
    await userEvent.type(screen.getByLabelText('Working directory'), '/tmp')
    await userEvent.click(screen.getByRole('button', { name: 'New session' }))
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('claude', '/tmp', undefined))
  })

  it('folds the form behind one line on phones, and folds it again once a session starts', async () => {
    const onCreate = setup()
    const form = document.querySelector('form.new-session')!
    const open = screen.getByRole('button', { name: 'Start a session' })
    expect(open).toHaveAttribute('aria-expanded', 'false')
    expect(form).toHaveAttribute('data-folded')
    await userEvent.click(open)
    expect(open).toHaveAttribute('aria-expanded', 'true')
    expect(form).not.toHaveAttribute('data-folded')
    await userEvent.type(screen.getByLabelText('Working directory'), '/tmp')
    await userEvent.click(screen.getByRole('button', { name: 'New session' }))
    await waitFor(() => expect(onCreate).toHaveBeenCalled())
    await waitFor(() => expect(form).toHaveAttribute('data-folded'))
  })

  it('unfolds by itself when the folder field takes focus', async () => {
    setup()
    await userEvent.click(screen.getByLabelText('Working directory'))
    expect(document.querySelector('form.new-session')).not.toHaveAttribute('data-folded')
  })

  it('asks for a folder first, pointing at the field', async () => {
    const onCreate = setup()
    await userEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(onCreate).not.toHaveBeenCalled()
    const field = screen.getByLabelText('Working directory')
    expect(field).toHaveFocus()
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveAccessibleDescription('Choose a folder first')
    await userEvent.type(field, '/tmp')
    expect(field).not.toHaveAttribute('aria-invalid')
  })

  it('asks for a branch when starting in a worktree', async () => {
    const onCreate = setup()
    await userEvent.type(screen.getByLabelText('Working directory'), '/repo')
    await userEvent.click(screen.getByLabelText('In a new worktree'))
    await userEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(onCreate).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Branch name')).toHaveFocus()
    expect(screen.getByLabelText('Branch name')).toHaveAttribute('placeholder', 'Branch name')
    expect(screen.getByLabelText('Branch name')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('Name the branch')
    expect(screen.getByLabelText('Branch name')).toHaveAccessibleDescription('Name the branch')
    await userEvent.type(screen.getByLabelText('Branch name'), 'fix')
    expect(screen.queryByText('Name the branch')).toBeNull()
  })

  it('offers a worktree only in a git repository, saying why not', async () => {
    vi.mocked(api.listFolders).mockResolvedValue({ path: '/w', home: '/h', folders: [{ name: 'notes', path: '/w/notes' }, { name: 'app', path: '/w/app', repo: true }] })
    setup()
    const field = screen.getByLabelText('Working directory')
    await userEvent.type(field, '/w/notes')
    const box = screen.getByLabelText(/In a new worktree/)
    await waitFor(() => expect(box).toBeDisabled())
    expect(box).toHaveAccessibleDescription('· not a git repository')
    // One run of text beside the box, so a narrow sidebar wraps it as a
    // line of text, not as two columns.
    const text = box.closest('label')!.querySelector(':scope > span')!
    expect(text).toHaveTextContent('In a new worktree · not a git repository')
    await userEvent.clear(field)
    await userEvent.type(field, '/w/app')
    await waitFor(() => expect(box).toBeEnabled())
  })

  it('shows the start in progress and blocks a second start', async () => {
    let finish!: (ok: boolean) => void
    const onCreate = setup(vi.fn(() => new Promise<boolean>((r) => (finish = r))), [session])
    await userEvent.type(screen.getByLabelText('Working directory'), '/tmp')
    await userEvent.click(screen.getByRole('button', { name: 'New session' }))
    const busy = screen.getByRole('button', { name: 'Starting…' })
    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'New Claude session in /src/app' })).toBeDisabled()
    await userEvent.click(busy)
    expect(onCreate).toHaveBeenCalledTimes(1)
    finish(true)
    expect(await screen.findByRole('button', { name: 'New session' })).not.toHaveAttribute('aria-busy')
  })

  it('clears the branch and unticks the worktree after a worktree session starts', async () => {
    const onCreate = setup()
    await userEvent.type(screen.getByLabelText('Working directory'), '/repo')
    await userEvent.click(screen.getByLabelText('In a new worktree'))
    await userEvent.type(screen.getByLabelText('Branch name'), 'fix-it')
    await userEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(onCreate).toHaveBeenCalledWith('claude', '/repo', 'fix-it')
    await waitFor(() => expect(screen.getByLabelText('In a new worktree')).not.toBeChecked())
    expect(screen.queryByLabelText('Branch name')).toBeNull()
    await userEvent.click(screen.getByLabelText('In a new worktree'))
    expect(screen.getByLabelText('Branch name')).toHaveValue('')
  })

  it('shows the branch the name becomes', async () => {
    setup()
    await userEvent.type(screen.getByLabelText('Working directory'), '/repo')
    await userEvent.click(screen.getByLabelText('In a new worktree'))
    const field = screen.getByLabelText('Branch name')
    await userEvent.type(field, 'fix/ws')
    expect(field).toHaveAccessibleDescription('→ chamber/fix-ws')
    await userEvent.clear(field)
    await userEvent.type(field, 'Фича test')
    expect(field).toHaveAccessibleDescription('→ chamber/test · only latin letters, digits, . and _ are kept')
  })

  it('refuses a branch name with nothing a branch can be made of, in place', async () => {
    const onCreate = setup()
    await userEvent.type(screen.getByLabelText('Working directory'), '/repo')
    await userEvent.click(screen.getByLabelText('In a new worktree'))
    const field = screen.getByLabelText('Branch name')
    await userEvent.type(field, 'Фича тест')
    expect(field).toHaveAccessibleDescription('Use latin letters or digits')
    await userEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(onCreate).not.toHaveBeenCalled()
    expect(field).toHaveFocus()
    expect(field).toHaveAttribute('aria-invalid', 'true')
  })

  it('says under the branch why the server refused it', async () => {
    setup(vi.fn(async () => {
      fail("Couldn't start the session", new Error('branch already exists: chamber/fix-it'), undefined, { quiet: true })
      return false
    }))
    await userEvent.type(screen.getByLabelText('Working directory'), '/repo')
    await userEvent.click(screen.getByLabelText('In a new worktree'))
    const field = screen.getByLabelText('Branch name')
    await userEvent.type(field, 'fix-it')
    await userEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Branch chamber/fix-it already exists')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveAccessibleDescription('Branch chamber/fix-it already exists')
    await userEvent.type(field, '2')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(field).toHaveAccessibleDescription('→ chamber/fix-it2')
  })

  it('offers to continue on a branch that is already there', async () => {
    const onCreate = vi.fn(async (_agent: string, _cwd: string, _branch?: string, existing?: boolean) => {
      if (existing) return true
      fail("Couldn't start the session", new Error('branch already exists: chamber/fix-it'), undefined, { quiet: true })
      return false
    })
    setup(onCreate)
    await userEvent.type(screen.getByLabelText('Working directory'), '/repo')
    await userEvent.click(screen.getByLabelText('In a new worktree'))
    const field = screen.getByLabelText('Branch name')
    await userEvent.type(field, 'fix-it')
    await userEvent.click(screen.getByRole('button', { name: 'New session' }))
    const go = await screen.findByRole('button', { name: 'Continue on the existing branch' })
    await userEvent.click(go)
    expect(onCreate).toHaveBeenLastCalledWith('claude', '/repo', 'fix-it', true)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Continue on the existing branch' })).toBeNull())
    expect(screen.queryByLabelText('Branch name')).toBeNull()
  })

  it('says where a branch is checked out, with nothing to continue', async () => {
    setup(vi.fn(async () => {
      fail("Couldn't start the session", new Error('branch chamber/fix-it is checked out at /w/app/fix-it'), undefined, { quiet: true })
      return false
    }))
    await userEvent.type(screen.getByLabelText('Working directory'), '/repo')
    await userEvent.click(screen.getByLabelText('In a new worktree'))
    await userEvent.type(screen.getByLabelText('Branch name'), 'fix-it')
    await userEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Branch chamber/fix-it is checked out in /w/app/fix-it')
    expect(screen.queryByRole('button', { name: 'Continue on the existing branch' })).toBeNull()
  })

  it('says under the folder that it does not exist, not in a corner notice', async () => {
    const onCreate = vi.fn(async () => {
      fail("Couldn't start the session", new Error("Folder /nope doesn't exist"), undefined, { quiet: true })
      return false
    })
    setup(onCreate)
    const field = screen.getByLabelText('Working directory')
    await userEvent.type(field, '/nope')
    await userEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(onCreate).toHaveBeenCalledWith('claude', '/nope', undefined)
    expect(await screen.findByRole('alert')).toHaveTextContent("Folder /nope doesn't exist")
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveAccessibleDescription("Folder /nope doesn't exist")
    expect(field).toHaveFocus()
    await userEvent.type(field, '2')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(field).not.toHaveAttribute('aria-invalid')
  })

  it('keeps a long missing folder on one line, cut at its start, not broken mid-word', async () => {
    const long = '/Users/someone/Develop/a/very/long/path/that/goes/on/and/on/doomed'
    setup(vi.fn(async () => {
      fail("Couldn't start the session", new Error(`Folder ${long} no longer exists`), undefined, { quiet: true })
      return false
    }))
    await userEvent.type(screen.getByLabelText('Working directory'), long)
    await userEvent.click(screen.getByRole('button', { name: 'New session' }))
    const hint = await screen.findByRole('alert')
    expect(hint).toHaveTextContent(`Folder ${long} no longer exists`)
    expect(hint.querySelector('.path-text')).toHaveAttribute('title', long)
  })

  it('says a worktree’s missing folder under the folder, not the branch', async () => {
    setup(vi.fn(async () => {
      fail("Couldn't start the session", new Error("Folder /nope doesn't exist"), undefined, { quiet: true })
      return false
    }))
    const folder = screen.getByLabelText('Working directory')
    await userEvent.type(folder, '/nope')
    await userEvent.click(screen.getByLabelText('In a new worktree'))
    const field = screen.getByLabelText('Branch name')
    await userEvent.type(field, 'fix-it')
    await userEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Folder /nope doesn't exist")
    expect(folder).toHaveAttribute('aria-invalid', 'true')
    expect(field).not.toHaveAttribute('aria-invalid')
  })

  it('says nothing under the branch for a failure that isn’t about it', async () => {
    setup(vi.fn(async () => {
      fail("Couldn't start the session", new Error('database is locked'))
      return false
    }))
    await userEvent.type(screen.getByLabelText('Working directory'), '/repo')
    await userEvent.click(screen.getByLabelText('In a new worktree'))
    const field = screen.getByLabelText('Branch name')
    await userEvent.type(field, 'fix-it')
    await userEvent.click(screen.getByRole('button', { name: 'New session' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'New session' })).not.toHaveAttribute('aria-busy'))
    expect(field).not.toHaveAttribute('aria-invalid')
    expect(field).toHaveAccessibleDescription('→ chamber/fix-it')
  })

  it('keeps the branch when the start failed', async () => {
    setup(vi.fn(async () => false))
    await userEvent.type(screen.getByLabelText('Working directory'), '/repo')
    await userEvent.click(screen.getByLabelText('In a new worktree'))
    await userEvent.type(screen.getByLabelText('Branch name'), 'fix-it')
    await userEvent.click(screen.getByRole('button', { name: 'New session' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'New session' })).not.toHaveAttribute('aria-busy'))
    expect(screen.getByLabelText('Branch name')).toHaveValue('fix-it')
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

describe('Sidebar folder', () => {
  it('says why nothing started when no folder is chosen', async () => {
    setup()
    await userEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(screen.getByText('Choose a folder first')).toBeInTheDocument()
  })

  it('starts in the open session\'s folder', () => {
    useSessionStore.setState({ activeId: 's1' })
    setup(undefined, [session])
    expect(screen.getByLabelText('Working directory')).toHaveValue('/src/app')
  })

  it('starts in a worktree session’s repository, not the worktree', () => {
    useSessionStore.setState({ activeId: 'w' })
    setup(undefined, [{ ...session, id: 'w', cwd: '/data/worktrees/app/fix', worktree: { repo: '/src/app', path: '/data/worktrees/app/fix', branch: 'chamber/fix', base: 'main' } }])
    expect(screen.getByLabelText('Working directory')).toHaveValue('/src/app')
  })

  it('does not offer a gone session’s folder, nor a gone folder last used', () => {
    localStorage.setItem('gc.lastFolder', '/work/doomed')
    useSessionStore.setState({ activeId: 'g' })
    setup(undefined, [{ ...session, id: 'g', cwd: '/work/doomed', folderGone: true }])
    expect(screen.getByLabelText('Working directory')).toHaveValue('')
  })

  it('otherwise starts in the folder last used', async () => {
    const onCreate = setup()
    await userEvent.type(screen.getByLabelText('Working directory'), '/repo')
    await userEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(onCreate).toHaveBeenCalledWith('claude', '/repo', undefined)
    expect(localStorage.getItem('gc.lastFolder')).toBe('/repo')
  })

  it('reads the folder last used', () => {
    localStorage.setItem('gc.lastFolder', '/repo')
    setup()
    expect(screen.getByLabelText('Working directory')).toHaveValue('/repo')
  })

  it('offers recent folders that pick at once', async () => {
    const other: Session = { ...session, id: 's2', cwd: '/src/site', activeAt: '2026-10-01T00:00:00Z' }
    setup(undefined, [session, other])
    const chips = screen.getByRole('group', { name: 'Recent folders' })
    await userEvent.click(within(chips).getByRole('button', { name: 'site' }))
    expect(screen.getByLabelText('Working directory')).toHaveValue('/src/site')
  })

  it('keeps the recent folders in place while the page is open', () => {
    const at = (id: string, cwd: string, activeAt: string): Session => ({ ...session, id, cwd, activeAt })
    const chips = () => within(screen.getByRole('group', { name: 'Recent folders' })).getAllByRole('button').map((b) => b.textContent)
    const { rerender } = render(<Sidebar sessions={[at('a', '/src/app', '2026-10-02T00:00:00Z'), at('b', '/src/site', '2026-10-01T00:00:00Z')]} onCreate={vi.fn(async () => true)} />)
    expect(chips()).toEqual(['app', 'site'])
    rerender(<Sidebar sessions={[at('a', '/src/app', '2026-10-02T00:00:00Z'), at('b', '/src/site', '2026-10-03T00:00:00Z')]} onCreate={vi.fn(async () => true)} />)
    expect(chips()).toEqual(['app', 'site'])
    rerender(
      <Sidebar
        sessions={[at('a', '/src/app', '2026-10-02T00:00:00Z'), at('b', '/src/site', '2026-10-03T00:00:00Z'), at('c', '/src/docs', '2026-10-04T00:00:00Z')]}
        onCreate={vi.fn(async () => true)}
      />,
    )
    expect(chips()).toEqual(['docs', 'app', 'site'])
  })

  it('captions the recent folders, so one chip does not read as a second field', () => {
    setup(undefined, [session])
    const chips = screen.getByRole('group', { name: 'Recent folders' })
    const caption = within(chips).getByText('Recent')
    expect(caption).toHaveClass('section-title')
    expect(caption).toHaveAttribute('aria-hidden', 'true')
    expect(within(chips).getByRole('button', { name: 'app' })).toBeInTheDocument()
  })

  it('marks busy the "+" that started a session', async () => {
    let finish!: (ok: boolean) => void
    setup(vi.fn(() => new Promise<boolean>((r) => (finish = r))), [session])
    await userEvent.click(screen.getByRole('button', { name: 'New Claude session in /src/app' }))
    expect(screen.getByRole('button', { name: 'New Claude session in /src/app' })).toHaveAttribute('aria-busy', 'true')
    finish(true)
  })
})

describe('Sidebar search', () => {
  it('brings the list back to its top when the search changes', async () => {
    setup(undefined, [session])
    const body = document.querySelector('.sidebar-body')!
    body.scrollTop = 300
    await userEvent.type(screen.getByLabelText('Search sessions'), 'o')
    expect(body.scrollTop).toBe(0)
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
