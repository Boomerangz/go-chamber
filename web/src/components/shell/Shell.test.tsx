import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { notify, resetNotices, useNotices } from '../../stores/notices'
import { resetStore, useSessionStore } from '../../stores/session'
import Notices from './Notices'
import { DockRail, HealthStatus, SignOut } from './Shell'

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
    render(<HealthStatus health={null} />)
    expect(screen.getByText('connecting')).toBeInTheDocument()
  })
})

describe('SignOut', () => {
  it('asks before signing out, and Cancel keeps you in', async () => {
    render(<SignOut />)
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(screen.getByText("Sign out? You'll need the access token again.")).toBeInTheDocument()
    const confirm = screen.getByRole('button', { name: 'Sign out' })
    expect(confirm).toHaveAttribute('type', 'submit')
    expect(confirm.closest('form')).toHaveAttribute('action', '/logout')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText(/You'll need the access token/)).toBeNull()
  })
})

describe('DockRail', () => {
  it('names the terminal key on its tooltip', () => {
    render(<DockRail />)
    expect(screen.getByRole('button', { name: 'Terminal' })).toHaveAttribute('title', 'Terminal (t)')
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
