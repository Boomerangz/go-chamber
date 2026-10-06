import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetStore, useSessionStore } from '../../stores/session'
import type { Session } from '../../lib/api'
import Sidebar from './Sidebar'

vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof import('../../lib/api')>()),
  getAccount: vi.fn(async () => ({ agent: 'claude', loggedIn: true })),
  listHistory: vi.fn(async () => []),
  listFolders: vi.fn(),
}))

beforeEach(() => {
  localStorage.clear()
  resetStore()
  useSessionStore.setState({ searchMessages: vi.fn(async () => {}), sessionsStatus: 'ready' })
  Element.prototype.scrollIntoView = vi.fn()
})

describe('Sidebar with archived sessions', () => {
  it('lists archived sessions apart, each row with its menu', () => {
    const sessions: Session[] = [
      { id: 'a', title: 'Listed', agent: 'claude', cwd: '/src/app', status: 'idle' },
      { id: 'b', title: 'Put away', agent: 'codex', cwd: '/src/app', status: 'idle', archivedAt: '2026-10-05T09:00:00Z' },
    ]
    useSessionStore.setState({ sessions })
    render(<Sidebar sessions={sessions} onCreate={vi.fn(async () => true)} />)
    const project = screen.getByRole('region', { name: 'Project app' })
    expect(within(project).getByRole('button', { name: /^Listed/ })).toBeInTheDocument()
    expect(within(project).queryByText('Put away')).toBeNull()
    expect(within(project).getByRole('button', { name: 'Actions for Listed' })).toBeInTheDocument()
    expect(document.querySelector('.archived summary')).toHaveTextContent('Archived 1')
  })
})
