import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../../lib/api'
import { resetStore, useSessionStore } from '../../stores/session'
import SessionList from './SessionList'

beforeEach(() => {
  resetStore()
  useSessionStore.setState({ searchMessages: vi.fn(async () => {}) })
})

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
