import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DiffPanel from './DiffPanel'
import * as api from '../../lib/api'
import { resetStore, useSessionStore } from '../../stores/session'

vi.mock('../../lib/api', () => ({
  getChanges: vi.fn(),
  getFileDiff: vi.fn(),
  removeWorktree: vi.fn(),
}))

const worktree = { repo: '/src/app', path: '/wt/app/fix', branch: 'chamber/fix', base: 'abc' }

beforeEach(() => {
  vi.clearAllMocks()
  resetStore()
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
    expect(api.removeWorktree).toHaveBeenCalledWith('s1', false)
    await waitFor(() => expect(useSessionStore.getState().sessions[0].worktree).toBeUndefined())
  })

  it('offers a forced removal when the worktree has changes', async () => {
    vi.mocked(api.getChanges).mockResolvedValue({ repository: true, base: 'abc', files: [{ path: 'a', status: 'M' }] })
    vi.mocked(api.removeWorktree)
      .mockRejectedValueOnce(new Error('{"error":"worktree has uncommitted changes"}'))
      .mockResolvedValueOnce({ id: 's1', agent: 'claude', cwd: worktree.path, status: 'idle' })
    useSessionStore.setState({ sessions: [{ id: 's1', agent: 'claude', cwd: worktree.path, status: 'idle', worktree }] })
    render(<DiffPanel sessionId="s1" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Remove worktree' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Remove anyway' }))
    expect(api.removeWorktree).toHaveBeenLastCalledWith('s1', true)
  })

  it('shows a load error', async () => {
    vi.mocked(api.getChanges).mockRejectedValue(new Error('boom'))
    useSessionStore.setState({ sessions: [{ id: 's1', agent: 'claude', cwd: '/p', status: 'idle' }] })
    render(<DiffPanel sessionId="s1" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('boom')
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

