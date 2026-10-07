import { beforeEach, expect, it, vi } from 'vitest'
import { inWorkspace, leaveOverview, overviewShown, toggleOverview } from './overview'
import { resetStore, useSessionStore } from '../stores/session'
import { useLayoutStore } from '../stores/layout'

beforeEach(() => {
  resetStore()
  useLayoutStore.setState({ mode: 'agents' })
})

it('toggles the Overview on, and off back to the open chat or the list', () => {
  useLayoutStore.setState({ mode: 'terminal' })
  toggleOverview()
  expect(overviewShown()).toBe(true)
  expect(useLayoutStore.getState().mode).toBe('agents')
  toggleOverview()
  expect(useSessionStore.getState().pane).toBe('sessions')
  useSessionStore.setState({ pane: 'overview', activeId: 's' })
  toggleOverview()
  expect(useSessionStore.getState().pane).toBe('chat')
})

it('leaves other panes alone', () => {
  useSessionStore.setState({ pane: 'requests' })
  leaveOverview()
  expect(useSessionStore.getState().pane).toBe('requests')
})

it('runs a workspace shortcut at once outside the Overview, after a frame inside it', () => {
  const run = vi.fn()
  inWorkspace(run, true)
  expect(run).toHaveBeenCalledTimes(1)
  const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0 })
  useSessionStore.setState({ pane: 'overview' })
  inWorkspace(run, true)
  expect(frame).toHaveBeenCalled()
  expect(run).toHaveBeenCalledTimes(2)
  expect(overviewShown()).toBe(false)
  frame.mockRestore()
})
