import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { LoadFailed } from './Loading'

describe('LoadFailed', () => {
  it('keeps Retry with the last word of the reason, so it never wraps alone', async () => {
    const onRetry = vi.fn()
    render(<LoadFailed onRetry={onRetry}>{"Couldn't load sessions: database is locked"}</LoadFailed>)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent("Couldn't load sessions: database is lockedRetry")
    const tail = alert.querySelector('.load-failed-tail')!
    expect(tail.textContent).toBe('lockedRetry')
    expect(tail.querySelector('button')).toBe(screen.getByRole('button', { name: 'Retry' }))
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalled()
  })

  it('shows just the text without a retry', () => {
    render(<LoadFailed>{"Couldn't load"}</LoadFailed>)
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load")
    expect(screen.queryByRole('button')).toBeNull()
  })
})
