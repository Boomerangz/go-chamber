import { describe, expect, it } from 'vitest'
import { DURATION, EASE_OUT, SPRING, enter, settle } from './motion'

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

  it('springs a request in from the margin with a slight overshoot', () => {
    const m = enter(false, 'margin')
    expect(m.initial).toEqual({ opacity: 0, x: -16 })
    expect(m.animate).toEqual({ opacity: 1, x: 0 })
    expect(m.transition).toEqual(SPRING)
    expect(enter(true, 'margin').initial).toEqual({ opacity: 0 })
    expect(enter(true, 'margin').transition).toEqual({ duration: DURATION.fast, ease: 'linear' })
  })
})

describe('settle', () => {
  it('springs layout changes into place', () => {
    expect(settle(false)).toEqual(SPRING)
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

  it('keeps the spring short and its overshoot slight', () => {
    expect(SPRING.type).toBe('spring')
    expect(SPRING.visualDuration).toBeLessThanOrEqual(0.35)
    expect(SPRING.bounce).toBeGreaterThan(0)
    expect(SPRING.bounce).toBeLessThanOrEqual(0.3)
  })
})
