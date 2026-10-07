import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { resetStore, useSessionStore } from '../../stores/session'
import type { Session } from '../../lib/api'
import ArchivedSessions from './ArchivedSessions'

const s = (id: string, over: Partial<Session> = {}): Session => ({ id, title: id, agent: 'claude', cwd: '/src/app', status: 'idle', ...over })

let selectSession: Mock<(id: string) => Promise<void>>

beforeEach(() => {
  resetStore()
  selectSession = vi.fn(async (_id: string) => {})
  useSessionStore.setState({ selectSession })
})

describe('ArchivedSessions', () => {
  it('keeps waiting work in sight: the count on the fold and the mark on the row', async () => {
    useSessionStore.setState({
      sessions: [s('old', { archivedAt: '2026-10-01T09:00:00Z' }), s('quiet', { archivedAt: '2026-10-02T09:00:00Z' })],
      pendingRequests: [
        { sessionId: 'old', id: 'r1', kind: 'permission' },
        { sessionId: 'old', id: 'r2', kind: 'permission' },
      ] as never,
    })
    render(<ArchivedSessions />)
    const summary = document.querySelector('summary')!
    expect(summary.querySelector('.badge')).toHaveTextContent('2')
    await userEvent.click(summary)
    const row = screen.getByRole('button', { name: /^old/ })
    expect(row).toHaveTextContent('waiting for you')
    expect(row.querySelector('.badge')).toHaveTextContent('2')
    expect(screen.getByRole('button', { name: /^quiet/ })).not.toHaveTextContent('waiting for you')
  })

  it('gives every row its state mark and a meta line, a subagent child included', async () => {
    useSessionStore.setState({
      sessions: [
        s('quiet', { archivedAt: '2026-10-02T09:00:00Z' }),
        s('gone', { status: 'detached', nativeId: 'n1', archivedAt: '2026-10-02T09:00:00Z' }),
        s('kid', { parentId: 'gone', title: 'helper', createdAt: undefined }),
      ],
    })
    render(<ArchivedSessions />)
    await userEvent.click(document.querySelector('summary')!)
    expect(screen.getByRole('button', { name: /^quiet/ }).querySelector('.session-status-idle')).not.toBeNull()
    expect(screen.getByRole('button', { name: /^gone/ }).querySelector('.session-status-detached')).not.toBeNull()
    const kid = screen.getByRole('button', { name: /^helper/ })
    expect(kid.querySelector('.session-meta .session-status')).not.toBeNull()
  })

  it('is not there while nothing is archived', () => {
    useSessionStore.setState({ sessions: [s('a')] })
    const { container } = render(<ArchivedSessions />)
    expect(container).toBeEmptyDOMElement()
  })

  it('folds archived sessions under a count, opened on demand', async () => {
    useSessionStore.setState({
      sessions: [
        s('listed'),
        s('old', { archivedAt: '2026-10-01T09:00:00Z' }),
        s('new', { archivedAt: '2026-10-05T09:00:00Z' }),
        s('sub', { parentId: 'old', title: 'helper' }),
      ],
    })
    render(<ArchivedSessions />)
    const summary = document.querySelector('summary')!
    expect(summary).toHaveTextContent('Archived 2')
    expect(screen.getByRole('group')).not.toHaveAttribute('open')
    await userEvent.click(summary)
    expect(screen.getByRole('group')).toHaveAttribute('open')
    const rows = screen.getAllByRole('button', { name: /^(new|old|helper)/ })
    expect(rows.map((r) => r.querySelector('.session-title')?.textContent)).toEqual(['new', 'old', 'helper'])
    expect(screen.getByRole('button', { name: 'Actions for old' })).toBeInTheDocument()
    await userEvent.click(rows[1]!)
    expect(selectSession).toHaveBeenCalledWith('old')
  })

  it('opens itself when the open session is archived', () => {
    useSessionStore.setState({ sessions: [s('away', { archivedAt: '2026-10-05T09:00:00Z' })], activeId: 'away' })
    render(<ArchivedSessions />)
    expect(screen.getByRole('group')).toHaveAttribute('open')
    expect(screen.getByRole('button', { name: /^away/ })).toHaveAttribute('aria-current', 'true')
  })

  it('while searching, lists only the archived sessions that match, unfolded', () => {
    useSessionStore.setState({
      query: 'deploy',
      sessions: [s('deploy notes', { archivedAt: '2026-10-01T09:00:00Z' }), s('other', { archivedAt: '2026-10-02T09:00:00Z' })],
    })
    render(<ArchivedSessions />)
    expect(screen.getByRole('group')).toHaveAttribute('open')
    expect(document.querySelector('summary .group-count')).toHaveTextContent('1')
    expect(screen.getByRole('button', { name: /^deploy notes/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^other/ })).toBeNull()
  })

  it('is not there while a search matches nothing archived', () => {
    useSessionStore.setState({ query: 'zzz', sessions: [s('old', { archivedAt: '2026-10-01T09:00:00Z' })] })
    const { container } = render(<ArchivedSessions />)
    expect(container).toBeEmptyDOMElement()
  })
})
