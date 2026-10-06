import { fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOCK_MIN, resetLayout, SIDEBAR_MAX, useLayoutStore } from '../../stores/layout'
import { useLayoutVars } from '../../stores/layout'
import { useSessionStore } from '../../stores/session'
import { DockRail, DockSplitter, SidebarSplitter } from './Shell'

const layout = () => useLayoutStore.getState()

// A dock 500px wide with its splitter on the left edge.
function dockWith(width: number) {
  const view = render(
    <div className="dock">
      <DockSplitter dock="terminal" />
    </div>,
  )
  const dock = view.container.querySelector('.dock')!
  dock.getBoundingClientRect = () => ({ width }) as DOMRect
  return screen.getByRole('separator', { name: 'Resize the dock' })
}

beforeEach(() => {
  localStorage.clear()
  resetLayout()
})

describe('DockSplitter', () => {
  beforeEach(() => vi.stubGlobal('innerWidth', 1600))
  afterEach(() => vi.unstubAllGlobals())

  it('leaves the chat room on a narrow window', () => {
    vi.stubGlobal('innerWidth', 1024)
    const handle = dockWith(300)
    expect(handle).toHaveAttribute('aria-valuemax', '364')
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(layout().widths.terminal).toBe(364)
  })

  it('widens the dock as it is dragged left and remembers the width', () => {
    const handle = dockWith(500)
    fireEvent.pointerDown(handle, { button: 0, clientX: 800 })
    fireEvent.pointerMove(handle, { clientX: 700 })
    expect(layout().widths.terminal).toBe(600)
    fireEvent.pointerMove(handle, { clientX: 1200 })
    expect(layout().widths.terminal).toBe(DOCK_MIN)
    fireEvent.pointerUp(handle)
    fireEvent.pointerMove(handle, { clientX: 0 })
    expect(layout().widths.terminal).toBe(DOCK_MIN)
  })

  it('moves with the arrow keys and goes back to the default on double click', () => {
    const handle = dockWith(500)
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(layout().widths.terminal).toBe(516)
    fireEvent.keyDown(handle, { key: 'Enter' })
    fireEvent.doubleClick(handle)
    expect(layout().widths.terminal).toBeUndefined()
  })

  it('ignores a right-button press', () => {
    const handle = dockWith(500)
    fireEvent.pointerDown(handle, { button: 2, clientX: 800 })
    fireEvent.pointerMove(handle, { clientX: 700 })
    expect(layout().widths.terminal).toBeUndefined()
  })
})

describe('SidebarSplitter', () => {
  it('widens the sidebar as it is dragged right, within bounds', () => {
    const view = render(
      <div className="layout">
        <aside className="sidebar" />
        <SidebarSplitter />
      </div>,
    )
    view.container.querySelector('.sidebar')!.getBoundingClientRect = () => ({ width: 300 }) as DOMRect
    const handle = screen.getByRole('separator', { name: 'Resize the sessions list' })
    fireEvent.pointerDown(handle, { button: 0, clientX: 300 })
    fireEvent.pointerMove(handle, { clientX: 340 })
    expect(layout().sidebarWidth).toBe(340)
    fireEvent.pointerMove(handle, { clientX: 900 })
    expect(layout().sidebarWidth).toBe(SIDEBAR_MAX)
    fireEvent.doubleClick(handle)
    expect(layout().sidebarWidth).toBeNull()
  })

  it('becomes a button that shows the hidden sidebar', () => {
    useLayoutStore.setState({ sidebar: false })
    render(<SidebarSplitter />)
    // A mouse affordance on the edge; the top bar names it for everyone else.
    fireEvent.click(document.querySelector('.sidebar-show')!)
    expect(layout().sidebar).toBe(true)
  })
})

describe('useLayoutVars', () => {
  it('passes the open dock’s and the sidebar’s dragged widths to the grid', () => {
    const { result, rerender } = renderHook(({ dock }) => useLayoutVars(dock), { initialProps: { dock: 'terminal' as const } as { dock: 'terminal' | 'changes' | null } })
    expect(result.current).toEqual({})
    useLayoutStore.setState({ widths: { terminal: 640 }, sidebarWidth: 280 })
    rerender({ dock: 'terminal' })
    expect(result.current).toEqual({ '--dock-w': '640px', '--sidebar-w': '280px' })
    rerender({ dock: 'changes' })
    expect(result.current).toEqual({ '--sidebar-w': '280px' })
    rerender({ dock: null })
    expect(result.current).toEqual({ '--sidebar-w': '280px' })
  })
})

describe('DockRail', () => {
  afterEach(() => useSessionStore.setState({ activeId: null }))

  it('keeps Changes off without a session and says why', () => {
    useSessionStore.setState({ activeId: null })
    useLayoutStore.setState({ dock: 'changes' })
    render(<DockRail />)
    const changes = screen.getByRole('button', { name: 'Changes' })
    expect(changes).toBeDisabled()
    expect(changes).toHaveAttribute('title', 'Open a session to see its changes')
    expect(changes).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('button', { name: 'Collapse dock' })).toBeNull()
  })

  it('names the key for Changes and presses the dock shown', () => {
    useSessionStore.setState({ activeId: 's1' })
    useLayoutStore.setState({ dock: 'changes' })
    render(<DockRail />)
    const changes = screen.getByRole('button', { name: 'Changes' })
    expect(changes).toBeEnabled()
    expect(changes).toHaveAttribute('title', 'Changes (d)')
    expect(changes).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Collapse dock' })).toBeInTheDocument()
  })
})
