import { act, render, screen, within } from '@testing-library/react'
import { HOLD_TIMEOUT_MS } from '../../lib/pending'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RequestTray from './RequestTray'
import { resetStore, useSessionStore } from '../../stores/session'
import { fail, useNotices } from '../../stores/notices'
import * as api from '../../lib/api'

vi.mock('../../lib/api', () => ({
  continueSession: vi.fn(),
  listSessions: vi.fn(),
  listRequests: vi.fn(),
  createSession: vi.fn(),
  fetchEvents: vi.fn().mockResolvedValue([]),
  sendMessage: vi.fn(),
  interrupt: vi.fn(),
  respondRequest: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('WebSocket', undefined)
  resetStore()
})

describe('RequestTray', () => {
  it('shows only an empty note without pending requests', () => {
    useSessionStore.setState({ requestsStatus: 'ready' })
    render(<RequestTray />)
    expect(screen.queryByLabelText('Pending requests')).toBeNull()
    expect(screen.getByText('No pending requests')).toBeInTheDocument()
  })

  it("prints a permission's keys lowercase, as the help sheet does", () => {
    useSessionStore.setState({
      sessions: [{ id: 's1', agent: 'claude', cwd: '/tmp/proj', status: 'running' }],
      pendingRequests: [{ id: 'r1', sessionId: 's1', kind: 'permission', state: 'pending', title: 'Run command', payload: { suggestions: [{ type: 'addRules' }] } }],
    })
    const { container } = render(<RequestTray />)
    const keys = [...container.querySelectorAll('kbd')].map((k) => k.textContent)
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.every((k) => k === k?.toLowerCase())).toBe(true)
  })

  it('names the session a request belongs to', () => {
    useSessionStore.setState({
      sessions: [{ id: 's1', agent: 'codex', cwd: '/tmp/proj', status: 'running' }],
      pendingRequests: [{ id: 'r1', sessionId: 's1', kind: 'question', state: 'pending', title: 'Pick one' }],
    })
    render(<RequestTray />)
    expect(screen.getByRole('button', { name: /Pick one/ })).toHaveTextContent('proj')
    // the name may be cut to the line: the whole of it is on hover
    expect(screen.getByText('proj')).toHaveAttribute('title', 'proj')
  })

  it('reads each line by what it asks, the session beneath', () => {
    useSessionStore.setState({
      sessions: [{ id: 's1', agent: 'claude', cwd: '/tmp/proj', status: 'running', title: 'hello from the worktree' }],
      pendingRequests: [
        { id: 'r1', sessionId: 's1', kind: 'permission', state: 'pending', title: 'Run command', payload: { toolName: 'Bash', input: { command: 'make test' } } },
        { id: 'r2', sessionId: 's1', kind: 'question', state: 'pending', title: 'Question', payload: { input: { questions: [{ question: 'Which option?' }] } } },
      ],
    })
    render(<RequestTray />)
    const labels = [...document.querySelectorAll('.request-label')].map((l) => l.textContent)
    expect(labels).toEqual(['make test', 'Which option?'])
    expect(document.querySelector('.request-label')).toHaveAttribute('title', 'make test')
    expect(screen.getAllByText('hello from the worktree')).toHaveLength(2)
  })

  it('names each kind as the request block does: what it requires', () => {
    useSessionStore.setState({
      pendingRequests: [
        { id: 'r1', sessionId: 's1', kind: 'permission', state: 'pending', title: 'Run command' },
        { id: 'r2', sessionId: 's1', kind: 'question', state: 'pending', title: 'Pick one' },
        { id: 'r3', sessionId: 's1', kind: 'elicitation', state: 'pending', title: 'Fill in' },
      ],
    })
    render(<RequestTray />)
    const kinds = [...document.querySelectorAll('.request-kind')].map((k) => k.textContent)
    expect(kinds).toEqual(['Approval', 'Answer', 'Input'])
  })

  it('lists requests and opens their session', async () => {
    useSessionStore.setState({
      pendingRequests: [
        { id: 'r1', sessionId: 's1', kind: 'permission', state: 'pending', title: 'Run command' },
      ],
    })
    render(<RequestTray />)
    expect(screen.getByText('Run command')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Run command/ }))
    expect(useSessionStore.getState().activeId).toBe('s1')
    expect(useSessionStore.getState().pane).toBe('chat')
  })

  it('answers a permission in place without opening its session', async () => {
    const respond = vi.fn().mockResolvedValue(undefined)
    useSessionStore.setState({
      respond,
      sessions: [{ id: 's1', agent: 'claude', cwd: '/tmp/proj', status: 'running' }],
      pendingRequests: [{ id: 'r1', sessionId: 's1', kind: 'permission', state: 'pending', title: 'Run command' }],
    })
    render(<RequestTray />)
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }))
    expect(respond).toHaveBeenCalledWith('s1', 'r1', { behavior: 'allow' })
    // answered: the line holds until it leaves, so a second click can't send again
    expect(screen.getByRole('button', { name: 'Deny' })).toBeDisabled()
    expect(useSessionStore.getState().activeId).not.toBe('s1')
    expect(screen.queryByRole('button', { name: 'Allow for session' })).toBeNull()
  })

  it('offers allow-for-session where the agent supports it', async () => {
    const respond = vi.fn().mockResolvedValue(undefined)
    useSessionStore.setState({
      respond,
      sessions: [{ id: 's1', agent: 'codex', cwd: '/tmp/proj', status: 'running' }],
      pendingRequests: [{ id: 'r1', sessionId: 's1', kind: 'permission', state: 'pending', title: 'Run command' }],
    })
    render(<RequestTray />)
    await userEvent.click(screen.getByRole('button', { name: 'Allow for session' }))
    expect(respond).toHaveBeenCalledWith('s1', 'r1', { behavior: 'allow', allowForSession: true })
  })

  it('answers from the keyboard and moves between requests with the arrows', async () => {
    // an answered request leaves the queue, as request.resolved does
    const respond = vi.fn(async (sessionId: string, id: string) => {
      useSessionStore.setState({
        pendingRequests: useSessionStore.getState().pendingRequests.filter((r) => r.sessionId !== sessionId || r.id !== id),
      })
      return true
    })
    useSessionStore.setState({
      respond,
      sessions: [
        { id: 's1', agent: 'codex', cwd: '/tmp/one', status: 'running' },
        { id: 's2', agent: 'claude', cwd: '/tmp/two', status: 'running' },
      ],
      pendingRequests: [
        { id: 'r1', sessionId: 's1', kind: 'permission', state: 'pending', title: 'First' },
        { id: 'r1', sessionId: 's2', kind: 'permission', state: 'pending', title: 'Second' },
        { id: 'r2', sessionId: 's1', kind: 'permission', state: 'pending', title: 'Third' },
      ],
    })
    render(<RequestTray />)
    screen.getByRole('button', { name: /First/ }).focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('button', { name: /Second/ })).toHaveFocus()
    await userEvent.keyboard('d')
    expect(respond).toHaveBeenLastCalledWith('s2', 'r1', { behavior: 'deny' })
    // answered: focus moves on to the next line, ready for the next key
    await vi.waitFor(() => expect(screen.getByRole('button', { name: /Third/ })).toHaveFocus())
    await userEvent.keyboard('s')
    expect(respond).toHaveBeenLastCalledWith('s1', 'r2', { behavior: 'allow', allowForSession: true })
    // the last line answered: focus steps back to the one above
    await vi.waitFor(() => expect(screen.getByRole('button', { name: /First/ })).toHaveFocus())
    await userEvent.keyboard('a')
    expect(respond).toHaveBeenLastCalledWith('s1', 'r1', { behavior: 'allow' })
    expect(respond).toHaveBeenCalledTimes(3)
  })

  it('keeps focus in the tray once the last line is answered from the keyboard', async () => {
    const respond = vi.fn().mockResolvedValue(undefined)
    useSessionStore.setState({
      respond,
      pendingRequests: [{ id: 'r1', sessionId: 's1', kind: 'permission', state: 'pending', title: 'Only' }],
    })
    render(<RequestTray />)
    screen.getByRole('button', { name: /Only/ }).focus()
    await userEvent.keyboard('a')
    expect(respond).toHaveBeenCalledWith('s1', 'r1', { behavior: 'allow' })
    // No line left to move to: the tray itself holds focus, not the page.
    await vi.waitFor(() => expect(screen.getByRole('complementary', { name: 'Pending requests' })).toHaveFocus())
    // The request leaves the queue: the empty tray takes focus over.
    act(() => useSessionStore.setState({ pendingRequests: [], requestsStatus: 'ready' }))
    expect(screen.getByText('No pending requests')).toHaveFocus()
    expect(document.activeElement).not.toBe(document.body)
  })

  it('keeps focus in the empty tray when the request left before its answer came back', async () => {
    let release: (ok: boolean) => void = () => {}
    const respond = vi.fn(() => new Promise<boolean>((r) => (release = r)))
    useSessionStore.setState({
      respond,
      requestsStatus: 'ready',
      pendingRequests: [{ id: 'r1', sessionId: 's1', kind: 'permission', state: 'pending', title: 'Only' }],
    })
    render(<RequestTray />)
    screen.getByRole('button', { name: /Only/ }).focus()
    await userEvent.keyboard('a')
    // The live event drops the request first: the tray empties under focus.
    act(() => useSessionStore.setState({ pendingRequests: [] }))
    await act(async () => release(true))
    await vi.waitFor(() => expect(screen.getByText('No pending requests')).toHaveFocus())
  })

  it('keeps focus in the tray when the focused line is answered elsewhere', async () => {
    const first = { id: 'r1', sessionId: 's1', kind: 'permission' as const, state: 'pending' as const, title: 'First' }
    useSessionStore.setState({
      requestsStatus: 'ready',
      pendingRequests: [first, { id: 'r2', sessionId: 's1', kind: 'permission', state: 'pending', title: 'Second' }],
    })
    render(<RequestTray />)
    screen.getByRole('button', { name: /Second/ }).focus()
    act(() => useSessionStore.setState({ pendingRequests: [first] }))
    // Not onto a line, where a stray key would answer it.
    await vi.waitFor(() => expect(screen.getByRole('complementary', { name: 'Pending requests' })).toHaveFocus())
  })

  it('leaves focus alone when the owner moved it while the last answer was on its way', async () => {
    let release: (ok: boolean) => void = () => {}
    const respond = vi.fn(() => new Promise<boolean>((r) => (release = r)))
    useSessionStore.setState({
      respond,
      pendingRequests: [{ id: 'r1', sessionId: 's1', kind: 'permission', state: 'pending', title: 'Only' }],
    })
    const outside = document.createElement('input')
    document.body.append(outside)
    render(<RequestTray />)
    screen.getByRole('button', { name: /Only/ }).focus()
    await userEvent.keyboard('a')
    outside.focus()
    await act(async () => release(true))
    act(() => useSessionStore.setState({ pendingRequests: [], requestsStatus: 'ready' }))
    expect(outside).toHaveFocus()
    outside.remove()
  })

  it('holds a line while its answer is on its way and keeps focus there', async () => {
    let release: (ok: boolean) => void = () => {}
    const respond = vi.fn(() => new Promise<boolean>((r) => (release = r)))
    useSessionStore.setState({
      respond,
      pendingRequests: [
        { id: 'r1', sessionId: 's1', kind: 'permission', state: 'pending', title: 'First' },
        { id: 'r2', sessionId: 's1', kind: 'permission', state: 'pending', title: 'Second' },
      ],
    })
    render(<RequestTray />)
    const row = screen.getByRole('button', { name: /First/ })
    row.focus()
    await userEvent.keyboard('a')
    await userEvent.keyboard('d')
    expect(respond).toHaveBeenCalledTimes(1)
    expect(row).toHaveFocus()
    const line = row.closest('li')!
    expect(line).toHaveClass('answering')
    expect(line).toHaveAttribute('aria-busy', 'true')
    // the control that sent reads "…ing"; the others are held
    const allow = within(line).getByRole('button', { name: 'Allowing…' })
    expect(allow).toHaveAttribute('aria-busy', 'true')
    expect(within(line).getByRole('button', { name: 'Deny' })).toBeDisabled()
    release(true)
    await vi.waitFor(() => expect(screen.getByRole('button', { name: /Second/ })).toHaveFocus())
  })

  it('names a failed answer on its line and lets the owner retry', async () => {
    const respond = vi.fn(async () => {
      fail("Couldn't send the answer", new Error('agent gone'))
      return false
    })
    useSessionStore.setState({
      respond,
      pendingRequests: [
        { id: 'r1', sessionId: 's1', kind: 'permission', state: 'pending', title: 'First' },
        { id: 'r2', sessionId: 's1', kind: 'permission', state: 'pending', title: 'Second' },
      ],
    })
    render(<RequestTray />)
    const first = screen.getAllByRole('listitem')[0]!
    await userEvent.click(within(first).getByRole('button', { name: 'Allow' }))
    expect(await within(first).findByText("Couldn't send the answer: agent gone")).toBeInTheDocument()
    expect(first).not.toHaveClass('answering')
    expect(within(first).getByRole('button', { name: 'Allow' })).toBeEnabled()
    const row = within(first).getByRole('button', { name: /First/ })
    row.focus()
    await userEvent.keyboard('a')
    expect(respond).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(within(first).getByText("Couldn't send the answer: agent gone")).toBeInTheDocument())
    expect(row).toHaveFocus()
  })

  it('labels elicitations as input', () => {
    useSessionStore.setState({
      pendingRequests: [{ id: 'e1', sessionId: 's1', kind: 'elicitation', state: 'pending', title: 'Need details' }],
    })
    render(<RequestTray />)
    expect(screen.getByText('Input')).toHaveClass('request-kind')
  })

  it('does not answer with keys that only add modifiers', async () => {
    const respond = vi.fn().mockResolvedValue(undefined)
    useSessionStore.setState({
      respond,
      pendingRequests: [{ id: 'r1', sessionId: 's1', kind: 'permission', state: 'pending', title: 'First' }],
    })
    render(<RequestTray />)
    screen.getByRole('button', { name: /First/ }).focus()
    await userEvent.keyboard('{Meta>}a{/Meta}s')
    expect(respond).not.toHaveBeenCalled()
  })

  it('never shows an empty inbox before it loaded', async () => {
    const loadRequests = vi.fn().mockResolvedValue(undefined)
    useSessionStore.setState({ loadRequests })
    const { rerender } = render(<RequestTray />)
    expect(screen.queryByText('No pending requests')).toBeNull()
    expect(screen.getByRole('status', { name: 'loading requests' })).toBeInTheDocument()
    useSessionStore.setState({ requestsStatus: 'error', requestsError: 'go-chamber is not reachable' })
    rerender(<RequestTray />)
    expect(screen.queryByText('No pending requests')).toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load requests: go-chamber is not reachable")
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(loadRequests).toHaveBeenCalledTimes(1)
  })

  it('lists live requests even while the inbox load failed, and says it is incomplete', () => {
    useSessionStore.setState({
      requestsStatus: 'error',
      pendingRequests: [{ id: 'r1', sessionId: 's1', kind: 'permission', state: 'pending', title: 'Run command' }],
    })
    render(<RequestTray />)
    expect(screen.getByText('Run command')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load requests")
  })

  it('names the answer on its way', async () => {
    const respond = vi.fn(() => new Promise<boolean>(() => {}))
    useSessionStore.setState({
      respond,
      requestsStatus: 'ready',
      pendingRequests: [
        { id: 'r1', sessionId: 's1', kind: 'permission', state: 'pending', title: 'First' },
        { id: 'r2', sessionId: 's1', kind: 'permission', state: 'pending', title: 'Second' },
      ],
    })
    render(<RequestTray />)
    const [first, second] = screen.getAllByRole('listitem')
    await userEvent.click(within(first!).getByRole('button', { name: 'Deny' }))
    expect(within(first!).getByRole('button', { name: 'Denying…' })).toHaveAttribute('aria-busy', 'true')
    expect(within(first!).getByRole('button', { name: 'Allow' })).toBeDisabled()
    // the other line is not held
    expect(within(second!).getByRole('button', { name: 'Allow' })).toBeEnabled()
  })

  it('lets go of an answered line that never leaves and says it waits on the agent', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const respond = vi.fn().mockResolvedValue(true)
      useSessionStore.setState({
        respond,
        requestsStatus: 'ready',
        pendingRequests: [{ id: 'r1', sessionId: 's1', kind: 'permission', state: 'pending', title: 'First' }],
      })
      render(<RequestTray />)
      const line = screen.getByRole('listitem')
      await act(async () => {
        within(line).getByRole('button', { name: 'Allow' }).click()
      })
      expect(within(line).getByRole('button', { name: 'Allowing…' })).toBeInTheDocument()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HOLD_TIMEOUT_MS)
      })
      expect(line).not.toHaveClass('answering')
      expect(within(line).getByText('sent · waiting for agent')).toBeInTheDocument()
      expect(within(line).getByRole('button', { name: 'Allow' })).toBeEnabled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves questions to the session, where their options are', () => {
    useSessionStore.setState({
      pendingRequests: [{ id: 'r1', sessionId: 's1', kind: 'question', state: 'pending', title: 'Pick one' }],
    })
    render(<RequestTray />)
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
  })
})

describe('a turn cut off while it waited for the owner', () => {
  const owed = { id: 's2', agent: 'claude' as const, cwd: '/tmp/proj', status: 'interrupted' as const, nativeId: 'n2', title: 'ask me', interruption: { reason: 'server_restart', withRequest: true, request: 'Which branch?' } }

  it('still waits in the inbox, and continues from there', async () => {
    vi.mocked(api.continueSession).mockResolvedValue(undefined as never)
    useSessionStore.setState({ requestsStatus: 'ready', sessions: [owed, { ...owed, id: 's3', interruption: { reason: 'crashed' } }] })
    render(<RequestTray />)
    expect(screen.getByLabelText('Pending requests')).toBeInTheDocument()
    expect(document.querySelector('.section-title .badge')).toHaveTextContent('1')
    const line = screen.getByRole('button', { name: /ask me/ })
    // What it asked leads; the session's name follows; "interrupted" once.
    expect(line.querySelector('.request-label')).toHaveTextContent('Which branch?')
    expect(line.querySelector('.request-session')).toHaveTextContent('ask me')
    expect(line.textContent?.match(/interrupted/gi)).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(api.continueSession).toHaveBeenCalledWith('s2')
    await userEvent.click(line)
    expect(useSessionStore.getState().activeId).toBe('s2')
  })

  it('names the session when it could not continue it', async () => {
    vi.mocked(api.continueSession).mockRejectedValue(new Error('agent gone'))
    useSessionStore.setState({ requestsStatus: 'ready', sessions: [owed] })
    render(<RequestTray />)
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await vi.waitFor(() => expect(useNotices.getState().notices.at(-1)).toMatchObject({ kind: 'error', title: "Couldn't continue the session" }))
  })

  it('says it stopped waiting when the request is not known', () => {
    useSessionStore.setState({ requestsStatus: 'ready', sessions: [{ ...owed, interruption: { reason: 'crashed', withRequest: true } }] })
    render(<RequestTray />)
    const line = screen.getByRole('button', { name: /ask me/ })
    expect(line.querySelector('.request-label')).toHaveTextContent('stopped while waiting for you')
  })

  it('leaves out a session already continued', () => {
    useSessionStore.setState({ requestsStatus: 'ready', sessions: [{ ...owed, status: 'running' }] })
    render(<RequestTray />)
    expect(screen.getByText('No pending requests')).toBeInTheDocument()
  })
})
