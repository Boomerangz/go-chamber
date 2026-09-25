import { beforeEach, describe, expect, it } from 'vitest'
import { loadLayout, resetLayout, useLayoutStore } from './layout'

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
    expect(loadLayout()).toEqual({ mode: 'terminal', dock: null })
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

  it('ignores unknown or broken stored values', () => {
    localStorage.setItem('gc.layout', JSON.stringify({ mode: 'weird', dock: 'nope' }))
    expect(loadLayout()).toEqual({ mode: 'agents', dock: null })
    localStorage.setItem('gc.layout', '{')
    expect(loadLayout()).toEqual({ mode: 'agents', dock: null })
    localStorage.setItem('gc.layout', JSON.stringify({ mode: 'terminal', dock: 'terminal' }))
    resetLayout()
    expect(store().mode).toBe('terminal')
    expect(store().dock).toBe('terminal')
  })
})
