import { describe, expect, it } from 'vitest'
import { formatUptime, linkMark } from './format'

describe('formatUptime', () => {
  it('reads as hours and minutes', () => {
    expect(formatUptime(42)).toBe('0m')
    expect(formatUptime(12 * 60 + 5)).toBe('12m')
    expect(formatUptime(3600 + 12 * 60)).toBe('1h 12m')
    expect(formatUptime(3 * 86400 + 2 * 3600)).toBe('3d 2h')
  })
})

describe('linkMark', () => {
  it('draws a connection state as a mark form', () => {
    expect(linkMark('online')).toBe('solid')
    expect(linkMark('connecting')).toBe('dashed')
    expect(linkMark('reconnecting')).toBe('dashed')
    expect(linkMark('offline')).toBe('struck')
    expect(linkMark('timed out')).toBe('struck')
    expect(linkMark('paused')).toBe('hollow')
  })
})
