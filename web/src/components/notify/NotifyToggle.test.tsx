import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as push from '../../lib/push'
import { resetNotices, useNotices } from '../../stores/notices'
import NotifyToggle from './NotifyToggle'

vi.mock('../../lib/push', () => ({
  pushSupported: vi.fn(() => true),
  pushEnabled: vi.fn(async () => false),
  enablePush: vi.fn(async () => {}),
  disablePush: vi.fn(async () => {}),
}))

describe('NotifyToggle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetNotices()
  })

  it('is hidden where the browser cannot push', () => {
    vi.mocked(push.pushSupported).mockReturnValueOnce(false)
    const { container } = render(<NotifyToggle />)
    expect(container).toBeEmptyDOMElement()
  })

  it('turns notifications on and off', async () => {
    render(<NotifyToggle />)
    const button = await screen.findByRole('button', { name: 'Notifications' })
    await waitFor(() => expect(button).toBeEnabled())
    expect(button).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(button)
    expect(push.enablePush).toHaveBeenCalled()
    expect(button).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(button)
    expect(push.disablePush).toHaveBeenCalled()
    expect(button).toHaveAttribute('aria-pressed', 'false')
  })

  it('draws an icon, not an emoji', async () => {
    render(<NotifyToggle />)
    const button = await screen.findByRole('button', { name: 'Notifications' })
    expect(button.querySelector('svg')).not.toBeNull()
    expect(button.textContent).toBe('')
  })

  it('stays disabled until it knows whether push is on, so it never flips', async () => {
    let resolve!: (on: boolean) => void
    vi.mocked(push.pushEnabled).mockReturnValueOnce(new Promise((r) => (resolve = r)))
    render(<NotifyToggle />)
    const button = screen.getByRole('button', { name: 'Notifications' })
    expect(button).toBeDisabled()
    resolve(true)
    await waitFor(() => expect(button).toBeEnabled())
    expect(button).toHaveAttribute('aria-pressed', 'true')
  })

  it('reports why it could not turn on as a notice', async () => {
    vi.mocked(push.enablePush).mockRejectedValueOnce(new Error('Notifications are not allowed in this browser'))
    render(<NotifyToggle />)
    const button = screen.getByRole('button', { name: 'Notifications' })
    await waitFor(() => expect(button).toBeEnabled())
    await userEvent.click(button)
    const notice = useNotices.getState().notices.at(-1)
    expect(notice?.kind).toBe('error')
    expect(notice?.text).toBe('Notifications are not allowed in this browser')
    expect(button).toHaveAttribute('aria-pressed', 'false')
  })
})
