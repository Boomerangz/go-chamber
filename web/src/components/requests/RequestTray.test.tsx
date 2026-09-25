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
  it('renders nothing without pending requests', () => {
    render(<RequestTray />)
    expect(screen.queryByLabelText('Pending requests')).toBeNull()
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
  })
})
