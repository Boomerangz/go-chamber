import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import InterruptedBanner from './InterruptedBanner'
import type { Session } from '../../lib/api'

const base: Session = { id: 's1', agent: 'claude', cwd: '/p', status: 'interrupted', nativeId: 'n1' }

function setup(session: Session) {
  const onContinue = vi.fn()
  const onAutoContinue = vi.fn()
  render(<InterruptedBanner session={session} onContinue={onContinue} onAutoContinue={onAutoContinue} />)
  return { onContinue, onAutoContinue }
}

describe('InterruptedBanner', () => {
  it('continues a crashed turn', async () => {
    const { onContinue } = setup({ ...base, interruption: { reason: 'crashed' } })
    expect(screen.getByText(/exited unexpectedly/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onContinue).toHaveBeenCalled()
    expect(screen.queryByLabelText('Continue after reset')).toBeNull()
  })

  it('offers to continue after a quota reset', async () => {
    const resumeAfter = '2026-09-28T18:00:00Z'
    const { onAutoContinue } = setup({ ...base, interruption: { reason: 'quota', resumeAfter } })
    expect(screen.getByText(new RegExp(new Date(resumeAfter).toLocaleTimeString()))).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('Continue after reset'))
    expect(onAutoContinue).toHaveBeenCalledWith(true)
  })

  it('shows a scheduled auto-continue as checked and cancels it', async () => {
    const { onAutoContinue } = setup({
      ...base, autoContinue: true, interruption: { reason: 'quota', resumeAfter: '2026-09-28T18:00:00Z' },
    })
    const toggle = screen.getByLabelText('Continue after reset')
    expect(toggle).toBeChecked()
    await userEvent.click(toggle)
    expect(onAutoContinue).toHaveBeenCalledWith(false)
  })

  it('has nothing to continue before the first turn', () => {
    setup({ ...base, nativeId: undefined, interruption: { reason: 'crashed' } })
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
  })
})
