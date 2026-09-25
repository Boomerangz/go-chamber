import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import App from './App'
import * as api from './lib/api'
import { initialChat } from './lib/events'
import { useSessionStore } from './stores/session'

vi.mock('./lib/api', () => ({
  fetchHealth: vi.fn(),
  listSessions: vi.fn(),
  listRequests: vi.fn(),
  getQuotas: vi.fn(),
  refreshQuota: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(),
  sendMessage: vi.fn(),
  interrupt: vi.fn(),
  respondRequest: vi.fn(),
  fetchEvents: vi.fn(),
}))

function mockApi() {
  vi.mocked(api.fetchHealth).mockResolvedValue('online')
  vi.mocked(api.listSessions).mockResolvedValue([])
  vi.mocked(api.listRequests).mockResolvedValue([])
  vi.mocked(api.getQuotas).mockResolvedValue([])
}

describe('App', () => {
  it('shows connection state from health check', async () => {
    mockApi()
    render(<App />)
    expect(screen.getByRole('heading', { name: 'go-chamber' })).toBeInTheDocument()
    expect(await screen.findByText('online')).toBeInTheDocument()
  })

  it('explains how to log in when unauthorized', async () => {
    vi.mocked(api.fetchHealth).mockResolvedValue('unauthorized')
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Token required' })).toBeInTheDocument()
  })

  it('renders sessions and streamed items', async () => {
    mockApi()
    vi.mocked(api.listSessions).mockResolvedValue([
      { id: 's1', agent: 'claude', cwd: '/tmp/proj', status: 'idle' },
    ])
    useSessionStore.setState({
      sessions: [{ id: 's1', agent: 'claude', cwd: '/tmp/proj', status: 'idle' }],
      activeId: 's1',
      chat: {
        ...initialChat('idle'),
        order: ['u1', 'a1'],
        items: {
          u1: { id: 'u1', sessionId: 's1', kind: 'user_message', status: 'completed', text: 'hello' },
          a1: { id: 'a1', sessionId: 's1', kind: 'assistant_message', status: 'completed', text: 'echo: hello' },
        },
      },
    })
    render(<App />)
    expect((await screen.findAllByText('/tmp/proj')).length).toBeGreaterThan(0)
    expect(screen.getByRole('heading', { name: 'proj' })).toBeInTheDocument()
    expect(screen.getByText('hello')).toBeInTheDocument()
    expect(screen.getByText('echo: hello')).toBeInTheDocument()
    expect(screen.getByLabelText('message')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New session' })).toBeInTheDocument()
  })

  it('renders tool and reasoning items', async () => {
    mockApi()
    useSessionStore.setState({
      activeId: 's1',
      chat: {
        ...initialChat('running'),
        order: ['r1', 'c1', 'f1', 't1', 's1'],
        items: {
          r1: { id: 'r1', sessionId: 's1', kind: 'reasoning', status: 'completed', text: 'hmm' },
          c1: { id: 'c1', sessionId: 's1', kind: 'command', status: 'completed', name: 'Bash', input: { command: 'ls' }, text: 'a\nb' },
          f1: { id: 'f1', sessionId: 's1', kind: 'file_change', status: 'completed', name: 'Edit', path: '/tmp/x.go' },
          t1: { id: 't1', sessionId: 's1', kind: 'tool_call', status: 'completed', name: 'WebFetch' },
          s1: { id: 's1', sessionId: 's1', kind: 'subagent', status: 'completed', name: 'Task' },
        },
      },
    })
    render(<App />)
    expect(await screen.findByText('hmm')).toBeInTheDocument()
    expect(screen.getByText('ls')).toBeInTheDocument()
    expect(screen.getByText('/tmp/x.go')).toBeInTheDocument()
    expect(screen.getByText('WebFetch')).toBeInTheDocument()
    expect(screen.getByText('subagent: Task')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Steer' })).toBeInTheDocument()
  })

  it('renders subagent items nested under their parent', async () => {
    mockApi()
    useSessionStore.setState({
      activeId: 's1',
      chat: {
        ...initialChat('idle'),
        order: ['sub', 'child'],
        items: {
          sub: { id: 'sub', sessionId: 's1', kind: 'subagent', status: 'completed', name: 'Task' },
          child: { id: 'child', sessionId: 's1', kind: 'assistant_message', status: 'completed', text: 'working', parentItemId: 'sub' },
        },
      },
    })
    render(<App />)
    expect(await screen.findByText('subagent: Task')).toBeInTheDocument()
    expect(document.querySelector('.subagent-items')?.textContent).toContain('working')
  })

  it('explains an interrupted session without history', async () => {
    mockApi()
    const session = {
      id: 's1', agent: 'claude' as const, cwd: '/tmp/proj', status: 'interrupted' as const,
      interruption: { reason: 'server_restart' },
    }
    vi.mocked(api.listSessions).mockResolvedValue([session])
    useSessionStore.setState({ sessions: [session], activeId: 's1', chat: initialChat('detached') })
    render(<App />)
    expect(await screen.findByText('Turn interrupted')).toBeInTheDocument()
    expect(screen.getByText(/go-chamber restarted mid-turn/)).toBeInTheDocument()
    expect(document.querySelector('.chat-meta .status')?.textContent).toBe('interrupted')
  })

  it('invites to start a session when none is open', async () => {
    mockApi()
    useSessionStore.setState({ activeId: null })
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Start a session' })).toBeInTheDocument()
    expect(screen.getByText('No sessions yet')).toBeInTheDocument()
  })

  it('switches panes from the pane bar', async () => {
    mockApi()
    vi.mocked(api.listRequests).mockResolvedValue([
      { id: 'r1', sessionId: 's1', kind: 'permission', state: 'pending', title: 'Run' },
    ])
    useSessionStore.setState({ activeId: null })
    render(<App />)
    const terminal = await screen.findByRole('button', { name: 'Terminal' })
    terminal.click()
    expect(useSessionStore.getState().pane).toBe('terminal')
    expect(await screen.findByRole('button', { name: /^Requests\s*1$/ })).toBeInTheDocument()
  })
})
