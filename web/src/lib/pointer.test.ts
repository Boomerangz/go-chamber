import { afterEach, describe, expect, it, vi } from 'vitest'
import { touchScreen } from './pointer'

const media = window.matchMedia

afterEach(() => {
  window.matchMedia = media
})

describe('touchScreen', () => {
  it('is true only for a coarse pointer that cannot hover', () => {
    window.matchMedia = vi.fn((q: string) => ({ matches: q.includes('coarse') && q.includes('hover: none') })) as never
    expect(touchScreen()).toBe(true)
    window.matchMedia = vi.fn(() => ({ matches: false })) as never
    expect(touchScreen()).toBe(false)
  })

  it('is false where the browser cannot tell', () => {
    window.matchMedia = undefined as never
    expect(touchScreen()).toBe(false)
  })
})
