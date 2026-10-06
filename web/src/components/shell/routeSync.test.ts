import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetLayout } from '../../stores/layout'
import { resetStore, useSessionStore } from '../../stores/session'
import { replacingHistory, useRouteSync } from './routeSync'

function phone(on: boolean) {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({ matches: on && q.includes('720'), media: q }))
}

// select opens a session the way the store does, without the network.
function select(id: string) {
  act(() => useSessionStore.setState({ activeId: id, pane: 'chat' }))
}

async function back() {
  await act(async () => {
    history.back()
    await new Promise((r) => window.addEventListener('popstate', r, { once: true }))
  })
}

beforeEach(() => {
  localStorage.clear()
  resetLayout()
  resetStore()
  useSessionStore.setState({ selectSession: vi.fn(async (id: string) => useSessionStore.setState({ activeId: id, pane: 'chat' })) })
  history.replaceState(null, '', '/')
})
afterEach(() => phone(false))

describe('useRouteSync', () => {
  it('adds a history step per opened session', () => {
    phone(false)
    renderHook(() => useRouteSync(true))
    const before = history.length
    select('a')
    select('b')
    expect(location.pathname).toBe('/s/b')
    expect(history.length).toBe(before + 2)
  })

  it('replaces the step when stepping through sessions from the keyboard', () => {
    phone(false)
    renderHook(() => useRouteSync(true))
    select('a')
    const before = history.length
    replacingHistory(() => select('b'))
    replacingHistory(() => select('c'))
    expect(location.pathname).toBe('/s/c')
    expect(history.length).toBe(before)
  })

  it('on a phone, Back from a chat opened from the list returns to the list', async () => {
    phone(true)
    renderHook(() => useRouteSync(true))
    select('a')
    act(() => useSessionStore.setState({ pane: 'sessions' }))
    select('b')
    await back()
    expect(useSessionStore.getState().pane).toBe('sessions')
    expect(useSessionStore.getState().activeId).toBe('b')
    expect(location.pathname).toBe('/s/b')
  })

  it('on a phone, reopening the same chat from the list is a step too', async () => {
    phone(true)
    renderHook(() => useRouteSync(true))
    select('a')
    act(() => useSessionStore.setState({ pane: 'sessions' }))
    const before = history.length
    act(() => useSessionStore.setState({ pane: 'chat' }))
    expect(history.length).toBe(before + 1)
    await back()
    expect(useSessionStore.getState().pane).toBe('sessions')
    await act(async () => {
      history.forward()
      await new Promise((r) => window.addEventListener('popstate', r, { once: true }))
    })
    expect(useSessionStore.getState().pane).toBe('chat')
  })
})
