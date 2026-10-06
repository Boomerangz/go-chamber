import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDraft, loadDraft, resetDrafts, saveDraft, useDrafts } from './drafts'

beforeEach(() => {
  localStorage.clear()
  resetDrafts()
})

describe('draft text', () => {
  it('keeps the unsent text per session', () => {
    saveDraft('s1', 'half a thought')
    saveDraft('s2', 'other')
    expect(loadDraft('s1')).toBe('half a thought')
    expect(loadDraft('s2')).toBe('other')
    expect(localStorage.getItem('gc.draft:s1')).toBe('half a thought')
  })

  it('forgets an emptied or sent draft', () => {
    saveDraft('s1', 'x')
    saveDraft('s1', '')
    expect(localStorage.getItem('gc.draft:s1')).toBeNull()
    saveDraft('s1', 'y')
    clearDraft('s1')
    expect(loadDraft('s1')).toBe('')
  })

  it('has no draft for an unknown session', () => {
    expect(loadDraft('nope')).toBe('')
  })

  it('survives storage that throws', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(loadDraft('s1')).toBe('')
    expect(() => saveDraft('s1', 'x')).not.toThrow()
    expect(() => clearDraft('s1')).not.toThrow()
    get.mockRestore()
    set.mockRestore()
    remove.mockRestore()
  })
})

describe('draft images', () => {
  const s = () => useDrafts.getState()

  it('keeps uploaded images per session in memory', () => {
    s().addImage('s1', { id: 'a.png', name: 'a.png' })
    s().addImage('s2', { id: 'b.png', name: 'b.png' })
    s().addImage('s1', { id: 'c.png', name: 'c.png' })
    expect(s().images.s1?.map((i) => i.id)).toEqual(['a.png', 'c.png'])
    s().removeImage('s1', 'a.png')
    expect(s().images.s1?.map((i) => i.id)).toEqual(['c.png'])
    s().clearImages('s1')
    expect(s().images.s1).toBeUndefined()
    expect(s().images.s2).toHaveLength(1)
  })

  it('tracks uploads in flight and their failures per file', () => {
    s().startUpload('s1', 'k1', 'a.png')
    s().startUpload('s1', 'k2', 'b.png')
    expect(s().uploads.s1?.map((u) => u.name)).toEqual(['a.png', 'b.png'])
    s().finishUpload('s1', 'k1')
    s().failUpload('s1', 'k2', 'too big')
    expect(s().uploads.s1).toBeUndefined()
    expect(s().errors.s1).toEqual([{ key: 'k2', name: 'b.png', message: 'too big' }])
    s().dismissError('s1', 'k2')
    expect(s().errors.s1).toBeUndefined()
  })
})
