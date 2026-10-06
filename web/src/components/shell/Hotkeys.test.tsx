import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../../lib/api'

vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof import('../../lib/api')>()),
  fetchEvents: vi.fn().mockResolvedValue([]),
}))

import Hotkeys from './Hotkeys'
import { openShortcuts } from './overlay'
import { resetStore, useSessionStore } from '../../stores/session'
import { useLayoutStore } from '../../stores/layout'
import { isMac } from '../../lib/hotkeys'

const session = (id: string, title: string): Session =>
  ({ id, agent: 'claude', cwd: `/w/${id}`, status: 'idle', title, createdAt: '2026-01-01T00:00:00Z' }) as Session

beforeEach(() => {
  resetStore()
  vi.stubGlobal('WebSocket', undefined)
  useLayoutStore.setState({ mode: 'agents', dock: null, focus: false })
  useSessionStore.setState({ sessions: [session('a', 'alpha'), session('b', 'beta')] })
})

describe('Hotkeys', () => {
  it('opens the shortcut list with ?', async () => {
    render(<Hotkeys />)
    await userEvent.keyboard('?')
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
    expect(screen.getByText('Next session that needs you')).toBeInTheDocument()
    expect(screen.getByText('In a terminal: find in the scrollback')).toBeInTheDocument()
    expect(screen.getByText('In a terminal: larger, smaller, default text')).toBeInTheDocument()
  })

  it('jumps to a session from the switcher', async () => {
    render(<Hotkeys />)
    await userEvent.keyboard('{Control>}k{/Control}')
    const input = screen.getByRole('combobox', { name: 'Go to' })
    await userEvent.type(input, 'bet')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    await userEvent.keyboard('{Enter}')
    expect(useSessionStore.getState().activeId).toBe('b')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('ignores single keys while typing', async () => {
    render(
      <>
        <input aria-label="field" />
        <Hotkeys />
      </>,
    )
    await userEvent.click(screen.getByLabelText('field'))
    await userEvent.keyboard('?2')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(useLayoutStore.getState().mode).toBe('agents')
  })

  it('switches modes and opens the next session that needs you', async () => {
    render(<Hotkeys />)
    await userEvent.keyboard('2')
    expect(useLayoutStore.getState().mode).toBe('terminal')
    act(() => useSessionStore.setState({ pendingRequests: [{ id: 'r', sessionId: 'b' } as never] }))
    await userEvent.keyboard('r')
    expect(useLayoutStore.getState().mode).toBe('agents')
    expect(useSessionStore.getState().activeId).toBe('b')
  })

  it('opens and closes the changes dock with d', async () => {
    render(<Hotkeys />)
    await userEvent.keyboard('d')
    // Without a session there are no changes to open.
    expect(useLayoutStore.getState().dock).toBeNull()
    act(() => useSessionStore.setState({ activeId: 's1' }))
    await userEvent.keyboard('d')
    expect(useLayoutStore.getState().dock).toBe('changes')
    await userEvent.keyboard('d')
    expect(useLayoutStore.getState().dock).toBeNull()
  })

  it('hides and shows the sessions list with the mod key and B', async () => {
    useLayoutStore.setState({ sidebar: true })
    render(<Hotkeys />)
    await userEvent.keyboard(isMac ? '{Meta>}b{/Meta}' : '{Control>}b{/Control}')
    expect(useLayoutStore.getState().sidebar).toBe(false)
    await userEvent.keyboard(isMac ? '{Meta>}b{/Meta}' : '{Control>}b{/Control}')
    expect(useLayoutStore.getState().sidebar).toBe(true)
  })

  it('leaves Focus first when / or n targets the hidden sidebar', async () => {
    useLayoutStore.setState({ focus: true })
    render(<Hotkeys />)
    await userEvent.keyboard('/')
    expect(useLayoutStore.getState().focus).toBe(false)
    useLayoutStore.setState({ focus: true })
    await userEvent.keyboard('n')
    expect(useLayoutStore.getState().focus).toBe(false)
  })

  it('keeps Focus when c targets the composer', async () => {
    useLayoutStore.setState({ focus: true })
    render(<Hotkeys />)
    await userEvent.keyboard('c')
    expect(useLayoutStore.getState().focus).toBe(true)
  })

  it('opens the shortcut list from the top bar button', () => {
    render(<Hotkeys />)
    act(() => openShortcuts())
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
  })
})

describe('QuickSwitcher', () => {
  async function openSwitcher() {
    render(<Hotkeys />)
    await userEvent.keyboard('{Control>}k{/Control}')
    return screen.getByRole('combobox', { name: 'Go to' })
  }

  it('marks the matched letters and tags the open session', async () => {
    useSessionStore.setState({ activeId: 'a' })
    const input = await openSwitcher()
    await userEvent.type(input, 'aph')
    const option = screen.getAllByRole('option')[0]!
    expect([...option.querySelectorAll('.switcher-title mark')].map((m) => m.textContent)).toEqual(['a', 'ph'])
    expect(option).toHaveTextContent('current')
  })

  it('starts a new session in a folder from the list', async () => {
    const createSession = vi.fn(async () => true)
    useSessionStore.setState({ createSession })
    const input = await openSwitcher()
    await userEvent.type(input, 'new codex')
    await userEvent.click(screen.getByRole('option', { name: /New Codex session in b/ }))
    expect(createSession).toHaveBeenCalledWith('codex', '/w/b')
  })

  it('says sessions are loading, then that there are none', async () => {
    useSessionStore.setState({ sessions: [], sessionsStatus: 'loading' })
    await openSwitcher()
    expect(screen.getByText('loading sessions…')).toBeInTheDocument()
    act(() => useSessionStore.setState({ sessionsStatus: 'ready' }))
    expect(screen.getByText('No sessions yet')).toBeInTheDocument()
  })
})

