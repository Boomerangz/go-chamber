import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../../lib/api'
import { resetStore, useSessionStore } from '../../stores/session'
import SessionList from './SessionList'

beforeEach(() => {
  resetStore()
  useSessionStore.setState({ searchMessages: vi.fn(async () => {}), sessionsStatus: 'ready' })
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => vi.useRealTimers())

const session = (id: string, title: string, parentId?: string): Session => ({
  id, title, parentId, agent: 'claude', cwd: '/p', status: 'idle',
})

describe('session search', () => {
  it('does linear parent lookup work when nothing matches', () => {
    let parentReads = 0
    const sessions = Array.from({ length: 1000 }, (_, i) => ({
      ...session(`s${i}`, `session ${i}`),
      get parentId() { parentReads++; return undefined },
    }))
    useSessionStore.setState({ sessions, query: 'does-not-match' })
    render(<SessionList onCreateIn={() => {}} />)
    expect(screen.getByText('No matching sessions')).toBeInTheDocument()
    expect(parentReads).toBeLessThanOrEqual(sessions.length * 2)
  })

  it('keeps the immediate parent of a matching child and hides other sessions', () => {
    useSessionStore.setState({ query: 'needle', sessions: [
      session('grandparent', 'Grandparent'),
      session('parent', 'Parent', 'grandparent'),
      session('child', 'needle child', 'parent'),
      session('other', 'Other'),
    ] })
    render(<SessionList onCreateIn={() => {}} />)
    expect(screen.getByText('Parent')).toBeInTheDocument()
    expect(screen.getByText('needle child')).toBeInTheDocument()
    expect(screen.queryByText('Grandparent')).toBeNull()
    expect(screen.queryByText('Other')).toBeNull()
  })
})

describe('session status', () => {
  it('marks a session done for a moment when its turn finishes', () => {
    useSessionStore.setState({ sessions: [{ ...session('s1', 'Work'), status: 'running' }] })
    render(<SessionList onCreateIn={() => {}} />)
    expect(screen.getByText('running')).toBeInTheDocument()
    act(() => useSessionStore.setState({ sessions: [session('s1', 'Work')] }))
    expect(screen.getByText('done')).toHaveClass('session-status-done')
  })
})

describe('loading the list', () => {
  it('shows placeholder rows, not "No sessions yet", while loading', () => {
    useSessionStore.setState({ sessionsStatus: 'loading' })
    render(<SessionList onCreateIn={() => {}} />)
    expect(screen.getByRole('status', { name: 'loading sessions' })).toBeInTheDocument()
    expect(screen.queryByText('No sessions yet')).toBeNull()
  })

  it('offers a retry when loading failed', async () => {
    const loadSessions = vi.fn(async () => {})
    useSessionStore.setState({ sessionsStatus: 'error', loadSessions })
    render(<SessionList onCreateIn={() => {}} />)
    expect(screen.getByText("Couldn't load sessions")).toBeInTheDocument()
    expect(screen.queryByText('No sessions yet')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(loadSessions).toHaveBeenCalled()
  })

  it('says the list is empty once it loaded', () => {
    render(<SessionList onCreateIn={() => {}} />)
    expect(screen.getByText('No sessions yet')).toBeInTheDocument()
  })
})

describe('message search', () => {
  it('shows the search in progress before saying nothing matched', () => {
    useSessionStore.setState({ query: 'zzz', searching: true })
    render(<SessionList onCreateIn={() => {}} />)
    expect(screen.getByText('searching messages…')).toBeInTheDocument()
    expect(screen.queryByText('No matching sessions')).toBeNull()
    act(() => useSessionStore.setState({ searching: false }))
    expect(screen.queryByText('searching messages…')).toBeNull()
    expect(screen.getByText('No matching sessions')).toBeInTheDocument()
  })

  it('marks the open session among message matches', () => {
    useSessionStore.setState({
      query: 'needle',
      activeId: 's1',
      sessions: [session('s1', 'Work')],
      searchHits: [{ sessionId: 's1', itemId: 'i1', snippet: 'a [[needle]] here', matches: 1 }],
    })
    render(<SessionList onCreateIn={() => {}} />)
    const hits = screen.getByRole('region', { name: 'Message matches' })
    const row = hits.querySelector('button.session')!
    expect(row).toHaveAttribute('aria-current', 'true')
    expect(row.querySelector('.session-title')).toHaveAttribute('title', 'Work')
  })

  it('clears with the clear button, Escape clears and a second Escape leaves the field', async () => {
    render(<SessionList onCreateIn={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull()
    const input = screen.getByLabelText('search sessions')
    await userEvent.type(input, 'abc')
    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(input).toHaveValue('')
    expect(input).toHaveFocus()
    await userEvent.type(input, 'abc{Escape}')
    expect(input).toHaveValue('')
    expect(input).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(input).not.toHaveFocus()
  })
})

describe('session rows', () => {
  it('puts the full title on truncated text', () => {
    useSessionStore.setState({ sessions: [session('s1', 'A very long title that will not fit')] })
    render(<SessionList onCreateIn={() => {}} />)
    expect(screen.getByText('A very long title that will not fit')).toHaveAttribute('title', 'A very long title that will not fit')
  })

  it('scrolls the open session into view when it changes', () => {
    useSessionStore.setState({ sessions: [session('s1', 'One'), session('s2', 'Two')], activeId: 's1' })
    render(<SessionList onCreateIn={() => {}} />)
    vi.mocked(Element.prototype.scrollIntoView).mockClear()
    act(() => useSessionStore.setState({ activeId: 's2' }))
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('names the agent and folder on the group "+" button', async () => {
    const onCreateIn = vi.fn()
    useSessionStore.setState({ sessions: [session('s1', 'One')] })
    render(<SessionList agent="codex" onCreateIn={onCreateIn} />)
    await userEvent.click(screen.getByRole('button', { name: 'New Codex session in /p' }))
    expect(onCreateIn).toHaveBeenCalledWith('/p')
  })

  it('disables the group "+" buttons while a session is starting', () => {
    useSessionStore.setState({ sessions: [session('s1', 'One')] })
    render(<SessionList creating onCreateIn={() => {}} />)
    expect(screen.getByRole('button', { name: 'New Claude session in /p' })).toBeDisabled()
  })

  it('keeps relative times current', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'))
    useSessionStore.setState({ sessions: [{ ...session('s1', 'One'), activeAt: '2026-10-06T11:58:00Z' }] })
    render(<SessionList onCreateIn={() => {}} />)
    expect(screen.getByText('2m ago')).toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(screen.getByText('3m ago')).toBeInTheDocument()
  })
})
