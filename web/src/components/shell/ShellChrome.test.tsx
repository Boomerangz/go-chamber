import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { notify, resetNotices, useNotices } from '../../stores/notices'
import { resetStore, useSessionStore } from '../../stores/session'
import Notices from './Notices'
import { useLayoutStore } from '../../stores/layout'
import { DockRail, HealthStatus, ModeSwitch, ShowSessions, SignOut } from './Shell'

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
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('1000px'), addEventListener() {}, removeEventListener() {} }))
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
