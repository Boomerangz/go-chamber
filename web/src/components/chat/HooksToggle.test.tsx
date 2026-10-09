import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import HooksToggle from './HooksToggle'
import { loadLayout, resetLayout } from '../../stores/layout'

beforeEach(() => {
  localStorage.clear()
  resetLayout()
})

describe('HooksToggle', () => {
  it('steps from hooks that spoke to all hooks to none and back, remembering it', async () => {
    render(<HooksToggle />)
    const button = screen.getByRole('button', { name: 'Hooks' })
    expect(button).toHaveAttribute('aria-pressed', 'mixed')
    expect(button).toHaveAttribute('title', expect.stringMatching(/^Hooks that said something/))
    await userEvent.click(button)
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(loadLayout().hooks).toBe('all')
    await userEvent.click(button)
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(loadLayout().hooks).toBe('off')
    await userEvent.click(button)
    expect(loadLayout().hooks).toBe('some')
  })
})
