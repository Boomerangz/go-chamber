import { describe, expect, it } from 'vitest'
import { shownStatus, statusWord, type StatusFacts } from './status'

const facts = (over: Partial<StatusFacts>): StatusFacts => ({ status: 'idle', started: true, waiting: 0, ...over })

describe('shownStatus', () => {
  it('puts a request waiting for the owner before a running turn', () => {
    expect(shownStatus(facts({ status: 'running', waiting: 1 }))).toBe('waiting')
    expect(statusWord('waiting')).toBe('waiting for you')
  })

  it('shows a running or interrupted turn as it is', () => {
    expect(shownStatus(facts({ status: 'running' }))).toBe('running')
    expect(shownStatus(facts({ status: 'interrupted', failed: true }))).toBe('interrupted')
  })

  it('says the last turn failed rather than idle, and flashes done for a finish', () => {
    expect(shownStatus(facts({ failed: true }))).toBe('failed')
    expect(shownStatus(facts({ status: 'detached', failed: true }))).toBe('failed')
    expect(shownStatus(facts({ finished: true }))).toBe('done')
    expect(shownStatus(facts({}))).toBe('idle')
  })

  it('calls a session never started idle, not detached', () => {
    expect(shownStatus(facts({ status: 'detached', started: false }))).toBe('idle')
    expect(shownStatus(facts({ status: 'detached' }))).toBe('detached')
    expect(statusWord('detached')).toBe('detached')
  })
})
