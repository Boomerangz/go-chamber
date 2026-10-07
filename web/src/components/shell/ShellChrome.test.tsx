import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { notify, resetNotices, useNotices } from '../../stores/notices'
import { resetStore, useSessionStore } from '../../stores/session'
import Notices from './Notices'
import { useLayoutStore } from '../../stores/layout'
import { DockRail, HealthStatus, ModeSwitch, PaneBar, ShowSessions, SignOut } from './Shell'

beforeEach(() => {
  resetStore()
  resetNotices()
})

describe('HealthStatus', () => {
  it('shows only the mark while all is well, and names it on hover', () => {
    useSessionStore.setState({ connection: 'online' })
    render(<HealthStatus health="online" />)
    const status = screen.getByRole('status', { name: 'online' })
    expect(status).toHaveAttribute('title', expect.stringContaining('online'))
    expect(status).not.toHaveTextContent('online')
  })

  it('spells out a state that is not online', () => {
    render(<HealthStatus health="offline" />)
    expect(screen.getByRole('status')).toHaveTextContent('offline')
  })

  it('shows only the dashed mark while connecting: the page says so already', () => {
    render(<HealthStatus health={null} />)
    const status = screen.getByRole('status', { name: 'connecting' })
    expect(status).not.toHaveTextContent('connecting')
  })
})

describe('SignOut', () => {
  it('asks before signing out, and Cancel keeps you in', async () => {
    render(<SignOut />)
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    const question = screen.getByText('Sign out?')
    expect(question).toHaveAttribute('title', expect.stringContaining('access token'))
    const confirm = screen.getByRole('button', { name: 'Sign out' })
    expect(confirm).toHaveAttribute('type', 'submit')
    expect(confirm.closest('form')).toHaveAttribute('action', '/logout')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('Sign out?')).toBeNull()
  })

  it('Escape cancels the question', async () => {
    render(<SignOut />)
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByText('Sign out?')).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign out' })).toHaveFocus()
  })
})

describe('ShowSessions', () => {
  it('offers the hidden sessions list back by name, and only while it is hidden', async () => {
    useLayoutStore.setState({ mode: 'agents', sidebar: true, focus: false })
    render(<ShowSessions />)
    expect(screen.queryByRole('button', { name: 'Show sessions' })).toBeNull()
    act(() => useLayoutStore.setState({ sidebar: false }))
    await userEvent.click(screen.getByRole('button', { name: 'Show sessions' }))
    expect(useLayoutStore.getState().sidebar).toBe(true)
    expect(screen.queryByRole('button', { name: 'Show sessions' })).toBeNull()
  })

  it('on a crowded window, offers the sessions back in place of the open dock', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('1100px'), addEventListener() {}, removeEventListener() {} }))
    try {
      useLayoutStore.setState({ mode: 'agents', sidebar: true, focus: false, dock: 'terminal' })
      render(<ShowSessions />)
      await userEvent.click(screen.getByRole('button', { name: 'Show sessions' }))
      expect(useLayoutStore.getState()).toMatchObject({ sidebar: true, dock: null })
      expect(screen.queryByRole('button', { name: 'Show sessions' })).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('DockRail', () => {
  beforeEach(() => useLayoutStore.setState({ dock: null, focus: false, mode: 'agents' }))

  it('names the terminal key on its tooltip', () => {
    render(<DockRail />)
    expect(screen.getByRole('button', { name: 'Terminal' })).toHaveAttribute('title', 'Terminal (t)')
  })

  it('is one tab stop: the arrows move between its buttons', () => {
    render(<DockRail />)
    const [requests, terminal] = [screen.getByRole('button', { name: 'Requests' }), screen.getByRole('button', { name: 'Terminal' })]
    expect(requests).toHaveAttribute('tabindex', '0')
    expect(terminal).toHaveAttribute('tabindex', '-1')
    requests.focus()
    fireEvent.keyDown(requests, { key: 'ArrowDown' })
    expect(terminal).toHaveFocus()
    expect(terminal).toHaveAttribute('tabindex', '0')
    // Changes is off without a session: skipped, so Down wraps to the top
    fireEvent.keyDown(terminal, { key: 'ArrowDown' })
    expect(requests).toHaveFocus()
    fireEvent.keyDown(requests, { key: 'End' })
    expect(terminal).toHaveFocus()
  })

  it('takes the focus into a dock opened from the keyboard, not from a click', async () => {
    render(
      <>
        <div className="dock-body">
          <button type="button">inside</button>
        </div>
        <DockRail />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }), { detail: 1 })
    await new Promise((r) => requestAnimationFrame(r))
    expect(screen.getByRole('button', { name: 'inside' })).not.toHaveFocus()
    act(() => useLayoutStore.setState({ dock: null }))
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }), { detail: 0 })
    await waitFor(() => expect(screen.getByRole('button', { name: 'inside' })).toHaveFocus())
  })
})

describe('waiting counts', () => {
  beforeEach(() => {
    useLayoutStore.setState({ dock: null, focus: false, mode: 'agents' })
    useSessionStore.setState({
      sessions: [
        { id: 'a', agent: 'claude', cwd: '/w', status: 'interrupted', interruption: { withRequest: true } },
        { id: 'b', agent: 'codex', cwd: '/w', status: 'interrupted', interruption: { withRequest: true } },
      ],
    })
  })

  it('the dock rail counts turns cut off while asking, as the tray lists them', () => {
    render(<DockRail />)
    expect(screen.getByRole('button', { name: 'Requests 2' })).toHaveTextContent('2')
  })

  it('the phone Requests tab counts them too', () => {
    render(<PaneBar />)
    expect(screen.getByRole('button', { name: /Requests/ })).toHaveTextContent('2')
  })
})

describe('ModeSwitch', () => {
  it('is one tab stop whose arrows choose the mode', () => {
    useLayoutStore.setState({ mode: 'agents' })
    render(<ModeSwitch />)
    const agents = screen.getByRole('radio', { name: 'Agents' })
    expect(agents).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('radio', { name: 'Terminal' })).toHaveAttribute('tabindex', '-1')
    agents.focus()
    fireEvent.keyDown(agents, { key: 'ArrowRight' })
    expect(useLayoutStore.getState().mode).toBe('terminal')
    expect(screen.getByRole('radio', { name: 'Terminal' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' })
    expect(useLayoutStore.getState().mode).toBe('diagnostics')
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(useLayoutStore.getState().mode).toBe('agents')
  })

  it('carries the amber waiting count on the Agents tab while another mode is open', () => {
    useLayoutStore.setState({ mode: 'terminal' })
    useSessionStore.setState({
      pendingRequests: [{ id: 'r1', sessionId: 's1', kind: 'permission' }, { id: 'r2', sessionId: 's1', kind: 'question' }] as never,
    })
    const { rerender } = render(<ModeSwitch />)
    const agents = screen.getByRole('radio', { name: 'Agents' })
    expect(agents.querySelector('.badge')).toHaveTextContent('2')
    expect(agents).toHaveAttribute('title', expect.stringContaining('2 waiting for you'))
    act(() => useLayoutStore.setState({ mode: 'agents' }))
    rerender(<ModeSwitch />)
    expect(screen.getByRole('radio', { name: 'Agents' }).querySelector('.badge')).toBeNull()
  })
})

describe('Notices', () => {
  it('Escape dismisses the newest notice', async () => {
    render(<Notices />)
    act(() => {
      notify({ kind: 'error', title: 'First', text: 'one' })
      notify({ kind: 'error', title: 'Second', text: 'two' })
    })
    await userEvent.keyboard('{Escape}')
    expect(useNotices.getState().notices.map((n) => n.title)).toEqual(['First'])
  })

  it('leaves Escape to a field being typed in', async () => {
    render(
      <>
        <input aria-label="field" />
        <Notices />
      </>,
    )
    act(() => void notify({ kind: 'error', title: 'First', text: 'one' }))
    await userEvent.click(screen.getByLabelText('field'))
    await userEvent.keyboard('{Escape}')
    expect(useNotices.getState().notices).toHaveLength(1)
  })
})

describe('a request inbox that failed to load', () => {
  const failed = () => useSessionStore.setState({ requestsStatus: 'error', requestsError: 'database is locked' })

  it('marks the Requests rail button, with the reason', () => {
    failed()
    render(<DockRail />)
    const button = screen.getByRole('button', { name: /^Requests/ })
    expect(button).toHaveAccessibleName("Requests: couldn't load")
    expect(button).toHaveAttribute('title', expect.stringContaining('database is locked'))
    expect(button.querySelector('.rail-count.failed')).toHaveTextContent('!')
  })

  it('marks the phone Requests tab', () => {
    failed()
    render(<PaneBar />)
    const button = screen.getByRole('button', { name: /^Requests/ })
    expect(button).toHaveAccessibleName("Requests: couldn't load")
    expect(button).toHaveAttribute('title', expect.stringContaining('database is locked'))
    expect(button.querySelector('.badge.failed')).toHaveTextContent('!')
  })

  it('marks the Agents tab while another mode is open', () => {
    failed()
    useLayoutStore.setState({ mode: 'terminal' })
    render(<ModeSwitch />)
    const agents = screen.getByRole('radio', { name: /Agents/ })
    expect(agents).toHaveAttribute('title', expect.stringContaining("requests couldn't load"))
    expect(agents.querySelector('.badge.failed')).toHaveTextContent('!')
  })

  it('shows no mark once the inbox loaded', () => {
    useSessionStore.setState({ requestsStatus: 'ready' })
    render(<DockRail />)
    expect(screen.getByRole('button', { name: 'Requests' }).querySelector('.failed')).toBeNull()
  })
})
