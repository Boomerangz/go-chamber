import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import RequestTray from './RequestTray'
import { resetStore, useSessionStore } from '../../stores/session'

vi.mock('../../lib/api', () => ({
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
    render(<RequestTray />)
    expect(screen.queryByLabelText('Pending requests')).toBeNull()
    expect(screen.getByText('No pending requests')).toBeInTheDocument()
  })

  it('names the session a request belongs to', () => {
    useSessionStore.setState({
      sessions: [{ id: 's1', agent: 'codex', cwd: '/tmp/proj', status: 'running' }],
      pendingRequests: [{ id: 'r1', sessionId: 's1', kind: 'question', state: 'pending', title: 'Pick one' }],
    })
    render(<RequestTray />)
    expect(screen.getByRole('button', { name: /Pick one/ })).toHaveTextContent('proj')
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
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(respond).toHaveBeenCalledWith('s1', 'r1', { behavior: 'deny' })
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
    const respond = vi.fn().mockResolvedValue(undefined)
    useSessionStore.setState({
      respond,
      sessions: [
        { id: 's1', agent: 'codex', cwd: '/tmp/one', status: 'running' },
        { id: 's2', agent: 'claude', cwd: '/tmp/two', status: 'running' },
      ],
      pendingRequests: [
        { id: 'r1', sessionId: 's1', kind: 'permission', state: 'pending', title: 'First' },
        { id: 'r1', sessionId: 's2', kind: 'permission', state: 'pending', title: 'Second' },
      ],
    })
    render(<RequestTray />)
    screen.getByRole('button', { name: /First/ }).focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('button', { name: /Second/ })).toHaveFocus()
    await userEvent.keyboard('d')
    expect(respond).toHaveBeenLastCalledWith('s2', 'r1', { behavior: 'deny' })
    // the last line answered: focus steps back to the one above
    expect(screen.getByRole('button', { name: /First/ })).toHaveFocus()
    await userEvent.keyboard('s')
    expect(respond).toHaveBeenLastCalledWith('s1', 'r1', { behavior: 'allow', allowForSession: true })
    // answered: focus moves on to the next line, ready for the next key
    expect(screen.getByRole('button', { name: /Second/ })).toHaveFocus()
    await userEvent.keyboard('a')
    expect(respond).toHaveBeenLastCalledWith('s2', 'r1', { behavior: 'allow' })
    expect(respond).toHaveBeenCalledTimes(3)
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

  it('leaves questions to the session, where their options are', () => {
    useSessionStore.setState({
      pendingRequests: [{ id: 'r1', sessionId: 's1', kind: 'question', state: 'pending', title: 'Pick one' }],
    })
    render(<RequestTray />)
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
  })
})
