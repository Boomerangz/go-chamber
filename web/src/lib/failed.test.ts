import { describe, expect, it } from 'vitest'
import { failedTo } from './failed'

describe('failedTo', () => {
  it('says what failed and why, in one form', () => {
    expect(failedTo('load sessions', 'database is locked')).toBe("Couldn't load sessions: database is locked")
  })

  it('leaves the reason out when there is none', () => {
    expect(failedTo('load sessions', null)).toBe("Couldn't load sessions")
    expect(failedTo('load sessions', '')).toBe("Couldn't load sessions")
  })
})
