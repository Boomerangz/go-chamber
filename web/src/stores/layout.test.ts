import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionStore } from './session'
import { DOCK_MAX, DOCK_MIN, loadLayout, resetLayout, SIDEBAR_MAX, SIDEBAR_MIN, settleRestoredDock, sidebarShown, useLayoutStore, visibleDock } from './layout'

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
    expect(loadLayout()).toMatchObject({ mode: 'terminal', dock: null, focus: false })
    store().setMode('diagnostics')
    expect(loadLayout()).toMatchObject({ mode: 'diagnostics', dock: null, focus: false })
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
    useSessionStore.setState({ activeId: 's1' })
    store().toggleDock('changes')
    expect(store().dock).toBe('changes')
    expect(loadLayout().dock).toBe('changes')
  })

  it('leaves the changes tab shut without a session, but lets it close', () => {
    useSessionStore.setState({ activeId: null })
    store().toggleDock('changes')
    expect(store().dock).toBeNull()
    useLayoutStore.setState({ dock: 'changes' })
    store().toggleDock('changes')
    expect(store().dock).toBeNull()
  })

  it('ignores unknown or broken stored values', () => {
    localStorage.setItem('gc.layout', JSON.stringify({ mode: 'weird', dock: 'nope', focus: 'yes' }))
    expect(loadLayout()).toMatchObject({ mode: 'agents', dock: null, focus: false })
    localStorage.setItem('gc.layout', '{')
    expect(loadLayout()).toMatchObject({ mode: 'agents', dock: null, focus: false })
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
    expect(loadLayout()).toMatchObject({ mode: 'agents', dock: 'terminal', focus: true })
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

  it('collapses the changes dock to its rail without a session', () => {
    expect(visibleDock({ dock: 'changes', focus: false }, 0, false)).toBeNull()
    expect(visibleDock({ dock: 'changes', focus: false }, 0, true)).toBe('changes')
    expect(visibleDock({ dock: 'terminal', focus: false }, 0, false)).toBe('terminal')
  })
})

describe('panel sizes', () => {
  it('wraps diff and file lines on request and remembers it', () => {
    expect(store().wrap).toBe(false)
    store().toggleWrap()
    expect(store().wrap).toBe(true)
    expect(loadLayout().wrap).toBe(true)
  })

  it('shows hooks that said something until told otherwise, and remembers it', () => {
    expect(store().hooks).toBe('some')
    store().setHooks('all')
    expect(loadLayout().hooks).toBe('all')
    store().setHooks('off')
    expect(loadLayout().hooks).toBe('off')
    localStorage.setItem('gc.layout', JSON.stringify({ hooks: 'loud' }))
    expect(loadLayout().hooks).toBe('some')
  })

  it('remembers a width per dock, clamped, and forgets it on reset', () => {
    store().setDockWidth('terminal', 640)
    store().setDockWidth('changes', 50)
    store().setDockWidth('requests', 99999)
    expect(store().widths).toEqual({ terminal: 640, changes: DOCK_MIN, requests: DOCK_MAX })
    expect(loadLayout().widths).toEqual({ terminal: 640, changes: DOCK_MIN, requests: DOCK_MAX })
    store().setDockWidth('terminal', null)
    expect(loadLayout().widths).toEqual({ changes: DOCK_MIN, requests: DOCK_MAX })
  })

  it('collapses a restored Requests dock once nothing turns out to be pending, only on load', () => {
    localStorage.setItem('gc.layout', JSON.stringify({ dock: 'requests' }))
    resetLayout()
    settleRestoredDock(0)
    expect(store().dock).toBeNull()
    store().toggleDock('requests')
    settleRestoredDock(0)
    expect(store().dock).toBe('requests')
  })

  it('keeps a restored Requests dock while something waits', () => {
    localStorage.setItem('gc.layout', JSON.stringify({ dock: 'requests' }))
    resetLayout()
    settleRestoredDock(2)
    expect(store().dock).toBe('requests')
  })

  it('remembers the sidebar width and whether it is shown', () => {
    expect(store().sidebar).toBe(true)
    store().setSidebarWidth(9999)
    expect(store().sidebarWidth).toBe(SIDEBAR_MAX)
    store().setSidebarWidth(10)
    expect(loadLayout().sidebarWidth).toBe(SIDEBAR_MIN)
    store().setSidebarWidth(null)
    expect(loadLayout().sidebarWidth).toBeNull()
    store().toggleSidebar()
    expect(store().sidebar).toBe(false)
    expect(loadLayout().sidebar).toBe(false)
  })

  it('ignores broken stored sizes', () => {
    localStorage.setItem('gc.layout', JSON.stringify({ widths: { terminal: 'x', changes: 500, bogus: 3 }, sidebarWidth: -4, sidebar: 'no', wrap: 1 }))
    expect(loadLayout()).toMatchObject({ widths: { changes: 500 }, sidebarWidth: SIDEBAR_MIN, sidebar: true, wrap: false })
    localStorage.setItem('gc.layout', JSON.stringify({ widths: [], sidebarWidth: 'wide' }))
    expect(loadLayout()).toMatchObject({ widths: {}, sidebarWidth: null })
  })

  describe('between the phone and a wide screen', () => {
    // crowded stubs the media query for a window too narrow for the
    // sessions list, the chat and an open dock side by side.
    const crowded = (on: boolean) =>
      vi.stubGlobal('matchMedia', (q: string) => ({ matches: on && q.includes('1100px'), addEventListener() {}, removeEventListener() {} }))
    afterEach(() => vi.unstubAllGlobals())

    it('an open dock crowds the sessions list out, and only then', () => {
      expect(sidebarShown({ sidebar: true, focus: false }, 'changes', true)).toBe(false)
      expect(sidebarShown({ sidebar: true, focus: false }, null, true)).toBe(true)
      expect(sidebarShown({ sidebar: true, focus: false }, 'changes', false)).toBe(true)
      expect(sidebarShown({ sidebar: false, focus: false }, null, false)).toBe(false)
    })

    it('showing the sessions list again collapses the dock that crowded it out', () => {
      crowded(true)
      store().toggleDock('terminal')
      store().toggleSidebar()
      expect(store().dock).toBeNull()
      expect(store().sidebar).toBe(true)
    })

    it('with room for both, the sessions list toggles as usual', () => {
      crowded(false)
      store().toggleDock('terminal')
      store().toggleSidebar()
      expect(store().dock).toBe('terminal')
      expect(store().sidebar).toBe(false)
    })
  })
})
