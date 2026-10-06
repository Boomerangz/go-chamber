import { describe, expect, it } from 'vitest'
import { attentionTitle } from './title'

describe('attentionTitle', () => {
  it('is the product name at rest', () => {
    expect(attentionTitle({ pending: 0, running: false })).toBe('go-chamber')
  })

  it('names the open session', () => {
    expect(attentionTitle({ pending: 0, running: false, session: 'fix login' })).toBe('fix login · go-chamber')
  })

  it('leads with what needs the owner, then whether an agent works', () => {
    expect(attentionTitle({ pending: 2, running: true, session: 'fix login' })).toBe('(2) ● fix login · go-chamber')
    expect(attentionTitle({ pending: 0, running: true })).toBe('● go-chamber')
  })

  it('counts sessions that changed while the owner was away', () => {
    expect(attentionTitle({ pending: 1, running: false, unseen: 2, session: 'fix login' })).toBe('(1) 2 new · fix login · go-chamber')
    expect(attentionTitle({ pending: 0, running: true, unseen: 1 })).toBe('● 1 new · go-chamber')
  })
})
