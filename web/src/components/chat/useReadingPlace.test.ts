import { describe, expect, it } from 'vitest'
import { placeOf, restorePlace } from './useReadingPlace'

// box builds a scrolled transcript whose rows are 100px tall from 0; the view
// starts at its scrollTop.
function box(scrollTop: number, rows = ['a', 'b', 'c']) {
  const el = document.createElement('div')
  el.scrollTop = scrollTop
  let top = scrollTop
  Object.defineProperty(el, 'scrollTop', { get: () => top, set: (v: number) => { top = v } })
  el.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
  rows.forEach((id, i) => {
    const row = document.createElement('li')
    row.dataset.row = id
    row.getBoundingClientRect = () => ({ top: i * 100 - top, bottom: (i + 1) * 100 - top }) as DOMRect
    el.appendChild(row)
  })
  return el
}

describe('reading place', () => {
  it('is the end for a pinned transcript', () => {
    expect(placeOf(box(0), true)).toEqual({ pinned: true })
  })

  it('is the first row still in view and how far above the view its top is', () => {
    expect(placeOf(box(130), false)).toEqual({ pinned: false, anchor: 'b', offset: -30 })
    expect(placeOf(box(0), false)).toEqual({ pinned: false, anchor: 'a', offset: 0 })
    expect(placeOf(box(0, []), false)).toBeUndefined()
  })

  it('scrolls the anchor row back to where it was', () => {
    const el = box(0)
    expect(restorePlace(el, { pinned: false, anchor: 'c', offset: -30 })).toBe(true)
    expect(el.scrollTop).toBe(230)
    expect(restorePlace(el, { pinned: false, anchor: 'gone', offset: 0 })).toBe(false)
  })
})
