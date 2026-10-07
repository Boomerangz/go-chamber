import { beforeEach, describe, expect, it } from 'vitest'
import { browsedTo, noteBrowse } from './browse'

describe('browse', () => {
  beforeEach(() => void browsedTo(''))

  it('tells, once, that a session was opened by stepping through the list', () => {
    noteBrowse('a')
    expect(browsedTo('a')).toBe(true)
    expect(browsedTo('a')).toBe(false)
  })

  it('does not count for another session', () => {
    noteBrowse('a')
    expect(browsedTo('b')).toBe(false)
  })

  it('counts only the latest step', () => {
    noteBrowse('a')
    noteBrowse('b')
    expect(browsedTo('a')).toBe(false)
  })

  it('is used up by whichever chat opens next', () => {
    noteBrowse('a')
    expect(browsedTo('b')).toBe(false)
    expect(browsedTo('a')).toBe(false)
  })

  it('knows nothing until a step is noted', () => {
    expect(browsedTo('a')).toBe(false)
  })
})
