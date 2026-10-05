import { beforeEach, describe, expect, it } from 'vitest'
import { loadLayout, resetLayout, useLayoutStore, visibleDock } from './layout'

const store = () => useLayoutStore.getState()

beforeEach(() => {
  localStorage.clear()
  resetLayout()
})

describe('layout store', () => {
  it('starts in agents mode with the dock collapsed', () => {
    expect(store().mode).toBe('agents')
    expect(store().dock).toBeNull()
  })

  it('switches modes and remembers the choice', () => {
    store().setMode('terminal')
    expect(store().mode).toBe('terminal')
    expect(loadLayout()).toEqual({ mode: 'terminal', dock: null, focus: false })
    store().setMode('diagnostics')
    expect(loadLayout()).toEqual({ mode: 'diagnostics', dock: null, focus: false })
  })

  it('toggles a dock tab open, over to another tab and closed', () => {
    store().toggleDock('terminal')
    expect(store().dock).toBe('terminal')
    store().toggleDock('requests')
    expect(store().dock).toBe('requests')
    expect(loadLayout().dock).toBe('requests')
    store().toggleDock('requests')
    expect(store().dock).toBeNull()
    expect(loadLayout().dock).toBeNull()
  })

  it('opens the changes tab and remembers it', () => {
    store().toggleDock('changes')
    expect(store().dock).toBe('changes')
    expect(loadLayout().dock).toBe('changes')
  })

  it('ignores unknown or broken stored values', () => {
    localStorage.setItem('gc.layout', JSON.stringify({ mode: 'weird', dock: 'nope', focus: 'yes' }))
    expect(loadLayout()).toEqual({ mode: 'agents', dock: null, focus: false })
    localStorage.setItem('gc.layout', '{')
    expect(loadLayout()).toEqual({ mode: 'agents', dock: null, focus: false })
    localStorage.setItem('gc.layout', JSON.stringify({ mode: 'terminal', dock: 'terminal' }))
    resetLayout()
    expect(store().mode).toBe('terminal')
    expect(store().dock).toBe('terminal')
  })

  it('toggles focus and remembers it', () => {
    expect(store().focus).toBe(false)
    store().toggleFocus()
    expect(store().focus).toBe(true)
    expect(loadLayout().focus).toBe(true)
    store().toggleDock('terminal')
    expect(loadLayout()).toEqual({ mode: 'agents', dock: 'terminal', focus: true })
    store().toggleFocus()
    expect(loadLayout().focus).toBe(false)
  })
})

describe('visibleDock', () => {
  it('shows the chosen dock outside focus', () => {
    expect(visibleDock({ dock: 'terminal', focus: false }, 3)).toBe('terminal')
    expect(visibleDock({ dock: null, focus: false }, 3)).toBeNull()
  })

  it('in focus shows only the requests, and only while some wait', () => {
    expect(visibleDock({ dock: 'terminal', focus: true }, 0)).toBeNull()
    expect(visibleDock({ dock: 'terminal', focus: true }, 1)).toBe('requests')
    expect(visibleDock({ dock: null, focus: true }, 2)).toBe('requests')
  })
})
