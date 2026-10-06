import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DiffPanel from './DiffPanel'
import * as api from '../../lib/api'
import { resetStore, useSessionStore } from '../../stores/session'
import { useNotices } from '../../stores/notices'

vi.mock('../../lib/api', () => ({
  getChanges: vi.fn(),
  getFileDiff: vi.fn(),
  removeWorktree: vi.fn(),
}))

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
    expect(await screen.findByText('+new')).toHaveClass('diff-add')
    expect(screen.getByText('-old')).toHaveClass('diff-del')
    expect(screen.getByText('@@ -1 +1 @@')).toHaveClass('diff-hunk')
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

  it('shows the merge hint and removes a clean worktree', async () => {
    vi.mocked(api.getChanges).mockResolvedValue({ repository: true, base: 'abc', files: [] })
    vi.mocked(api.removeWorktree).mockResolvedValue({ id: 's1', agent: 'claude', cwd: worktree.path, status: 'idle' })
    useSessionStore.setState({ sessions: [{ id: 's1', agent: 'claude', cwd: worktree.path, status: 'idle', worktree }] })
    render(<DiffPanel sessionId="s1" />)
    expect(await screen.findByText('git -C /src/app merge chamber/fix')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Remove worktree' }))
    expect(api.removeWorktree).not.toHaveBeenCalled()
    expect(screen.getByText(/remove folder \/wt\/app\/fix\? branch chamber\/fix is kept/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(api.removeWorktree).toHaveBeenCalledWith('s1', false)
    await waitFor(() => expect(useSessionStore.getState().sessions[0].worktree).toBeUndefined())
    expect(useNotices.getState().notices.at(-1)).toMatchObject({ kind: 'info', text: 'Worktree removed, branch kept' })
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
    vi.mocked(api.getChanges).mockResolvedValue({ repository: true, base: 'abc', files: [] })
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
    expect(screen.getByText(/uncommitted changes will be lost/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Remove anyway' }))
    expect(api.removeWorktree).toHaveBeenCalledTimes(1)
    expect(api.removeWorktree).toHaveBeenLastCalledWith('s1', true)
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

  it('says it is loading the list and the diff, and when it last updated', async () => {
    let list!: (c: api.Changes) => void
    vi.mocked(api.getChanges).mockReturnValueOnce(new Promise((r) => { list = r }))
    useSessionStore.setState({ sessions: [{ id: 's1', agent: 'claude', cwd: '/p', status: 'idle' }] })
    render(<DiffPanel sessionId="s1" />)
    expect(screen.getByText('loading changes…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh changes' })).toHaveAttribute('aria-busy', 'true')
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
    expect(await screen.findByText('a.go')).toHaveClass('diff-base')
    expect(screen.getByText('src/deep/')).toHaveClass('diff-dir')
    expect(screen.getByText('type changed')).toHaveClass('diff-status')
  })

  it('collapses an open file on a second click and refetches it with the list', async () => {
    vi.mocked(api.getChanges).mockResolvedValue({ repository: true, files: [{ path: 'a.go', status: 'M' }] })
    vi.mocked(api.getFileDiff).mockResolvedValueOnce({ diff: '+one\n' }).mockResolvedValueOnce({ diff: '+two\n-gone\n' })
    render(<DiffPanel sessionId="s1" />)
    const file = await screen.findByRole('button', { name: /a\.go/ })
    await userEvent.click(file)
    expect(await screen.findByText('+one')).toBeInTheDocument()
    expect(file).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'Refresh changes' }))
    expect(await screen.findByText('+two')).toBeInTheDocument()
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getByText('−1')).toBeInTheDocument()
    await userEvent.click(file)
    expect(file).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('+two')).toBeNull()
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
    expect(await screen.findByText('+line 1999')).toBeInTheDocument()
    expect(screen.queryByText('+line 2000')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'show all 2500 lines' }))
    expect(screen.getByText('+line 2499')).toBeInTheDocument()
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

it('late diff must not replace the selected file',async()=>{
 vi.mocked(api.getChanges).mockResolvedValue({repository:true,files:[{path:'a.go',status:'M'},{path:'b.go',status:'M'}]})
 let finishA!:(v:{diff:string})=>void
 let finishB!:(v:{diff:string})=>void
 vi.mocked(api.getFileDiff).mockImplementation((_s,p)=>new Promise(r=>{if(p==='a.go')finishA=r;else finishB=r}))
 render(<DiffPanel sessionId="s1" />)
 fireEvent.click(await screen.findByRole('button',{name:/a.go/}))
 fireEvent.click(screen.getByRole('button',{name:/b.go/}))
 await act(async()=>finishB({diff:'+B'}))
 expect(screen.getByText('+B')).toBeInTheDocument()
 await act(async()=>finishA({diff:'+A'}))
 expect(screen.getByText('+B')).toBeInTheDocument()
},20000)

