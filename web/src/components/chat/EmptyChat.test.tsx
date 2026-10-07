import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, SessionRequest } from '../../lib/api'
import { resetStore, useSessionStore } from '../../stores/session'
import EmptyChat from './EmptyChat'
import { resetLayout, useLayoutStore } from '../../stores/layout'

const s = (id: string, activeAt: string, title = id): Session => ({ id, agent: 'claude', cwd: '/p', status: 'idle', title, activeAt })
// titles are the session names the list shows, without their folder and age.
const titles = () => screen.getAllByRole('button').map((b) => b.querySelector('.empty-session-title')?.textContent ?? b.textContent)
const req = (sessionId: string, id = `r-${sessionId}`): SessionRequest => ({ id, sessionId, kind: 'permission', state: 'pending' })

beforeEach(() => {
  vi.stubGlobal('WebSocket', undefined)
  resetStore()
  resetLayout()
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
    expect(titles()).toEqual(['a'])
    await userEvent.click(links[0]!)
    expect(selectSession).toHaveBeenCalledWith('a')
  })

  it('counts a turn cut off with a question open as waiting', () => {
    const cut: Session = { ...s('c', '2026-10-01T10:00:00Z'), status: 'interrupted', interruption: { reason: 'server_restart', withRequest: true } }
    useSessionStore.setState({ sessions: [s('b', '2026-10-02T10:00:00Z'), cut] })
    render(<EmptyChat />)
    expect(screen.getByRole('heading', { name: 'Waiting for you' })).toBeInTheDocument()
    expect(titles()).toEqual(['c'])
  })

  it('lists waiting sessions in a steady order, the longest waiting first, with how many more', async () => {
    const days = ['01', '02', '03', '04', '05', '06', '07']
    useSessionStore.setState({
      sessions: days.map((d) => s(`s${d}`, `2026-10-${d}T10:00:00Z`)),
      // the server's order of requests says nothing about who waited longest
      pendingRequests: ['s05', 's02', 's07', 's01', 's03', 's06', 's04'].map((id) => req(id)),
    })
    render(<EmptyChat />)
    expect(titles()).toEqual(['s01', 's02', 's03', 's04', 's05', '+2 more'])
    await userEvent.click(screen.getByRole('button', { name: '+2 more' }))
    expect(useLayoutStore.getState().dock).toBe('requests')
  })

  it('otherwise offers the five most recent sessions', () => {
    useSessionStore.setState({
      sessions: ['1', '2', '3', '4', '5', '6'].map((n) => s(n, `2026-10-0${n}T10:00:00Z`)),
    })
    render(<EmptyChat />)
    expect(screen.getByRole('heading', { name: 'Recent' })).toBeInTheDocument()
    expect(titles()).toEqual(['6', '5', '4', '3', '2'])
  })

  // Five rows all called "New Claude session" said nothing: each now names
  // its folder (or its worktree's repo and branch) and its age.
  it('tells alike sessions apart by folder, branch and age', () => {
    vi.useFakeTimers({ now: new Date('2026-10-07T12:00:00Z'), toFake: ['Date'] })
    useSessionStore.setState({
      sessions: [
        { id: 'a', agent: 'claude', cwd: '/w/api', status: 'idle', activeAt: '2026-10-07T10:00:00Z' },
        { id: 'b', agent: 'claude', cwd: '/w/web', status: 'idle', activeAt: '2026-10-07T11:30:00Z' },
        {
          id: 'c', agent: 'claude', cwd: '/w/api-fix', status: 'idle', activeAt: '2026-10-04T12:00:00Z',
          worktree: { repo: '/w/api', path: '/w/api-fix', branch: 'chamber/fix-x', base: 'main' },
        },
      ],
    })
    render(<EmptyChat />)
    vi.useRealTimers()
    const rows = screen.getAllByRole('button').map((b) => b.querySelector('.empty-session-meta')?.textContent)
    expect(rows).toEqual(['web30m ago', 'api2h ago', 'api⎇ fix-x3d ago'])
    expect(screen.getByText('web')).toHaveAttribute('title', '/w/web')
  })

  it('leaves archived sessions out of the recent ones', () => {
    useSessionStore.setState({
      sessions: [s('kept', '2026-10-01T10:00:00Z'), { ...s('away', '2026-10-02T10:00:00Z'), archivedAt: '2026-10-03T10:00:00Z' }],
    })
    render(<EmptyChat />)
    expect(titles()).toEqual(['kept'])
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
