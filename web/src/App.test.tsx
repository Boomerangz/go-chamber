import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import * as api from './lib/api'
import { initialChat } from './lib/events'
import * as terminal from './lib/terminal'
import { resetLayout } from './stores/layout'
import { useSessionStore } from './stores/session'
import { resetTerminals, useTerminalStore } from './stores/terminals'
import { useLayoutStore } from './stores/layout'

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

vi.mock('./components/terminal/TerminalView', () => ({
  default: ({ id }: { id: string }) => <div data-testid="terminal-view">{id}</div>,
}))
vi.mock('./lib/terminal', () => ({ listTerminals: vi.fn(), openTerminal: vi.fn(), closeTerminal: vi.fn() }))

const shell = (id: string, cwd: string, over: Partial<terminal.Terminal> = {}): terminal.Terminal => ({
  id, cwd, shell: '/bin/sh', title: cwd.split('/').pop()!, status: 'running', exitCode: 0, createdAt: '', ...over,
})

beforeEach(() => {
  history.replaceState(null, '', '/')
  useSessionStore.setState({ activeId: null, sessions: [], chat: initialChat() })
  localStorage.clear()
  sessionStorage.clear()
  resetLayout()
  resetTerminals()
  vi.stubGlobal('WebSocket', undefined)
  vi.mocked(terminal.listTerminals).mockResolvedValue([])
})

function mockApi() {
  vi.mocked(api.fetchHealth).mockResolvedValue('online')
  vi.mocked(api.listSessions).mockResolvedValue([])
  vi.mocked(api.listRequests).mockResolvedValue([])
  vi.mocked(api.getQuotas).mockResolvedValue([])
}

describe('App', () => {
  it('dismisses the error toast', async () => {
    mockApi()
    render(<App />)
    await screen.findByText('online')
    await new Promise((r) => setTimeout(r, 0))
    act(() => useSessionStore.setState({ error: 'boom' }))
    expect(await screen.findByText('boom')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText('boom')).toBeNull()
  })

  it('shows connection state from health check', async () => {
    mockApi()
    render(<App />)
    expect(screen.getByRole('heading', { name: 'go-chamber' })).toBeInTheDocument()
    expect(await screen.findByText('online')).toBeInTheDocument()
  })

  it('links to the sign-in page when the session expired', async () => {
    vi.mocked(api.fetchHealth).mockResolvedValue('unauthorized')
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Signed out' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/')
  })

  it('signs out with a form post', async () => {
    mockApi()
    render(<App />)
    const button = await screen.findByRole('button', { name: 'Sign out' })
    const form = button.closest('form')!
    expect(form).toHaveAttribute('method', 'post')
    expect(form).toHaveAttribute('action', '/logout')
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
    expect(screen.getByRole('heading', { name: 'New Claude session' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Project proj' })).toBeInTheDocument()
    expect(screen.getByText('hello')).toBeInTheDocument()
    expect(screen.getByText('echo: hello')).toBeInTheDocument()
    expect(screen.getByLabelText('message')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New session' })).toBeInTheDocument()
  })

  it('opens the session named in the URL and follows later selections', async () => {
    mockApi()
    vi.mocked(api.fetchEvents).mockResolvedValue([])
    history.replaceState(null, '', '/s/s1')
    render(<App />)
    await vi.waitFor(() => expect(useSessionStore.getState().activeId).toBe('s1'))
    await act(async () => {
      await useSessionStore.getState().selectSession('s2')
    })
    expect(location.pathname).toBe('/s/s2')
    await act(async () => {
      history.back()
      await new Promise((r) => setTimeout(r, 50))
    })
    await vi.waitFor(() => expect(useSessionStore.getState().activeId).toBe('s1'))
  })

  it('opens the terminal named in the URL', async () => {
    mockApi()
    vi.mocked(terminal.listTerminals).mockResolvedValue([shell('t1', '/tmp'), shell('t2', '/usr')])
    history.replaceState(null, '', '/t/t2')
    render(<App />)
    await vi.waitFor(() => expect(useLayoutStore.getState().mode).toBe('terminal'))
    await vi.waitFor(() => expect(useTerminalStore.getState().activeId).toBe('t2'))
    act(() => useTerminalStore.getState().select('t1'))
    expect(location.pathname).toBe('/t/t1')
    act(() => useLayoutStore.getState().setMode('agents'))
    expect(location.pathname).toBe('/t/t1')
  })

  it('keeps tool output folded until asked', async () => {
    mockApi()
    useSessionStore.setState({
      activeId: 's1',
      chat: {
        ...initialChat('idle'),
        order: ['c1', 'f1'],
        items: {
          c1: { id: 'c1', sessionId: 's1', kind: 'command', status: 'completed', name: 'Bash', input: { command: 'ls' }, text: 'a\nb\nc' },
          f1: { id: 'f1', sessionId: 's1', kind: 'file_change', status: 'completed', name: 'Edit', path: '/tmp/x.go', diff: '-x\n+y' },
        },
      },
    })
    render(<App />)
    const output = await screen.findByText('Output · 3 lines')
    const details = output.closest('details')!
    expect(details).not.toHaveAttribute('open')
    expect(screen.getByText('Diff · 2 lines').closest('details')).not.toHaveAttribute('open')
    await userEvent.click(output)
    expect(details).toHaveAttribute('open')
  })

  it('does not rescan completed tool output during streaming or composer typing', async () => {
    mockApi()
    render(<App />)
    await screen.findByText('online')
    const output = Array.from({ length: 2000 }, () => 'unchanged completed output').join('\n')
    act(() => useSessionStore.setState({
      activeId: 's1', sessions: [{ id: 's1', agent: 'claude', cwd: '/p', status: 'running' }],
      chat: { ...initialChat('running'), order: ['c1', 'a1'], items: {
        c1: { id: 'c1', sessionId: 's1', kind: 'command', status: 'completed', input: { command: 'ls' }, text: output },
        a1: { id: 'a1', sessionId: 's1', kind: 'assistant_message', status: 'streaming', text: 'start' },
      } },
    }))
    let scans = 0
    const split = String.prototype.split
    const spy = vi.spyOn(String.prototype, 'split').mockImplementation(function (this: string, ...args: Parameters<typeof split>) {
      if (String(this) === output && args[0] === '\n') scans++
      return split.apply(this, args)
    })
    try {
      for (let i = 0; i < 20; i++) act(() => useSessionStore.setState((state) => ({
        chat: { ...state.chat, items: { ...state.chat.items, a1: { ...state.chat.items.a1, text: `delta ${i}` } } },
      })))
      await userEvent.type(screen.getByRole('combobox', { name: 'message' }), 'hello')
      expect(scans).toBe(0)
      act(() => useSessionStore.setState((state) => ({
        chat: { ...state.chat, items: { ...state.chat.items, c1: { ...state.chat.items.c1, text: 'changed\noutput' } } },
      })))
      expect(screen.getByText('Output · 2 lines')).toBeInTheDocument()
    } finally {
      spy.mockRestore()
    }
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
    const views = await screen.findByRole('navigation', { name: 'Views' })
    within(views).getByRole('button', { name: 'Chat' }).click()
    expect(useSessionStore.getState().pane).toBe('chat')
    expect(await within(views).findByRole('button', { name: /^Requests\s*1$/ })).toBeInTheDocument()
  })

  it('keeps the dock collapsed to a rail until a tab is opened', async () => {
    mockApi()
    vi.mocked(api.listRequests).mockResolvedValue([
      { id: 'r1', sessionId: 's1', kind: 'permission', state: 'pending', title: 'Run' },
    ])
    vi.mocked(terminal.listTerminals).mockResolvedValue([shell('t1', '/w/a'), shell('t2', '/w/b', { status: 'exited' })])
    useSessionStore.setState({ activeId: null })
    render(<App />)
    const rail = await screen.findByRole('toolbar', { name: 'Dock' })
    expect(await within(rail).findByRole('button', { name: 'Terminal 1' })).toHaveAttribute('aria-pressed', 'false')
    expect(within(rail).getByRole('button', { name: 'Requests 1' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Terminals' })).toBeNull()

    await userEvent.click(within(rail).getByRole('button', { name: 'Terminal 1' }))
    const dock = screen.getByRole('region', { name: 'Terminals' })
    expect(within(dock).getByRole('tab', { name: 'a' })).toBeInTheDocument()
    await userEvent.click(within(rail).getByRole('button', { name: 'Requests 1' }))
    expect(screen.queryByRole('region', { name: 'Terminals' })).toBeNull()
    expect(screen.getAllByRole('complementary', { name: 'Pending requests' }).length).toBeGreaterThan(0)
    await userEvent.click(within(rail).getByRole('button', { name: 'Collapse dock' }))
    expect(within(rail).getByRole('button', { name: 'Requests 1' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('opens the dock terminal in terminal mode', async () => {
    mockApi()
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: /^Terminal/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Open in terminal mode' }))
    expect(screen.getByRole('radio', { name: /Terminal/ })).toHaveAttribute('aria-checked', 'true')
  })

  it('switches to the terminal workspace, apart from the agents', async () => {
    mockApi()
    vi.mocked(api.listSessions).mockResolvedValue([
      { id: 's1', agent: 'claude', cwd: '/w/proj', status: 'idle' },
    ])
    vi.mocked(terminal.listTerminals).mockResolvedValue([shell('t1', '/w/a')])
    vi.mocked(terminal.openTerminal).mockResolvedValue(shell('t2', '/w/proj'))
    useSessionStore.setState({ activeId: null })
    render(<App />)
    await userEvent.click(await screen.findByRole('radio', { name: /Terminal/ }))
    expect(screen.queryByRole('heading', { name: 'Start a session' })).toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Views' })).toBeNull()
    const ws = screen.getByRole('region', { name: 'Terminals' })
    expect(await within(ws).findByText('Pick a terminal to attach.')).toBeInTheDocument()
    expect(within(ws).getByRole('tab', { name: /a/ })).toHaveTextContent('/w/a')

    await userEvent.click(within(ws).getByRole('button', { name: 'Open terminal in proj' }))
    expect(terminal.openTerminal).toHaveBeenCalledWith({ cwd: '/w/proj' })
    expect(within(ws).getByTestId('terminal-view')).toHaveTextContent('t2')
    expect(within(ws).getByRole('tab', { selected: true })).toHaveTextContent('/w/proj')

    await userEvent.click(screen.getByRole('radio', { name: 'Agents' }))
    expect(screen.getByRole('heading', { name: 'Start a session' })).toBeInTheDocument()
  })

  it('groups sessions by project with collapse, older and search', async () => {
    mockApi()
    const mk = (i: number, cwd: string, title?: string) => ({
      id: `s${i}`, agent: 'claude' as const, cwd, status: 'idle' as const, title,
      activeAt: new Date(Date.UTC(2026, 8, 1 + i)).toISOString(),
    })
    const sessions = [...Array.from({ length: 7 }, (_, i) => mk(i, '/w/alpha', `alpha ${i}`)), mk(9, '/w/beta', 'beta task')]
    vi.mocked(api.listSessions).mockResolvedValue(sessions)
    vi.mocked(api.createSession).mockResolvedValue(mk(20, '/w/alpha'))
    useSessionStore.setState({ activeId: null })
    render(<App />)
    const alpha = await screen.findByRole('region', { name: 'Project alpha' })
    expect(alpha.querySelectorAll('.session')).toHaveLength(5)
    screen.getByRole('button', { name: 'Show 2 older' }).click()
    expect(await screen.findByRole('button', { name: 'Show less' })).toBeInTheDocument()
    expect(alpha.querySelectorAll('.session')).toHaveLength(7)
    const toggle = screen.getByRole('button', { name: /^alpha\s*\/w\/alpha/ })
    toggle.click()
    await vi.waitFor(() => expect(alpha.querySelectorAll('.session')).toHaveLength(0))
    expect(useSessionStore.getState().groupModes['/w/alpha']).toBe('collapsed')

    useSessionStore.getState().setQuery('beta')
    await vi.waitFor(() => expect(screen.queryByRole('region', { name: 'Project alpha' })).toBeNull())
    expect(screen.getByText('beta task')).toBeInTheDocument()
    useSessionStore.getState().setQuery('zzz')
    expect(await screen.findByText('No matching sessions')).toBeInTheDocument()
    useSessionStore.getState().setQuery('')

    ;(await screen.findByRole('button', { name: 'New session in alpha' })).click()
    await vi.waitFor(() => expect(api.createSession).toHaveBeenCalledWith('claude', '/w/alpha', undefined))
  })

  it('shows hook runs with their outcome and text', async () => {
    mockApi()
    useSessionStore.setState({
      activeId: 's1',
      chat: {
        ...initialChat('idle'),
        order: ['h1', 'h2', 'h3', 'h4'],
        items: {
          h1: { id: 'h1', sessionId: 's1', kind: 'hook', status: 'completed', name: 'Stop', outcome: 'blocked', text: 'Check your work.' },
          h2: { id: 'h2', sessionId: 's1', kind: 'hook', status: 'streaming', name: 'UserPromptSubmit' },
          h3: { id: 'h3', sessionId: 's1', kind: 'hook', status: 'failed', name: 'PreToolUse', outcome: 'error', text: 'exit 1' },
          h4: { id: 'h4', sessionId: 's1', kind: 'hook', status: 'completed', name: 'Stop', outcome: 'success' },
        },
      },
    })
    render(<App />)
    const hooks = await screen.findAllByText(/hook$/)
    expect(hooks.map((h) => h.textContent)).toEqual(['Stop hook', 'UserPromptSubmit hook', 'PreToolUse hook', 'Stop hook'])
    const items = document.querySelectorAll('.item.hook')
    expect(items[0].textContent).toContain('blocked')
    expect(items[0].textContent).toContain('Check your work.')
    expect(items[1].textContent).toContain('running')
    expect(items[2].textContent).toContain('error')
    expect(items[3].textContent).toContain('ok')
    expect(items[3].tagName).toBe('DIV')
    expect(items[0].tagName).toBe('DETAILS')
  })

  it('hides finished assistant messages without text', async () => {
    mockApi()
    useSessionStore.setState({
      activeId: 's1',
      chat: {
        ...initialChat('idle'),
        order: ['a1', 'a2', 'a3'],
        items: {
          a1: { id: 'a1', sessionId: 's1', kind: 'assistant_message', status: 'completed', text: 'ok' },
          a2: { id: 'a2', sessionId: 's1', kind: 'assistant_message', status: 'completed', text: '  ' },
          a3: { id: 'a3', sessionId: 's1', kind: 'assistant_message', status: 'streaming' },
        },
      },
    })
    render(<App />)
    await screen.findByText('ok')
    expect(document.querySelectorAll('.item.assistant')).toHaveLength(2)
  })
})
