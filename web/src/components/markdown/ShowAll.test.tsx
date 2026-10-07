import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ShowAll from './ShowAll'

const clip = (over: Partial<{ clipped: boolean; full: boolean }> = {}) => ({ clipped: true, full: false, setFull: vi.fn(), ...over })

describe('ShowAll', () => {
  it('counts the lines it will show, grouped by thousands', () => {
    render(<ShowAll clip={clip()} lines={10000} />)
    expect(screen.getByRole('button')).toHaveTextContent('show all 10,000 lines')
  })

  it('says just "show all" for one long wrapped line', () => {
    render(<ShowAll clip={clip()} lines={1} />)
    expect(screen.getByRole('button')).toHaveTextContent(/^show all$/)
  })

  it('offers to show less once shown whole, and hides when nothing is cut', () => {
    const c = clip({ full: true })
    const { rerender } = render(<ShowAll clip={c} lines={40} />)
    fireEvent.click(screen.getByRole('button', { name: 'show less' }))
    expect(c.setFull).toHaveBeenCalledWith(false)
    rerender(<ShowAll clip={clip({ clipped: false })} lines={40} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
