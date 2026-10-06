import { describe, expect, it } from 'vitest'
import { formatUptime, linkMark, metricLevel, terminalName } from './format'

describe('formatUptime', () => {
  it('reads as hours and minutes', () => {
    expect(formatUptime(42)).toBe('0m')
    expect(formatUptime(12 * 60 + 5)).toBe('12m')
    expect(formatUptime(3600 + 12 * 60)).toBe('1h 12m')
    expect(formatUptime(3 * 86400 + 2 * 3600)).toBe('3d 2h')
  })
})

describe('metricLevel', () => {
  it('reads a p95 as quiet, elevated or bad, with a remedy past quiet', () => {
    expect(metricLevel('http', null)).toEqual({ level: 'none' })
    expect(metricLevel('http', 40)).toEqual({ level: 'quiet' })
    expect(metricLevel('http', 300)).toMatchObject({ level: 'elevated', remedy: expect.any(String) })
    expect(metricLevel('http', 900)).toMatchObject({ level: 'bad', remedy: expect.any(String) })
    expect(metricLevel('eventLoop', 60).level).toBe('elevated')
    expect(metricLevel('terminalParse', 10).level).toBe('quiet')
  })
})

describe('terminalName', () => {
  it('names a terminal by its title, else its folder, else a short id', () => {
    expect(terminalName('abcdef123456', { title: 'logs', cwd: '/srv/api' })).toBe('logs')
    expect(terminalName('abcdef123456', { title: '', cwd: '/srv/api/' })).toBe('api')
    expect(terminalName('abcdef123456', undefined)).toBe('abcdef12')
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
