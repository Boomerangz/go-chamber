import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, SessionRequest } from '../../lib/api'
import { resetStore, useSessionStore } from '../../stores/session'
import EmptyChat from './EmptyChat'

const s = (id: string, activeAt: string, title = id): Session => ({ id, agent: 'claude', cwd: '/p', status: 'idle', title, activeAt })
const req = (sessionId: string, id = `r-${sessionId}`): SessionRequest => ({ id, sessionId, kind: 'permission', state: 'pending' })

beforeEach(() => {
  vi.stubGlobal('WebSocket', undefined)
  resetStore()
})

describe('EmptyChat', () => {
  it('lists the sessions waiting for the owner first', async () => {
    const selectSession = vi.fn(async () => {})
    useSessionStore.setState({
      sessions: [s('a', '2026-10-01T10:00:00Z'), s('b', '2026-10-02T10:00:00Z')],
      pendingRequests: [req('a'), req('a', 'r2')],
      selectSession,
    })
    render(<EmptyChat />)
    expect(screen.getByRole('heading', { name: 'Waiting for you' })).toBeInTheDocument()
    const links = screen.getAllByRole('button')
    expect(links.map((b) => b.textContent)).toEqual(['a'])
    await userEvent.click(links[0]!)
    expect(selectSession).toHaveBeenCalledWith('a')
  })

  it('otherwise offers the five most recent sessions', () => {
    useSessionStore.setState({
      sessions: ['1', '2', '3', '4', '5', '6'].map((n) => s(n, `2026-10-0${n}T10:00:00Z`)),
    })
    render(<EmptyChat />)
    expect(screen.getByRole('heading', { name: 'Recent' })).toBeInTheDocument()
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['6', '5', '4', '3', '2'])
  })

  it('names the shortcuts', () => {
    render(<EmptyChat />)
    expect(screen.getByText('quick switch')).toBeInTheDocument()
    expect(screen.getByText('shortcuts')).toBeInTheDocument()
  })

  it('holds the list with placeholder rows while sessions load', () => {
    useSessionStore.setState({ sessions: [], sessionsStatus: 'loading' })
    render(<EmptyChat />)
    expect(screen.getByRole('status', { name: 'loading sessions' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Recent' })).toBeNull()
  })

  it('shows no placeholder once the list loaded empty', () => {
    useSessionStore.setState({ sessions: [], sessionsStatus: 'ready' })
    render(<EmptyChat />)
    expect(screen.queryByRole('status', { name: 'loading sessions' })).toBeNull()
  })
})
