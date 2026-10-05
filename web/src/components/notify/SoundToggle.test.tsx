import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SoundToggle from './SoundToggle'
import { play, soundOn } from '../../lib/chime'

vi.mock('../../lib/chime', async (orig) => ({ ...(await orig<typeof import('../../lib/chime')>()), play: vi.fn() }))

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
})

describe('SoundToggle', () => {
  it('turns sounds on with a sample chime and off silently', async () => {
    render(<SoundToggle />)
    const button = screen.getByRole('button', { name: 'Sounds' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(button)
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(soundOn()).toBe(true)
    expect(play).toHaveBeenCalledWith('done')
    await userEvent.click(button)
    expect(soundOn()).toBe(false)
    expect(play).toHaveBeenCalledTimes(1)
  })
})
