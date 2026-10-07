import { describe, expect, it } from 'vitest'
import { revealTop, scrollParent } from './reveal'

describe('revealTop', () => {
  // A 500px view; keep is how much of what is above must stay in view.
  const view = 500
  it('leaves what is already in view', () => {
    expect(revealTop(100, view, { top: 300, height: 200 }, 200)).toBe(100)
  })
  it('brings an element below into view, its bottom at the view’s bottom', () => {
    expect(revealTop(0, view, { top: 400, height: 300 }, 100)).toBe(200)
  })
  it('stops short so keep px above it stay in view', () => {
    // nearest would scroll to 400 + 300 - 500 = 200; keeping 250 above
    // the element allows only 150.
    expect(revealTop(0, view, { top: 400, height: 300 }, 250)).toBe(150)
  })
  it('shows a tall element from its top, still keeping what is above', () => {
    expect(revealTop(0, view, { top: 600, height: 900 }, 0)).toBe(600)
    expect(revealTop(0, view, { top: 600, height: 900 }, 200)).toBe(400)
  })
  it('scrolls back up to an element above, with keep px over it', () => {
    expect(revealTop(800, view, { top: 300, height: 100 }, 100)).toBe(200)
  })
  it('never scrolls before the start', () => {
    expect(revealTop(300, view, { top: 50, height: 100 }, 200)).toBe(0)
  })
})

describe('scrollParent', () => {
  it('finds the nearest ancestor that scrolls', () => {
    document.body.innerHTML = '<div id="outer" style="overflow-y: auto"><div id="inner" style="overflow: hidden"><p id="el"></p></div></div>'
    expect(scrollParent(document.getElementById('el')!)?.id).toBe('outer')
    document.body.innerHTML = '<div><p id="el"></p></div>'
    expect(scrollParent(document.getElementById('el')!)).toBeNull()
  })
})
