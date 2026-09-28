import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as push from '../../lib/push'
import NotifyToggle from './NotifyToggle'

vi.mock('../../lib/push', () => ({
  pushSupported: vi.fn(() => true),
  pushEnabled: vi.fn(async () => false),
  enablePush: vi.fn(async () => {}),
  disablePush: vi.fn(async () => {}),
}))

describe('NotifyToggle', () => {
  beforeEach(() => vi.clearAllMocks())

  it('is hidden where the browser cannot push', () => {
    vi.mocked(push.pushSupported).mockReturnValueOnce(false)
    const { container } = render(<NotifyToggle />)
    expect(container).toBeEmptyDOMElement()
  })

  it('turns notifications on and off', async () => {
    render(<NotifyToggle />)
    const button = await screen.findByRole('button', { name: 'Notifications' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(button)
    expect(push.enablePush).toHaveBeenCalled()
    expect(button).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(button)
    expect(push.disablePush).toHaveBeenCalled()
    expect(button).toHaveAttribute('aria-pressed', 'false')
  })

  it('shows why it could not turn on', async () => {
    vi.mocked(push.enablePush).mockRejectedValueOnce(new Error('Notifications are not allowed in this browser'))
    render(<NotifyToggle />)
    await userEvent.click(await screen.findByRole('button', { name: 'Notifications' }))
    expect(screen.getByRole('button', { name: 'Notifications' })).toHaveAttribute('title', 'Notifications are not allowed in this browser')
  })
})
