import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Session, SessionRequest } from '../../lib/api'
import { useSessionStore } from '../../stores/session'
import OverviewToggle from './OverviewToggle'

const s = (id: string, status: Session['status']) => ({ id, status }) as Session
const initial = useSessionStore.getState()
afterEach(() => useSessionStore.setState(initial, true))

it('is named Overview and reads the fleet beside its word', () => {
  useSessionStore.setState({ sessions: [s('a', 'running'), s('b', 'running'), s('c', 'idle')], pendingRequests: [{ id: 'r', sessionId: 'b' } as SessionRequest] })
  const onClick = vi.fn()
  render(<OverviewToggle pressed={false} onClick={onClick} />)
  const button = screen.getByRole('button', { name: 'Overview' })
  expect(button).toHaveAccessibleDescription('1 running · 1 waiting')
  expect(button).toHaveAttribute('aria-pressed', 'false')
  fireEvent.click(button)
  expect(onClick).toHaveBeenCalledTimes(1)
})

it('shows no fleet line when nothing runs or waits', () => {
  useSessionStore.setState({ sessions: [s('c', 'idle')], pendingRequests: [] })
  const { container } = render(<OverviewToggle pressed onClick={() => {}} />)
  expect(container.querySelector('.fleet')).toBeNull()
  expect(screen.getByRole('button', { name: 'Overview' })).not.toHaveAttribute('aria-describedby')
})
