import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Session } from './api'

vi.mock('./api', () => ({ markSeen: vi.fn() }))

import * as api from './api'
import { flushSeen, isUnseen, needsReport, reportSeen, resetSeenReports, unseenCount } from './visits'

const s = (id: string, extra: Partial<Session> = {}): Session => ({ id, agent: 'claude', cwd: '/p', status: 'idle', ...extra })

beforeEach(() => {
  vi.clearAllMocks()
  resetSeenReports()
  ;(api.markSeen as Mock).mockResolvedValue(undefined)
})
afterEach(() => vi.useRealTimers())

describe('unseen', () => {
  it('marks nothing for a session whose turn never ended', () => {
    expect(isUnseen(s('a', { activeAt: '2026-09-25T10:00:00Z' }))).toBe(false)
  })

  it('marks a turn that ended after the owner last looked, on any device', () => {
    expect(isUnseen(s('a', { endedAt: '2026-09-25T10:05:00Z' }))).toBe(true)
    expect(isUnseen(s('a', { endedAt: '2026-09-25T10:05:00Z', seen: { at: '2026-09-25T10:00:00Z' } }))).toBe(true)
    expect(isUnseen(s('a', { endedAt: '2026-09-25T10:05:00Z', seen: { at: '2026-09-25T10:05:00Z' } }))).toBe(false)
  })

  it('waits for a running turn to end before marking it', () => {
    expect(isUnseen(s('a', { status: 'running', endedAt: '2026-09-25T10:05:00Z' }))).toBe(false)
  })

  it('counts the unseen sessions except the open one', () => {
    const ended = { endedAt: '2026-09-25T10:05:00Z' }
    expect(unseenCount([s('a', ended), s('b', ended), s('c')], 'b')).toBe(1)
  })
})

describe('reporting a look', () => {
  it('asks only when the server does not already know', () => {
    const at = { seen: { item: 'i3', at: '2026-09-25T10:05:00Z' }, endedAt: '2026-09-25T10:05:00Z' }
    expect(needsReport(s('a', at), 'i3')).toBe(false)
    expect(needsReport(s('a', at), undefined)).toBe(false)
    expect(needsReport(s('a', at), 'i4')).toBe(true)
    expect(needsReport(s('a', { ...at, endedAt: '2026-09-25T10:06:00Z' }), undefined)).toBe(true)
    expect(needsReport(s('a'), undefined)).toBe(false)
    expect(needsReport(s('a'), 'i1')).toBe(true)
  })

  it('tells the server once the owner has settled, the latest look winning', async () => {
    vi.useFakeTimers()
    reportSeen('a', 'i1')
    reportSeen('a', 'i2')
    reportSeen('b', undefined)
    expect(api.markSeen).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.markSeen).toHaveBeenCalledTimes(2)
    expect(api.markSeen).toHaveBeenCalledWith('a', 'i2')
    expect(api.markSeen).toHaveBeenCalledWith('b', undefined)
  })

  it('says it at once when the owner leaves', () => {
    vi.useFakeTimers()
    reportSeen('a', 'i1')
    flushSeen('a')
    expect(api.markSeen).toHaveBeenCalledWith('a', 'i1')
    flushSeen('a')
    expect(api.markSeen).toHaveBeenCalledTimes(1)
  })

  it('does not repeat a look the server has not echoed yet', async () => {
    vi.useFakeTimers()
    reportSeen('a', 'i1', '2026-09-25T10:05:00Z')
    await vi.advanceTimersByTimeAsync(1000)
    reportSeen('a', 'i1', '2026-09-25T10:05:00Z')
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.markSeen).toHaveBeenCalledTimes(1)
    // A turn that ended since is worth another word.
    reportSeen('a', 'i1', '2026-09-25T10:06:00Z')
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.markSeen).toHaveBeenCalledTimes(2)
  })

  it('tries again later when the server could not be told', async () => {
    vi.useFakeTimers()
    ;(api.markSeen as Mock).mockRejectedValueOnce(new Error('offline'))
    reportSeen('a', 'i1')
    await vi.advanceTimersByTimeAsync(1000)
    reportSeen('a', 'i1')
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.markSeen).toHaveBeenCalledTimes(2)
  })
})
