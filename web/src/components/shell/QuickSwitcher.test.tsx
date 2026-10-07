import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetStore, useSessionStore } from '../../stores/session'
import { useTerminalStore } from '../../stores/terminals'
import QuickSwitcher from './QuickSwitcher'

beforeEach(() => {
  resetStore()
  useSessionStore.setState({ sessionsStatus: 'ready' })
})

const shell = (id: string, title: string) => ({ id, title, cwd: '/w/frontend-application', status: 'running' }) as never

describe('QuickSwitcher', () => {
  it('keeps a numbered shell’s number apart from its name, marks included', async () => {
    useTerminalStore.setState({ terminals: [shell('t1', 'frontend-application'), shell('t2', 'frontend-application 2')] })
    render(<QuickSwitcher onClose={() => {}} />)
    await userEvent.type(screen.getByRole('combobox'), 'on 2')
    const row = screen.getAllByRole('option').find((o) => o.querySelector('.numbered-n'))!
    expect(row.querySelector('.numbered-name')).toHaveTextContent('frontend-application')
    expect(row.querySelector('.numbered-n')).toHaveTextContent('2')
  })

  it('finds an archived session under its own heading, and opens it', async () => {
    const at = '2026-01-01T00:00:00Z'
    const selectSession = vi.fn(async () => {})
    useSessionStore.setState({
      selectSession,
      sessions: [
        { id: 'a', agent: 'claude', cwd: '/w/shop', status: 'idle', title: 'Checkout fix', createdAt: at },
        { id: 'b', agent: 'claude', cwd: '/w/shop', status: 'idle', title: 'Checkout audit', createdAt: at, archivedAt: at },
      ] as never,
    })
    render(<QuickSwitcher onClose={() => {}} />)
    expect(screen.queryByText('Archived')).toBeNull()
    await userEvent.type(screen.getByRole('combobox'), 'checkout')
    const options = screen.getAllByRole('option')
    const heading = document.querySelector('.switcher-section')!
    expect(heading).toHaveTextContent('Archived')
    const archived = options.find((o) => o.textContent?.includes('Checkout audit'))!
    expect(options.indexOf(archived)).toBe(options.length - 1)
    // The heading sits right above it.
    expect(archived.previousElementSibling).toBe(heading)
    await userEvent.click(archived)
    expect(selectSession).toHaveBeenCalledWith('b')
  })
})
