import { describe, expect, it } from 'vitest'
import { basename, displayStatus, resetLabel, windowLabel } from './format'
import { initialChat } from './events'

describe('windowLabel', () => {
  it('uses the window duration when the agent reports one', () => {
    expect(windowLabel({ name: 'primary', usedPct: 1, status: '300m' })).toBe('5h window')
    expect(windowLabel({ name: 'secondary', usedPct: 1, status: '10080m' })).toBe('7d window')
    expect(windowLabel({ name: 'primary', usedPct: 1, status: '45m' })).toBe('45m window')
    expect(windowLabel({ name: 'primary', usedPct: 1, status: '90m' })).toBe('90m window')
  })

  it('names known Claude windows', () => {
    expect(windowLabel({ name: 'five_hour', usedPct: 1, status: 'allowed' })).toBe('5h window')
    expect(windowLabel({ name: 'seven_day', usedPct: 1 })).toBe('7d window')
    expect(windowLabel({ name: 'seven_day_opus', usedPct: 1 })).toBe('7d Opus')
    expect(windowLabel({ name: 'seven_day_sonnet', usedPct: 1 })).toBe('7d Sonnet')
  })

  it('falls back to the raw name without underscores', () => {
    expect(windowLabel({ name: 'weird_window', usedPct: 1 })).toBe('weird window')
  })
})

describe('resetLabel', () => {
  const now = new Date('2026-09-25T12:00:00Z')

  it('hides missing, invalid and zero times', () => {
    expect(resetLabel(undefined, now)).toBeNull()
    expect(resetLabel('garbage', now)).toBeNull()
    expect(resetLabel('0001-01-01T00:00:00Z', now)).toBeNull()
  })

  it('shows time left relative to now', () => {
    // Once the time has passed the window has reset; its number is old.
    expect(resetLabel('2026-09-25T11:00:00Z', now)).toBe('reset')
    expect(resetLabel('2026-09-25T12:00:00Z', now)).toBe('reset')
    expect(resetLabel('2026-09-25T12:12:30Z', now)).toBe('resets in 12m')
    expect(resetLabel('2026-09-25T12:00:30Z', now)).toBe('resets in 1m')
    expect(resetLabel('2026-09-25T14:14:00Z', now)).toBe('resets in 2h 14m')
    expect(resetLabel('2026-09-25T15:00:00Z', now)).toBe('resets in 3h')
    expect(resetLabel('2026-09-28T16:00:00Z', now)).toBe('resets in 3d 4h')
    expect(resetLabel('2026-09-27T12:00:00Z', now)).toBe('resets in 2d')
  })
})

describe('basename', () => {
  it('returns the last path segment', () => {
    expect(basename('/tmp/proj')).toBe('proj')
    expect(basename('/tmp/proj/')).toBe('proj')
    expect(basename('/')).toBe('/')
    expect(basename('rel')).toBe('rel')
  })
})

describe('displayStatus', () => {
  it('prefers the live chat status once events arrived', () => {
    const chat = { ...initialChat('detached'), lastSeq: 3, status: 'running' as const }
    expect(displayStatus(chat, { status: 'idle' })).toBe('running')
  })

  it('falls back to the session status without history', () => {
    expect(displayStatus(initialChat('detached'), { status: 'interrupted' })).toBe('interrupted')
    expect(displayStatus(initialChat('detached'), undefined)).toBe('detached')
  })
})
