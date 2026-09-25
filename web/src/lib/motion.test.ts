import { describe, expect, it } from 'vitest'
import { DURATION, EASE_OUT, enter, settle } from './motion'

describe('enter', () => {
  it('settles an item a couple of pixels into place', () => {
    const m = enter(false)
    expect(m.initial).toEqual({ opacity: 0, y: 2 })
    expect(m.animate).toEqual({ opacity: 1, y: 0 })
    expect(m.exit).toEqual({ opacity: 0 })
    expect(m.transition).toEqual({ duration: DURATION.base, ease: EASE_OUT })
  })

  it('drops movement and keeps a short fade under reduced motion', () => {
    const m = enter(true)
    expect(m.initial).toEqual({ opacity: 0 })
    expect(m.animate).toEqual({ opacity: 1 })
    expect(m.transition).toEqual({ duration: DURATION.fast, ease: 'linear' })
  })

  it('can enter from the margin', () => {
    expect(enter(false, 'margin').initial).toEqual({ opacity: 0, x: -12 })
    expect(enter(false, 'margin').animate).toEqual({ opacity: 1, x: 0 })
    expect(enter(true, 'margin').initial).toEqual({ opacity: 0 })
  })
})

describe('settle', () => {
  it('animates layout changes briefly', () => {
    expect(settle(false)).toEqual({ duration: DURATION.base, ease: EASE_OUT })
  })

  it('snaps layout changes under reduced motion', () => {
    expect(settle(true)).toEqual({ duration: 0 })
  })
})

describe('tokens', () => {
  it('keeps product motion within 120–240ms', () => {
    expect(DURATION.fast).toBeGreaterThanOrEqual(0.12)
    expect(DURATION.base).toBeLessThanOrEqual(0.24)
    expect(DURATION.fast).toBeLessThan(DURATION.base)
  })
})
