import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
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
})
