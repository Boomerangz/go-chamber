import { act, render, screen, waitFor } from '@testing-library/react'
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
import { browsedTo } from '../../lib/browse'

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

  it('gives the focus back where it was when an overlay closes', async () => {
    render(
      <>
        <button type="button">origin</button>
        <Hotkeys />
      </>,
    )
    const origin = screen.getByRole('button', { name: 'origin' })
    origin.focus()
    await userEvent.keyboard('{Shift>}?{/Shift}')
    await userEvent.keyboard('?')
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(origin).toHaveFocus())
  })

  it('groups the shortcut list and names the modes', async () => {
    render(<Hotkeys />)
    await userEvent.keyboard('?')
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' })
    const groups = [...dialog.querySelectorAll('section')].map((s) => s.getAttribute('aria-label'))
    expect(groups).toEqual(['Navigate', 'Chat', 'Requests', 'Terminal'])
    const navigate = screen.getByRole('region', { name: 'Navigate' })
    expect(navigate).toHaveTextContent('Agents mode')
    expect(navigate).toHaveTextContent('Terminal mode')
    expect(screen.getByRole('region', { name: 'Chat' })).toHaveTextContent('Send the message')
    expect(screen.getByRole('region', { name: 'Requests' })).toHaveTextContent('Allow, allow for session, deny a request')
    expect(screen.getByRole('region', { name: 'Terminal' })).toHaveTextContent('Terminal dock on or off')
  })

  it('prints single keys in lowercase, so they do not read as Shift, and says when A·S·D apply', async () => {
    render(<Hotkeys />)
    await userEvent.keyboard('?')
    const keys = [...screen.getByRole('dialog').querySelectorAll('dt')].map((k) => k.textContent ?? '')
    for (const k of ['n', 'j', 'k', 'f', 'd', 'r', 't', 'c', 'a · s · d']) expect(keys).toContain(k)
    for (const k of ['N', 'J', 'K', 'F', 'D', 'R', 'T', 'C']) expect(keys).not.toContain(k)
    expect(screen.getByRole('region', { name: 'Requests' })).toHaveTextContent('(request focused)')
  })

  it('draws one key per box: no chord or list of keys in a single kbd', async () => {
    render(<Hotkeys />)
    await userEvent.keyboard('?')
    const boxes = [...screen.getByRole('dialog').querySelectorAll('kbd')].map((k) => k.textContent ?? '')
    expect(boxes.length).toBeGreaterThan(20)
    for (const k of boxes) expect(k).not.toMatch(/·|\s|^[⌘⌥⇧⌃].|.\+./)
  })

  it('lets the keyboard scroll the shortcut list', async () => {
    render(<Hotkeys />)
    await userEvent.keyboard('?')
    const list = screen.getByRole('group', { name: 'All shortcuts' })
    expect(list).toHaveAttribute('tabindex', '0')
    expect(list).toHaveClass('shortcut-groups')
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

  it('ignores single keys on a control a click left focused, but not on a session row', async () => {
    render(
      <>
        <button type="button">Terminal</button>
        <aside className="sidebar">
          <button type="button" className="session">alpha</button>
        </aside>
        <Hotkeys />
      </>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    await userEvent.keyboard('f2')
    expect(useLayoutStore.getState().focus).toBe(false)
    expect(useLayoutStore.getState().mode).toBe('agents')
    // a combo with the mod key still works from there
    const sidebar = useLayoutStore.getState().sidebar
    await userEvent.keyboard(isMac ? '{Meta>}b{/Meta}' : '{Control>}b{/Control}')
    expect(useLayoutStore.getState().sidebar).toBe(!sidebar)
    await userEvent.click(screen.getByRole('button', { name: 'alpha' }))
    await userEvent.keyboard('f')
    expect(useLayoutStore.getState().focus).toBe(true)
  })

  it('switches modes and opens the next session that needs you', async () => {
    render(<Hotkeys />)
    await userEvent.keyboard('2')
    expect(useLayoutStore.getState().mode).toBe('terminal')
    act(() => useSessionStore.setState({ pendingRequests: [{ id: 'r', sessionId: 'b' } as never] }))
    await userEvent.keyboard('r')
    expect(useLayoutStore.getState().mode).toBe('agents')
    expect(useSessionStore.getState().activeId).toBe('b')
    // The chat leaves the focus to the request card, so a digit answers it at once.
    expect(browsedTo('b')).toBe(true)
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

  it('brings the workspace back from the Overview for f, d and t', async () => {
    render(<Hotkeys />)
    useSessionStore.setState({ activeId: 's1', pane: 'overview' })
    await userEvent.keyboard('f')
    expect(useSessionStore.getState().pane).toBe('chat')
    expect(useLayoutStore.getState().focus).toBe(true)
    act(() => useSessionStore.setState({ pane: 'overview' }))
    act(() => useLayoutStore.setState({ focus: false }))
    await userEvent.keyboard('d')
    expect(useSessionStore.getState().pane).toBe('chat')
    expect(useLayoutStore.getState().dock).toBe('changes')
    act(() => useSessionStore.setState({ pane: 'overview', activeId: null }))
    await userEvent.keyboard('j')
    expect(useSessionStore.getState().pane).toBe('sessions')
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

  it('steps with j as browsing: the chat it opens leaves the focus to the steps', async () => {
    const selected: string[] = []
    render(
      <>
        <aside className="sidebar">
          <button type="button" className="session" data-session="a" aria-current="true" onClick={() => selected.push('a')}>alpha</button>
          <button type="button" className="session" data-session="b" onClick={() => selected.push('b')}>beta</button>
        </aside>
        <Hotkeys />
      </>,
    )
    await userEvent.keyboard('j')
    expect(selected).toEqual(['b'])
    expect(browsedTo('b')).toBe(true)
  })

  it('carries a focused session row along with the step', async () => {
    render(
      <>
        <aside className="sidebar">
          <button type="button" className="session" data-session="a" aria-current="true">alpha</button>
          <button type="button" className="session" data-session="b">beta</button>
        </aside>
        <Hotkeys />
      </>,
    )
    screen.getByRole('button', { name: 'alpha' }).focus()
    await userEvent.keyboard('j')
    expect(screen.getByRole('button', { name: 'beta' })).toHaveFocus()
  })

  it('lets the terminal hand on ⌘K on a Mac, while Ctrl+K stays the shell’s elsewhere', async () => {
    render(
      <>
        <div className="xterm"><textarea aria-label="Terminal input" /></div>
        <Hotkeys />
      </>,
    )
    screen.getByLabelText('Terminal input').focus()
    await userEvent.keyboard(isMac ? '{Meta>}k{/Meta}' : '{Control>}k{/Control}')
    expect(screen.queryByRole('combobox', { name: 'Go to' }) !== null).toBe(isMac)
    // Single keys never leave a terminal.
    screen.getByLabelText('Terminal input').focus()
    await userEvent.keyboard('?')
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull()
  })

  it('lists the way out of a terminal under Terminal', async () => {
    render(<Hotkeys />)
    await userEvent.keyboard('?')
    expect(screen.getByRole('region', { name: 'Terminal' })).toHaveTextContent('In a terminal: back to the composer')
  })

  it('opens and leaves the Overview with o, and leaves it with Escape', async () => {
    useSessionStore.setState({ activeId: 'a', pane: 'chat' })
    useLayoutStore.setState({ mode: 'terminal' })
    render(<Hotkeys />)
    await userEvent.keyboard('o')
    expect(useSessionStore.getState().pane).toBe('overview')
    expect(useLayoutStore.getState().mode).toBe('agents')
    await userEvent.keyboard('o')
    expect(useSessionStore.getState().pane).toBe('chat')
    await userEvent.keyboard('o')
    await userEvent.keyboard('{Escape}')
    expect(useSessionStore.getState().pane).toBe('chat')
    await userEvent.keyboard('?')
    expect(screen.getByRole('region', { name: 'Navigate' })).toHaveTextContent('Overview on or off')
    expect(screen.getByRole('region', { name: 'Navigate' })).toHaveTextContent('In the Overview: back to the workspace')
  })

  it('leaves Escape alone outside the Overview and in a field within it', async () => {
    useSessionStore.setState({ activeId: 'a', pane: 'overview' })
    render(
      <>
        <section className="attention-overview"><input aria-label="field" /></section>
        <Hotkeys />
      </>,
    )
    screen.getByLabelText('field').focus()
    await userEvent.keyboard('{Escape}')
    expect(useSessionStore.getState().pane).toBe('overview')
    act(() => useSessionStore.setState({ pane: 'chat' }))
    screen.getByLabelText('field').blur()
    await userEvent.keyboard('{Escape}')
    expect(useSessionStore.getState().pane).toBe('chat')
  })

  it('takes the focus into the dock a key opened: the first file in Changes, the shell in Terminal', async () => {
    function FakeDock() {
      const dock = useLayoutStore((s) => s.dock)
      if (dock === 'changes') return <div className="dock"><section className="diff-panel"><button type="button" className="diff-file-toggle">a.go</button><button type="button" className="diff-file-toggle">b.go</button></section></div>
      if (dock === 'terminal') return <div className="dock"><section className="terminals"><button type="button">New terminal</button><div className="xterm"><textarea aria-label="Terminal input" /></div></section></div>
      return null
    }
    useSessionStore.setState({ activeId: 'a' })
    render(
      <>
        <FakeDock />
        <Hotkeys />
      </>,
    )
    await userEvent.keyboard('d')
    await waitFor(() => expect(screen.getByRole('button', { name: 'a.go' })).toHaveFocus())
    // Closing it again by key is d from the file list.
    await userEvent.keyboard('d')
    expect(useLayoutStore.getState().dock).toBeNull()
    await userEvent.keyboard('t')
    await waitFor(() => expect(screen.getByLabelText('Terminal input')).toHaveFocus())
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

  it('marks a session that waits for the owner as waiting, not running', async () => {
    useSessionStore.setState({
      sessions: [{ ...session('a', 'alpha'), status: 'running' }, { ...session('b', 'beta'), status: 'running' }],
      pendingRequests: [{ id: 'r1', sessionId: 'a', kind: 'permission', state: 'pending', title: 'Run' }],
    } as never)
    await openSwitcher()
    const [first, second] = screen.getAllByRole('option')
    expect(first!.querySelector('.switcher-mark')).toHaveClass('status-waiting')
    expect(first!.querySelector('.switcher-mark')).not.toHaveClass('status-running')
    expect(second!.querySelector('.switcher-mark')).toHaveClass('status-running')
  })

  it('puts the whole title on hover, since the row may cut it', async () => {
    await openSwitcher()
    expect(screen.getAllByRole('option')[0]!.querySelector('.switcher-title')).toHaveAttribute('title', 'alpha')
  })

  it('keeps a matched folder one word, marks inside it', async () => {
    useSessionStore.setState({ sessions: [{ ...session('a', 'zzz'), cwd: '/w/alpha' }] })
    const input = await openSwitcher()
    await userEvent.type(input, 'alpha')
    const detail = screen.getAllByRole('option')[0]!.querySelector('.switcher-detail')!
    const path = detail.querySelector(':scope > .switcher-path')!
    expect(path.querySelector('mark')).not.toBeNull()
    expect(path).toHaveTextContent('alpha')
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

