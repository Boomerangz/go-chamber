import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../../lib/api'
import { resetStore, useSessionStore } from '../../stores/session'
import SessionList from './SessionList'
import { markEnded, markVisited, resetVisits } from '../../lib/visits'

beforeEach(() => {
  localStorage.clear()
  resetVisits()
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

  it('says the open session failed, as its header does', () => {
    useSessionStore.setState({ sessions: [session('s1', 'Work')], activeId: 's1' })
    useSessionStore.setState((s) => ({ chat: { ...s.chat, lastTurnFailed: true } }))
    render(<SessionList onCreateIn={() => {}} />)
    expect(screen.getByText('failed')).toHaveClass('session-status-failed')
  })

  it('draws a session that never ran as idle, not detached', () => {
    useSessionStore.setState({ sessions: [{ ...session('s1', 'New'), status: 'detached' }] })
    render(<SessionList onCreateIn={() => {}} />)
    expect(document.querySelector('.session-status-detached')).toBeNull()
    expect(document.querySelector('.session-status-idle')).toHaveAccessibleName('idle')
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
    useSessionStore.setState({ sessionsStatus: 'error', sessionsError: 'database is locked', loadSessions })
    render(<SessionList onCreateIn={() => {}} />)
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load sessions: database is locked")
    expect(screen.queryByText('No sessions yet')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(loadSessions).toHaveBeenCalled()
  })

  it('still says the list failed while only the open session is known', () => {
    useSessionStore.setState({
      sessionsStatus: 'error',
      sessionsError: 'database is locked',
      activeId: 'a',
      sessions: [{ id: 'a', agent: 'claude', cwd: '/src/app', status: 'idle' }],
    })
    render(<SessionList onCreateIn={() => {}} />)
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load sessions: database is locked")
  })

  it('says when only archived sessions match, instead of nothing or "no match"', () => {
    useSessionStore.setState({
      query: 'deploy',
      sessions: [{ ...session('a', 'deploy notes'), archivedAt: '2026-10-01T09:00:00Z' }, session('b', 'other')],
      // the server's message hit for the archived session is shown in Archived
      searchHits: [{ sessionId: 'a', snippet: 'deploy it', item: 'i1' }] as never,
    })
    render(<SessionList onCreateIn={() => {}} />)
    expect(screen.queryByText('No matching sessions')).toBeNull()
    expect(screen.getByText('Only archived sessions match')).toBeInTheDocument()
  })

  it('says nothing matches when an archived session doesn’t either', () => {
    useSessionStore.setState({ query: 'zzz', sessions: [{ ...session('a', 'deploy notes'), archivedAt: '2026-10-01T09:00:00Z' }] })
    render(<SessionList onCreateIn={() => {}} />)
    expect(screen.getByText('No matching sessions')).toBeInTheDocument()
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
    const input = screen.getByLabelText('Search sessions')
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

  it('scrolls the open session into view when it changes', async () => {
    useSessionStore.setState({ sessions: [session('s1', 'One'), session('s2', 'Two')], activeId: 's1' })
    render(<SessionList onCreateIn={() => {}} />)
    vi.mocked(Element.prototype.scrollIntoView).mockClear()
    act(() => useSessionStore.setState({ activeId: 's2' }))
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' }))
  })

  it('scrolls a session opened while the list was hidden once its pane shows', async () => {
    let visible = false
    const proto = Element.prototype as { checkVisibility?: () => boolean }
    proto.checkVisibility = () => visible
    try {
      useSessionStore.setState({ sessions: [session('s1', 'One'), session('s2', 'Two')], activeId: 's2', pane: 'chat' })
      render(<SessionList onCreateIn={() => {}} />)
      await new Promise((r) => requestAnimationFrame(r))
      vi.mocked(Element.prototype.scrollIntoView).mockClear()
      visible = true
      act(() => useSessionStore.setState({ pane: 'sessions' }))
      await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1))
      // once there, switching panes leaves the list where the owner put it
      act(() => useSessionStore.setState({ pane: 'chat' }))
      act(() => useSessionStore.setState({ pane: 'sessions' }))
      await new Promise((r) => requestAnimationFrame(r))
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1)
    } finally {
      delete proto.checkVisibility
    }
  })

  it('scrolls the open session back into view while the list settles, until the owner scrolls', async () => {
    let resized = () => {}
    const observed: Element[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          resized = cb
        }
        observe(el: Element) {
          observed.push(el)
        }
        disconnect() {
          resized = () => {}
        }
      },
    )
    try {
      useSessionStore.setState({ sessions: [session('s1', 'One'), session('s2', 'Two')], activeId: 's1' })
      render(
        <div data-testid="scroller" style={{ overflowY: 'auto' }}>
          <SessionList onCreateIn={() => {}} />
        </div>,
      )
      act(() => useSessionStore.setState({ activeId: 's2' }))
      await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled())
      const scroller = screen.getByTestId('scroller')
      expect(observed).toContain(scroller)
      // the footer loads below and the list shrinks: the row is put back in view
      vi.mocked(Element.prototype.scrollIntoView).mockClear()
      resized()
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
      // once the owner scrolls, the list stays where they put it
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
      vi.mocked(Element.prototype.scrollIntoView).mockClear()
      resized()
      expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
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

describe('what changed while you were away', () => {
  it('marks a row whose activity is later than your last visit, and counts it on the group', () => {
    markVisited({ ...session('s1', 'One'), activeAt: '2026-10-06T10:00:00Z' })
    useSessionStore.setState({ sessions: [{ ...session('s1', 'One'), activeAt: '2026-10-06T11:00:00Z' }, session('s2', 'Two')] })
    render(<SessionList onCreateIn={() => {}} />)
    const row = screen.getByText('One').closest('button')!
    expect(row.querySelector('.session-unseen')).toHaveTextContent('new')
    expect(screen.getByText('Two').closest('button')!.querySelector('.session-unseen')).toBeNull()
    expect(screen.getByTitle('1 changed since you last looked')).toHaveTextContent('1 new')
  })

  it('marks a session whose turn ended while you looked elsewhere', () => {
    markEnded('s1')
    useSessionStore.setState({ sessions: [session('s1', 'One')] })
    render(<SessionList onCreateIn={() => {}} />)
    expect(screen.getByText('One').closest('button')!.querySelector('.session-unseen')).toHaveTextContent('new')
  })

  it('does not mark the open session', () => {
    markVisited({ ...session('s1', 'One'), activeAt: '2026-10-06T10:00:00Z' })
    useSessionStore.setState({ activeId: 's1', sessions: [{ ...session('s1', 'One'), activeAt: '2026-10-06T11:00:00Z' }] })
    render(<SessionList onCreateIn={() => {}} />)
    expect(document.querySelector('.session-unseen')).toBeNull()
  })
})

describe('state on the row', () => {
  it('does not list a session again under "In messages" when its title already matched', () => {
    useSessionStore.setState({
      query: 'needle',
      sessions: [session('s1', 'needle work'), session('s2', 'Other')],
      searchHits: [
        { sessionId: 's1', itemId: 'i1', snippet: 'a [[needle]] here', matches: 1 },
        { sessionId: 's2', itemId: 'i2', snippet: 'one [[needle]] too', matches: 1 },
      ],
    })
    render(<SessionList onCreateIn={() => {}} />)
    const hits = screen.getByRole('region', { name: 'Message matches' })
    expect([...hits.querySelectorAll('.session-title')].map((e) => e.textContent)).toEqual(['Other'])
    expect(screen.getAllByText('needle work')).toHaveLength(1)
  })

  it('draws an idle session with the hollow mark', () => {
    useSessionStore.setState({ sessions: [session('s1', 'One')] })
    render(<SessionList onCreateIn={() => {}} />)
    const mark = document.querySelector('.session-status-idle')!
    expect(mark).toBeInTheDocument()
    expect(mark).toHaveAccessibleName('idle')
  })

  it('keeps the request count beside the state, clear of the row menu', () => {
    useSessionStore.setState({
      sessions: [session('s2', 'Asks')],
      pendingRequests: [{ id: 'r1', sessionId: 's2', kind: 'permission' } as never],
    })
    render(<SessionList onCreateIn={() => {}} />)
    const meta = screen.getByText('Asks').closest('button')!.querySelector('.session-meta')!
    expect(meta.querySelector('.badge')).toHaveTextContent('1')
  })

  it('draws a detached session with the dashed mark', () => {
    useSessionStore.setState({ sessions: [{ ...session('s1', 'One'), status: 'detached', nativeId: 'n1' }] })
    render(<SessionList onCreateIn={() => {}} />)
    const mark = document.querySelector('.session-status-detached')!
    expect(mark).toBeInTheDocument()
    expect(mark).toHaveAccessibleName(/detached/)
  })

  it('says a session is waiting for you, and lists it first in its group', () => {
    useSessionStore.setState({
      sessions: [
        { ...session('s1', 'Newest'), activeAt: '2026-10-06T11:00:00Z' },
        { ...session('s2', 'Asks'), activeAt: '2026-10-01T11:00:00Z' },
      ],
      pendingRequests: [{ id: 'r1', sessionId: 's2', kind: 'permission' } as never],
    })
    render(<SessionList onCreateIn={() => {}} />)
    const titles = [...document.querySelectorAll('.session-title')].map((e) => e.textContent)
    expect(titles).toEqual(['Asks', 'Newest'])
    expect(screen.getByText('Asks').closest('button')).toHaveTextContent('waiting for you')
  })

  it('still says waiting for you when a restart cut off a turn that was asking', () => {
    useSessionStore.setState({
      sessions: [
        { ...session('s1', 'Newest'), activeAt: '2026-10-06T11:00:00Z' },
        { ...session('s2', 'Was asking'), status: 'interrupted', nativeId: 'n2', interruption: { withRequest: true }, activeAt: '2026-10-01T11:00:00Z' },
      ],
    })
    render(<SessionList onCreateIn={() => {}} />)
    const titles = [...document.querySelectorAll('.session-title')].map((e) => e.textContent)
    expect(titles).toEqual(['Was asking', 'Newest'])
    expect(screen.getByText('Was asking').closest('button')).toHaveTextContent('waiting for you')
  })
})

describe('search failures and busy buttons', () => {
  it('says a failed message search failed, with a retry', async () => {
    const searchMessages = vi.fn(async () => {})
    useSessionStore.setState({ query: 'zzz', searchError: 'boom', searchMessages })
    render(<SessionList onCreateIn={() => {}} />)
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't search messages: boom")
    expect(screen.queryByText('No matching sessions')).toBeNull()
    searchMessages.mockClear()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(searchMessages).toHaveBeenCalledWith('zzz')
  })

  it('marks busy only the "+" that is starting a session', () => {
    useSessionStore.setState({ sessions: [session('s1', 'One'), { ...session('s2', 'Two'), cwd: '/q' }] })
    render(<SessionList creating creatingIn="/q" onCreateIn={() => {}} />)
    expect(screen.getByRole('button', { name: 'New Claude session in /q' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'New Claude session in /p' })).not.toHaveAttribute('aria-busy')
  })
})

describe('worktree sessions', () => {
  it('sit in their repository’s group, named by their branch', () => {
    const wt = {
      ...session('w', 'Fix the readme'),
      cwd: '/data/worktrees/p/fix-readme',
      worktree: { repo: '/p', path: '/data/worktrees/p/fix-readme', branch: 'chamber/fix-readme', base: 'main' },
    }
    useSessionStore.setState({ sessions: [session('s1', 'One'), wt] })
    render(<SessionList onCreateIn={() => {}} />)
    expect(screen.getAllByRole('region')).toHaveLength(1)
    const row = screen.getByRole('button', { name: /^Fix the readme/ })
    const tag = row.querySelector('.session-branch')!
    expect(tag).toHaveTextContent('fix-readme')
    expect(tag).toHaveAttribute('title', expect.stringContaining('chamber/fix-readme'))
  })

  it('stay in their repository’s group once the worktree is removed, marked so', () => {
    const wt = {
      ...session('w', 'Fix the readme'),
      cwd: '/data/worktrees/p/fix-readme',
      worktree: { repo: '/p', path: '/data/worktrees/p/fix-readme', branch: 'chamber/fix-readme', base: 'main', removed: true },
    }
    useSessionStore.setState({ sessions: [session('s1', 'One'), wt] })
    render(<SessionList onCreateIn={() => {}} />)
    expect(screen.getAllByRole('region')).toHaveLength(1)
    const tag = screen.getByRole('button', { name: /^Fix the readme/ }).querySelector('.session-branch')!
    expect(tag).toHaveAttribute('data-removed')
    expect(tag).toHaveAttribute('title', 'Worktree removed · branch chamber/fix-readme kept')
  })
})

describe('a gone folder', () => {
  it('offers no new session in its group and marks its rows gone', () => {
    useSessionStore.setState({ sessions: [
      { ...session('a', 'Lost work'), cwd: '/work/doomed', folderGone: true, status: 'detached' },
      { ...session('b', 'Fine work'), cwd: '/work/fine', status: 'detached' },
    ] })
    render(<SessionList onCreateIn={() => {}} />)
    expect(screen.queryByRole('button', { name: 'New Claude session in /work/doomed' })).toBeNull()
    expect(screen.getByRole('button', { name: 'New Claude session in /work/fine' })).toBeInTheDocument()
    const lost = screen.getByRole('button', { name: /^Lost work/ })
    expect(lost.querySelector('.session-gone')).toHaveAttribute('title', 'Folder /work/doomed no longer exists')
    expect(screen.getByRole('button', { name: /^Fine work/ }).querySelector('.session-gone')).toBeNull()
  })
})
