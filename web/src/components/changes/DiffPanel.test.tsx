import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DiffPanel, { POLL_MS } from './DiffPanel'
import { resetLayout, useLayoutStore } from '../../stores/layout'
import * as api from '../../lib/api'
import { resetStore, useSessionStore } from '../../stores/session'
import { useNotices } from '../../stores/notices'

vi.mock('../../lib/api', () => ({
  getChanges: vi.fn(),
  getFileDiff: vi.fn(),
  removeWorktree: vi.fn(),
  // The file viewer reads through requestRaw; here it is the plain fetch.
  requestRaw: vi.fn((path: string, init?: RequestInit) => fetch(path, init)),
}))
vi.mock('../../lib/highlight', () => ({ tokenize: vi.fn(async () => undefined) }))

const worktree = { repo: '/src/app', path: '/wt/app/fix', branch: 'chamber/fix', base: 'abc' }

beforeEach(() => {
  vi.clearAllMocks()
  resetStore()
  useNotices.setState({ notices: [] })
})

describe('DiffPanel', () => {
  it('asks for a session first', () => {
    render(<DiffPanel sessionId={null} />)
    expect(screen.getByText(/Open a session/)).toBeInTheDocument()
  })

  it('says when the folder is not a repository', async () => {
    vi.mocked(api.getChanges).mockResolvedValue({ repository: false, files: [] })
    useSessionStore.setState({ sessions: [{ id: 's1', agent: 'claude', cwd: '/tmp', status: 'idle' }] })
    render(<DiffPanel sessionId="s1" />)
    expect(await screen.findByText(/not a git repository/)).toBeInTheDocument()
  })

  it('lists changed files and shows the diff of the chosen one', async () => {
    vi.mocked(api.getChanges).mockResolvedValue({
      repository: true,
      base: 'HEAD',
      files: [
        { path: 'src/a.go', status: 'M' },
        { path: 'new.txt', status: '?' },
      ],
    })
    vi.mocked(api.getFileDiff).mockResolvedValue({ diff: '@@ -1 +1 @@\n-old\n+new\n' })
    useSessionStore.setState({ sessions: [{ id: 's1', agent: 'claude', cwd: '/src/app', status: 'idle' }] })
    render(<DiffPanel sessionId="s1" />)
    await userEvent.click(await screen.findByRole('button', { name: /src\/a\.go/ }))
    expect(api.getFileDiff).toHaveBeenCalledWith('s1', 'src/a.go')
    expect((await screen.findByText('new')).parentElement).toHaveClass('diff-add')
    expect(screen.getByText('old').parentElement).toHaveClass('diff-del')
    expect(screen.getByText('@@ -1 +1 @@').parentElement).toHaveClass('diff-hunk')
    expect(screen.getByText('untracked')).toBeInTheDocument()
  })

  it('reloads when a turn ends', async () => {
    vi.mocked(api.getChanges).mockResolvedValue({ repository: true, files: [] })
    useSessionStore.setState({ sessions: [{ id: 's1', agent: 'claude', cwd: '/p', status: 'running' }] })
    render(<DiffPanel sessionId="s1" />)
    expect(await screen.findByText('No changes')).toBeInTheDocument()
    expect(api.getChanges).toHaveBeenCalledTimes(1)
    useSessionStore.setState({ sessions: [{ id: 's1', agent: 'claude', cwd: '/p', status: 'idle' }] })
    await waitFor(() => expect(api.getChanges).toHaveBeenCalledTimes(2))
  })

  it('says a branch without commits has nothing to merge yet', async () => {
    vi.mocked(api.getChanges).mockResolvedValue({ repository: true, base: 'abc', files: [], commits: 0 })
    useSessionStore.setState({ sessions: [{ id: 's1', agent: 'claude', cwd: worktree.path, status: 'idle', worktree }] })
    render(<DiffPanel sessionId="s1" />)
    expect(await screen.findByText(/no commits yet/)).toBeInTheDocument()
    expect(screen.queryByText(/git -C/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy merge command' })).toBeNull()
  })

  it('shows the merge hint and removes a clean worktree', async () => {
    vi.mocked(api.getChanges).mockResolvedValue({ repository: true, base: 'abc', files: [], commits: 2 })
    vi.mocked(api.removeWorktree).mockResolvedValue({ id: 's1', agent: 'claude', cwd: worktree.path, status: 'idle', worktree: { ...worktree, removed: true } })
    useSessionStore.setState({ sessions: [{ id: 's1', agent: 'claude', cwd: worktree.path, status: 'idle', worktree }] })
    render(<DiffPanel sessionId="s1" />)
    expect(await screen.findByText('git -C /src/app merge chamber/fix')).toHaveAttribute('title', 'git -C /src/app merge chamber/fix')
    expect(screen.getByText(/2 commits to merge/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Remove worktree' }))
    expect(api.removeWorktree).not.toHaveBeenCalled()
    const ask = screen.getByRole('group', { name: 'Remove worktree?' })
    expect(ask.querySelector('p')).toHaveTextContent(/^Remove the worktree folder\?$/)
    // The path takes a line of its own, not a run inside the question.
    expect(ask.querySelector(':scope > .path-text')).toHaveAttribute('title', '/wt/app/fix')
    expect(ask).toHaveTextContent('Branch chamber/fix is kept, with its 2 commits.')
    expect(ask).not.toHaveTextContent(/lost/)
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(api.removeWorktree).toHaveBeenCalledWith('s1', false)
    await waitFor(() => expect(useSessionStore.getState().sessions[0].worktree?.removed).toBe(true))
    expect(useNotices.getState().notices.at(-1)).toMatchObject({ kind: 'info', text: 'Worktree removed, branch kept' })
  })

  it('says a removed worktree is gone and its branch kept, with no list to show', async () => {
    vi.mocked(api.getChanges).mockResolvedValue({ repository: false, removed: true, branch: 'chamber/fix', files: [] })
    useSessionStore.setState({ sessions: [{ id: 's1', agent: 'claude', cwd: worktree.path, status: 'idle', worktree: { ...worktree, removed: true } }] })
    render(<DiffPanel sessionId="s1" />)
    const gone = await screen.findByRole('status', { name: 'Worktree removed' })
    expect(gone).toHaveTextContent('Worktree removed · branch chamber/fix kept')
    expect(screen.getByText('git -C /src/app merge chamber/fix')).toBeInTheDocument()
    expect(screen.queryByText(/not a git repository/)).toBeNull()
    expect(screen.queryByText('No changes')).toBeNull()
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull()
  })

  it('keeps the worktree when the owner changes their mind', async () => {
    vi.mocked(api.getChanges).mockResolvedValue({ repository: true, base: 'abc', files: [] })
    useSessionStore.setState({ sessions: [{ id: 's1', agent: 'claude', cwd: worktree.path, status: 'idle', worktree }] })
    render(<DiffPanel sessionId="s1" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Remove worktree' }))
    await userEvent.click(screen.getByRole('button', { name: 'Keep' }))
    expect(screen.getByRole('button', { name: 'Remove worktree' })).toBeInTheDocument()
    expect(api.removeWorktree).not.toHaveBeenCalled()
  })

  it('says it is removing while the request runs', async () => {
    vi.mocked(api.getChanges).mockResolvedValue({ repository: true, base: 'abc', files: [] })
    vi.mocked(api.removeWorktree).mockReturnValue(new Promise(() => {}))
    useSessionStore.setState({ sessions: [{ id: 's1', agent: 'claude', cwd: worktree.path, status: 'idle', worktree }] })
    render(<DiffPanel sessionId="s1" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Remove worktree' }))
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(screen.getByRole('button', { name: 'Removing…' })).toHaveAttribute('aria-busy', 'true')
  })

  it('copies the merge command', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    vi.mocked(api.getChanges).mockResolvedValue({ repository: true, base: 'abc', files: [], commits: 1 })
    useSessionStore.setState({ sessions: [{ id: 's1', agent: 'claude', cwd: worktree.path, status: 'idle', worktree }] })
    render(<DiffPanel sessionId="s1" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Copy merge command' }))
    expect(writeText).toHaveBeenCalledWith('git -C /src/app merge chamber/fix')
    vi.unstubAllGlobals()
  })

  it('preserves live session changes while worktree removal awaits its response', async () => {
    vi.mocked(api.getChanges).mockResolvedValue({ repository: true, files: [] })
    const initial: api.Session = { id: 's1', agent: 'claude', cwd: worktree.path, status: 'idle', worktree }
    let finish!: (session: api.Session) => void
    vi.mocked(api.removeWorktree).mockReturnValue(new Promise((resolve) => { finish = resolve }))
    useSessionStore.setState({ sessions: [initial] })
    render(<DiffPanel sessionId="s1" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Remove worktree' }))
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
    act(() => useSessionStore.getState().applyIncoming({
      seq: 1, sessionId: 's1', type: 'session.state',
      session: { ...initial, status: 'running', title: 'Live title' },
    }))
    await act(async () => finish({ id: 's1', agent: 'claude', cwd: worktree.repo, status: 'idle' }))
    expect(useSessionStore.getState().sessions[0]).toMatchObject({ status: 'running', title: 'Live title', cwd: worktree.repo })
    expect(useSessionStore.getState().sessions[0].worktree).toBeUndefined()
  })

  it('warns that listed changes will be lost and removes anyway', async () => {
    vi.mocked(api.getChanges).mockResolvedValue({ repository: true, base: 'abc', files: [{ path: 'a', status: 'M' }] })
    vi.mocked(api.removeWorktree).mockResolvedValueOnce({ id: 's1', agent: 'claude', cwd: worktree.path, status: 'idle' })
    useSessionStore.setState({ sessions: [{ id: 's1', agent: 'claude', cwd: worktree.path, status: 'idle', worktree }] })
    render(<DiffPanel sessionId="s1" />)
    await screen.findByText('a')
    await userEvent.click(screen.getByRole('button', { name: 'Remove worktree' }))
    // no commits on the branch yet: every listed change is uncommitted
    expect(screen.getByText('1 uncommitted change will be lost.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Remove anyway' }))
    expect(api.removeWorktree).toHaveBeenCalledTimes(1)
    expect(api.removeWorktree).toHaveBeenLastCalledWith('s1', true)
  })

  it('with commits on the branch, says only what isn’t committed is lost', async () => {
    vi.mocked(api.getChanges).mockResolvedValue({ repository: true, base: 'abc', files: [{ path: 'a', status: 'M' }, { path: 'b', status: '?' }], commits: 3 })
    useSessionStore.setState({ sessions: [{ id: 's1', agent: 'claude', cwd: worktree.path, status: 'idle', worktree }] })
    render(<DiffPanel sessionId="s1" />)
    await screen.findByText('a')
    await userEvent.click(screen.getByRole('button', { name: 'Remove worktree' }))
    const ask = screen.getByRole('group', { name: 'Remove worktree?' })
    expect(ask).toHaveTextContent('Changes not yet committed will be lost.')
    expect(ask).toHaveTextContent('Branch chamber/fix is kept, with its 3 commits.')
  })

  it('offers a forced removal when the server finds changes', async () => {
    vi.mocked(api.getChanges).mockResolvedValue({ repository: true, base: 'abc', files: [] })
    vi.mocked(api.removeWorktree)
      .mockRejectedValueOnce(new Error('{"error":"worktree has uncommitted changes"}'))
      .mockResolvedValueOnce({ id: 's1', agent: 'claude', cwd: worktree.path, status: 'idle' })
    useSessionStore.setState({ sessions: [{ id: 's1', agent: 'claude', cwd: worktree.path, status: 'idle', worktree }] })
    render(<DiffPanel sessionId="s1" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Remove worktree' }))
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Remove anyway' }))
    expect(api.removeWorktree).toHaveBeenLastCalledWith('s1', true)
  })

  it('says the server found uncommitted changes the list didn’t show', async () => {
    vi.mocked(api.getChanges).mockResolvedValue({ repository: true, base: 'abc', files: [] })
    vi.mocked(api.removeWorktree).mockRejectedValueOnce(new Error('{"error":"worktree has uncommitted changes"}'))
    useSessionStore.setState({ sessions: [{ id: 's1', agent: 'claude', cwd: worktree.path, status: 'idle', worktree }] })
    render(<DiffPanel sessionId="s1" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Remove worktree' }))
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(await screen.findByText('It has uncommitted changes: they will be lost.')).toBeInTheDocument()
  })

  it('says it is loading the list and the diff, and when it last updated', async () => {
    let list!: (c: api.Changes) => void
    vi.mocked(api.getChanges).mockReturnValueOnce(new Promise((r) => { list = r }))
    useSessionStore.setState({ sessions: [{ id: 's1', agent: 'claude', cwd: '/p', status: 'idle' }] })
    render(<DiffPanel sessionId="s1" />)
    expect(screen.getByText('loading changes…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh changes' })).toHaveAttribute('aria-busy', 'true')
    // the toolbar's icon buttons share one quiet form
    for (const name of ['Refresh changes', 'Wrap long lines']) expect(screen.getByRole('button', { name })).toHaveClass('btn-ghost')
    await act(async () => list({ repository: true, files: [{ path: 'src/deep/a.go', status: 'M' }] }))
    expect(screen.getByRole('button', { name: 'Refresh changes' })).not.toHaveAttribute('aria-busy')
    expect(screen.getByText(/^updated \d\d:\d\d$/)).toBeInTheDocument()
    vi.mocked(api.getFileDiff).mockReturnValueOnce(new Promise(() => {}))
    await userEvent.click(screen.getByRole('button', { name: /a\.go/ }))
    expect(screen.getByText('loading diff…')).toBeInTheDocument()
  })

  it('shows the file name in ink and its folder quietly', async () => {
    vi.mocked(api.getChanges).mockResolvedValue({ repository: true, files: [{ path: 'src/deep/a.go', status: 'T' }] })
    render(<DiffPanel sessionId="s1" />)
    expect((await screen.findByText('a.go')).closest('.midcut')).toHaveClass('diff-base')
    expect(screen.getByText('src/deep/')).toHaveClass('diff-dir')
    expect(screen.getByText('type changed').closest('span.diff-status')).toBeInTheDocument()
  })

  it('shows a rename as one row, from the old path to the new, with its counts', async () => {
    vi.mocked(api.getChanges).mockResolvedValue({ repository: true, files: [{ path: 'src/new.go', from: 'old/name.go', status: 'R', added: 2, removed: 1 }] })
    render(<DiffPanel sessionId="s1" />)
    const row = await screen.findByRole('button', { name: /old\/name\.go ?→ ?src\/new\.go/ })
    expect(row).toHaveAttribute('title', 'old/name.go → src/new.go')
    expect(row.querySelector('.diff-from')).toHaveTextContent('old/name.go')
    expect(row.querySelector('.diff-base')).toHaveTextContent(/^new\.go$/)
    expect(row.querySelector('.diff-status')).toHaveTextContent('renamed')
    expect(row).toHaveTextContent('+2−1')
  })

  it('cuts a long name in its middle, keeping the end and extension, and the old folder before the old name', async () => {
    const path = 'src/widgets/renamed_component_header_panel_v2.tsx'
    const from = 'src/components/renamed_component_header_panel.tsx'
    vi.mocked(api.getChanges).mockResolvedValue({ repository: true, files: [{ path, from, status: 'R' }] })
    render(<DiffPanel sessionId="s1" />)
    const row = await screen.findByRole('button', { name: /renamed_component_header_panel\.tsx ?→ ?src\/widgets\// })
    const base = row.querySelector('.diff-base')!
    expect(base.querySelector('.midcut-head')).toHaveTextContent(/^renamed_component_/)
    expect(base.querySelector('.midcut-tail')?.textContent).toMatch(/panel_v2\.tsx$/)
    expect(base).toHaveTextContent('renamed_component_header_panel_v2.tsx')
    const old = row.querySelector('.diff-from')!
    expect(old.querySelector('.diff-from-dir')).toHaveTextContent(/^src\/components\/$/)
    expect(old.querySelector('.midcut-tail')?.textContent).toMatch(/\.tsx$/)
  })

  it('keeps the status word for screen readers and the tooltip when only its mark shows', async () => {
    vi.mocked(api.getChanges).mockResolvedValue({ repository: true, files: [{ path: 'a.go', status: 'M' }] })
    render(<DiffPanel sessionId="s1" />)
    const status = (await screen.findByText('modified')).closest('.diff-status')!
    expect(status).toHaveAttribute('title', 'modified')
    expect(screen.getByText('modified')).toHaveClass('diff-status-word')
  })

  it('collapses an open file on a second click and refetches it with the list', async () => {
    vi.mocked(api.getChanges).mockResolvedValue({ repository: true, files: [{ path: 'a.go', status: 'M' }] })
    vi.mocked(api.getFileDiff).mockResolvedValueOnce({ diff: '+one\n' }).mockResolvedValueOnce({ diff: '+two\n-gone\n' })
    render(<DiffPanel sessionId="s1" />)
    const file = await screen.findByRole('button', { name: /a\.go/ })
    await userEvent.click(file)
    expect(await screen.findByText('one')).toBeInTheDocument()
    expect(file).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'Refresh changes' }))
    expect(await screen.findByText('two')).toBeInTheDocument()
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getByText('−1')).toBeInTheDocument()
    await userEvent.click(file)
    expect(file).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('two')).toBeNull()
  })

  it('keeps the list when one diff fails', async () => {
    vi.mocked(api.getChanges).mockResolvedValue({ repository: true, files: [{ path: 'a.go', status: 'M' }] })
    vi.mocked(api.getFileDiff).mockRejectedValue(new Error('too big'))
    render(<DiffPanel sessionId="s1" />)
    await userEvent.click(await screen.findByRole('button', { name: /a\.go/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('too big')
    expect(screen.getByRole('button', { name: /a\.go/ })).toBeInTheDocument()
  })

  it('shows the first 2000 lines of a long diff until asked for all', async () => {
    const diff = Array.from({ length: 2500 }, (_, i) => `+line ${i}`).join('\n')
    vi.mocked(api.getChanges).mockResolvedValue({ repository: true, files: [{ path: 'big.txt', status: 'A' }] })
    vi.mocked(api.getFileDiff).mockResolvedValue({ diff })
    render(<DiffPanel sessionId="s1" />)
    await userEvent.click(await screen.findByRole('button', { name: /big\.txt/ }))
    expect(await screen.findByText('line 1999')).toBeInTheDocument()
    expect(screen.queryByText('line 2000')).toBeNull()
    expect(screen.getByText('showing 2,000 of 2,500 lines')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'show all 2,500 lines' }))
    expect(screen.getByText('line 2499')).toBeInTheDocument()
  })

  it('shows a load error with a retry', async () => {
    vi.mocked(api.getChanges).mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ repository: true, files: [] })
    useSessionStore.setState({ sessions: [{ id: 's1', agent: 'claude', cwd: '/p', status: 'idle' }] })
    render(<DiffPanel sessionId="s1" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('boom')
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('No changes')).toBeInTheDocument()
  })
})

describe('DiffPanel reading', () => {
  const two = {
    repository: true,
    root: '/src/app',
    files: [
      { path: 'src/a.go', status: 'M', added: 3, removed: 1 },
      { path: 'b.txt', status: '?', added: 1, removed: 0 },
      { path: 'gone.go', status: 'D', added: 0, removed: 7 },
    ],
  }
  beforeEach(() => {
    localStorage.clear()
    resetLayout()
  })

  it('shows each file’s counts before it is opened, and the total', async () => {
    vi.mocked(api.getChanges).mockResolvedValue(two)
    render(<DiffPanel sessionId="s1" />)
    const row = await screen.findByRole('button', { name: /src\/a\.go/ })
    expect(row).toHaveTextContent('+3−1')
    expect(screen.getByLabelText('3 files, 4 added, 8 removed lines')).toHaveTextContent('3 files +4 −8')
    expect(api.getFileDiff).not.toHaveBeenCalled()
  })

  it('names each file row once, in words: path, status and counts', async () => {
    vi.mocked(api.getChanges).mockResolvedValue(two)
    render(<DiffPanel sessionId="s1" />)
    expect(await screen.findByRole('button', { name: 'src/a.go, modified, 3 added, 1 removed' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'b.txt, untracked, 1 added, 0 removed' })).toBeInTheDocument()
  })

  it('says a binary file is binary instead of counting it', async () => {
    vi.mocked(api.getChanges).mockResolvedValue({ repository: true, files: [{ path: 'logo.png', status: 'M', binary: true }] })
    render(<DiffPanel sessionId="s1" />)
    expect(await screen.findByRole('button', { name: /logo\.png/ })).toHaveTextContent('binary')
  })

  it('keeps several files open, and expands or collapses them all', async () => {
    vi.mocked(api.getChanges).mockResolvedValue(two)
    vi.mocked(api.getFileDiff).mockImplementation(async (_s, p) => ({ diff: `@@ -1 +1 @@\n+in ${p}\n` }))
    render(<DiffPanel sessionId="s1" />)
    await userEvent.click(await screen.findByRole('button', { name: /src\/a\.go/ }))
    await userEvent.click(screen.getByRole('button', { name: /b\.txt/ }))
    expect(await screen.findByText('in src/a.go')).toBeInTheDocument()
    expect(await screen.findByText('in b.txt')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    expect(await screen.findByText('in gone.go')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(screen.queryByText(/^in /)).toBeNull()
    expect(screen.getByRole('button', { name: 'Expand all' })).toBeInTheDocument()
  })

  it('numbers old and new lines and wraps them on request', async () => {
    vi.mocked(api.getChanges).mockResolvedValue(two)
    vi.mocked(api.getFileDiff).mockResolvedValue({ diff: '@@ -9,2 +9,2 @@\n keep\n-old\n+new\n' })
    render(<DiffPanel sessionId="s1" />)
    await userEvent.click(await screen.findByRole('button', { name: /src\/a\.go/ }))
    const added = (await screen.findByText('new')).parentElement!
    expect([...added.querySelectorAll('.diff-ln')].map((n) => n.textContent)).toEqual(['', '10'])
    expect(added.querySelector('.diff-sign')).toHaveTextContent('+')
    const kept = screen.getByText('keep').parentElement!
    expect([...kept.querySelectorAll('.diff-ln')].map((n) => n.textContent)).toEqual(['9', '9'])
    const view = added.closest('.diff-view')!
    expect(view).not.toHaveAttribute('data-wrap')
    await userEvent.click(screen.getByRole('button', { name: 'Wrap long lines' }))
    expect(view).toHaveAttribute('data-wrap', 'true')
    expect(useLayoutStore.getState().wrap).toBe(true)
  })

  it('colours code in the file’s language and leaves headers alone', async () => {
    const { tokenize } = await import('../../lib/highlight')
    vi.mocked(tokenize).mockResolvedValueOnce([
      [{ content: 'keep', offset: 0, htmlStyle: { '--shiki-light': '#111' } }],
      [{ content: 'ne', offset: 0 }, { content: 'w', offset: 2, htmlStyle: { '--shiki-light': '#222' } }],
    ])
    vi.mocked(api.getChanges).mockResolvedValue(two)
    vi.mocked(api.getFileDiff).mockResolvedValue({ diff: '@@ -1 +1,2 @@\n keep\n+new\n' })
    render(<DiffPanel sessionId="s1" />)
    await userEvent.click(await screen.findByRole('button', { name: /src\/a\.go/ }))
    expect(await screen.findByText('w')).toHaveStyle({ '--shiki-light': '#222' })
    expect(tokenize).toHaveBeenCalledWith('keep\nnew', 'go')
    expect(screen.getByText('@@ -1 +1,2 @@')).toBeInTheDocument()
  })

  it('moves between files with j and k', async () => {
    vi.mocked(api.getChanges).mockResolvedValue(two)
    render(<DiffPanel sessionId="s1" />)
    const first = await screen.findByRole('button', { name: /src\/a\.go/ })
    first.focus()
    await userEvent.keyboard('j')
    expect(screen.getByRole('button', { name: /b\.txt/ })).toHaveFocus()
    await userEvent.keyboard('j')
    await userEvent.keyboard('j')
    expect(screen.getByRole('button', { name: /gone\.go/ })).toHaveFocus()
    await userEvent.keyboard('k')
    expect(screen.getByRole('button', { name: /b\.txt/ })).toHaveFocus()
    screen.getByRole('region', { name: 'Changes' }).focus()
    fireEvent.keyDown(screen.getByRole('region', { name: 'Changes' }), { key: 'k' })
    expect(screen.getByRole('button', { name: /gone\.go/ })).toHaveFocus()
  })

  it('copies a file’s path and opens it in the viewer from the repository root', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('package a')))
    vi.mocked(api.getChanges).mockResolvedValue(two)
    render(<DiffPanel sessionId="s1" />)
    await screen.findByRole('button', { name: /src\/a\.go/ })
    const [copyA] = screen.getAllByRole('button', { name: 'Copy path' })
    await userEvent.click(copyA!)
    expect(writeText).toHaveBeenCalledWith('src/a.go')
    expect(useNotices.getState().notices.at(-1)).toMatchObject({ kind: 'info', text: 'Copied the path' })
    writeText.mockRejectedValueOnce(new Error('denied'))
    await userEvent.click(copyA!)
    expect(useNotices.getState().notices.at(-1)).toMatchObject({ kind: 'error', title: "Couldn't copy the path" })
    // A deleted file has nothing to view.
    expect(screen.getAllByRole('button', { name: 'View file' })).toHaveLength(2)
    await userEvent.click(screen.getAllByRole('button', { name: 'View file' })[0]!)
    expect(await screen.findByText('package a')).toBeInTheDocument()
    expect(api.requestRaw).toHaveBeenCalledWith('/api/sessions/s1/file?path=%2Fsrc%2Fapp%2Fsrc%2Fa.go')
    vi.unstubAllGlobals()
  })

  it('offers a retry when a diff fails, and marks a file being reloaded', async () => {
    vi.mocked(api.getChanges).mockResolvedValue(two)
    vi.mocked(api.getFileDiff).mockRejectedValueOnce(new Error('too big')).mockResolvedValueOnce({ diff: '+fine\n' })
    render(<DiffPanel sessionId="s1" />)
    await userEvent.click(await screen.findByRole('button', { name: /src\/a\.go/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the diff: too big")
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('fine')).toBeInTheDocument()
    vi.mocked(api.getFileDiff).mockReturnValueOnce(new Promise(() => {}))
    await userEvent.click(screen.getByRole('button', { name: 'Refresh changes' }))
    await waitFor(() => expect(screen.getByText('fine').closest('li')).toHaveAttribute('aria-busy', 'true'))
    expect(screen.getByText('fine').closest('li')!.querySelector('.busy-mark')).not.toBeNull()
  })

  it('follows a running turn: polls the list and refetches only diffs that moved', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      vi.mocked(api.getChanges).mockResolvedValue(two)
      vi.mocked(api.getFileDiff).mockResolvedValue({ diff: '+x\n' })
      useSessionStore.setState({ sessions: [{ id: 's1', agent: 'claude', cwd: '/src/app', status: 'running' }] })
      render(<DiffPanel sessionId="s1" />)
      await userEvent.click(await screen.findByRole('button', { name: /src\/a\.go/ }))
      await userEvent.click(screen.getByRole('button', { name: /b\.txt/ }))
      await waitFor(() => expect(api.getFileDiff).toHaveBeenCalledTimes(2))
      expect(api.getChanges).toHaveBeenCalledTimes(1)
      let list!: (c: api.Changes) => void
      vi.mocked(api.getChanges).mockReturnValueOnce(new Promise((r) => { list = r }))
      await act(async () => vi.advanceTimersByTime(POLL_MS))
      expect(api.getChanges).toHaveBeenCalledTimes(2)
      // A poll is quiet: only a reload asked for says "refreshing…".
      expect(screen.queryByText('refreshing…')).toBeNull()
      expect(screen.getByText(/^updated \d\d:\d\d$/)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Refresh changes' })).not.toHaveAttribute('aria-busy')
      await act(async () => list({ ...two, files: [{ ...two.files[0]!, added: 5 }, two.files[1]!, two.files[2]!] }))
      await waitFor(() => expect(api.getFileDiff).toHaveBeenCalledTimes(3))
      expect(vi.mocked(api.getFileDiff).mock.calls[2]).toEqual(['s1', 'src/a.go'])
      expect(screen.getByText(/^updated \d\d:\d\d$/)).toBeInTheDocument()
      act(() => useSessionStore.setState({ sessions: [{ id: 's1', agent: 'claude', cwd: '/src/app', status: 'idle' }] }))
      await waitFor(() => expect(api.getChanges).toHaveBeenCalledTimes(3))
      const calls = vi.mocked(api.getChanges).mock.calls.length
      await act(async () => vi.advanceTimersByTime(POLL_MS * 2))
      expect(api.getChanges).toHaveBeenCalledTimes(calls)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('DiffPanel headers', () => {
  it('hides git’s header lines and keeps a rename as a quiet note', async () => {
    vi.mocked(api.getChanges).mockResolvedValue({ repository: true, files: [{ path: 'new.go', status: 'M', added: 1, removed: 1 }] })
    vi.mocked(api.getFileDiff).mockResolvedValue({
      diff: 'diff --git a/old.go b/new.go\nsimilarity index 90%\nrename from old.go\nrename to new.go\nindex 1..2 100644\n--- a/old.go\n+++ b/new.go\n@@ -1 +1 @@\n-a\n+b\n',
    })
    render(<DiffPanel sessionId="s1" />)
    await userEvent.click(await screen.findByRole('button', { name: /new\.go/ }))
    expect(await screen.findByText('renamed from old.go')).toHaveClass('diff-note')
    expect(screen.queryByText(/^diff --git/)).toBeNull()
    expect(screen.queryByText(/^index /)).toBeNull()
    expect(screen.queryByText('+++ b/new.go')).toBeNull()
  })

  it('says a binary file is binary and offers to view it', async () => {
    vi.mocked(api.getChanges).mockResolvedValue({ repository: true, files: [{ path: 'shot.png', status: 'M', binary: true }] })
    vi.mocked(api.getFileDiff).mockResolvedValue({ diff: 'diff --git a/shot.png b/shot.png\nBinary files a/shot.png and b/shot.png differ\n' })
    render(<DiffPanel sessionId="s1" />)
    await userEvent.click(await screen.findByRole('button', { name: /shot\.png/ }))
    expect(await screen.findByText('binary file')).toBeInTheDocument()
    expect(screen.queryByText(/Binary files/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'View' }))
    expect(document.querySelector('.file-viewer')).not.toBeNull()
  })

  it('reads a binary diff git reports for a file the list didn’t mark', async () => {
    vi.mocked(api.getChanges).mockResolvedValue({ repository: true, files: [{ path: 'old.bin', status: 'D' }] })
    vi.mocked(api.getFileDiff).mockResolvedValue({ diff: 'diff --git a/old.bin b/old.bin\nBinary files a/old.bin and /dev/null differ\n' })
    render(<DiffPanel sessionId="s1" />)
    await userEvent.click(await screen.findByRole('button', { name: /old\.bin/ }))
    expect(await screen.findByText('binary file')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'View' })).toBeNull()
  })

  it('says “refreshing…” for a reload asked for', async () => {
    vi.mocked(api.getChanges).mockResolvedValueOnce({ repository: true, files: [] }).mockReturnValueOnce(new Promise(() => {}))
    render(<DiffPanel sessionId="s1" />)
    expect(await screen.findByText(/^updated/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Refresh changes' }))
    expect(screen.getByText('refreshing…')).toBeInTheDocument()
  })
})

it('late diff must not replace the selected file',async()=>{
 vi.mocked(api.getChanges).mockResolvedValue({repository:true,files:[{path:'a.go',status:'M'},{path:'b.go',status:'M'}]})
 let finishA!:(v:{diff:string})=>void
 let finishB!:(v:{diff:string})=>void
 vi.mocked(api.getFileDiff).mockImplementation((_s,p)=>new Promise(r=>{if(p==='a.go')finishA=r;else finishB=r}))
 render(<DiffPanel sessionId="s1" />)
 fireEvent.click(await screen.findByRole('button',{name:/a.go/}))
 fireEvent.click(screen.getByRole('button',{name:/b.go/}))
 await act(async()=>finishB({diff:'+B'}))
 expect(screen.getByText('B')).toBeInTheDocument()
 await act(async()=>finishA({diff:'+A'}))
 expect(screen.getByText('B')).toBeInTheDocument()
},20000)

