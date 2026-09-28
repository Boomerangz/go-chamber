import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as complete from '../../lib/complete'
import ComposerInput from './ComposerInput'

vi.mock('../../lib/complete', async (orig) => ({
  ...(await orig<typeof complete>()),
  completeFiles: vi.fn(),
  listCommands: vi.fn(),
}))

function Harness({ agent = 'claude' as const, onSubmit = () => {} }: { agent?: 'claude' | 'codex'; onSubmit?: () => void }) {
  const [text, setText] = useState('')
  return (
    <>
      <ComposerInput sessionId="s1" agent={agent} value={text} onChange={setText} onSubmit={onSubmit} placeholder="msg" />
      <output data-testid="value">{text}</output>
    </>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(complete.completeFiles).mockResolvedValue([{ path: 'cmd/', dir: true }, { path: 'cmd/main.go' }])
  vi.mocked(complete.listCommands).mockResolvedValue([
    { name: 'compact', description: 'Clear history but keep a summary', insert: '/compact' },
    { name: 'review-mr', insert: '/review-mr' },
  ])
})

const box = () => screen.getByRole('combobox', { name: 'message' })

describe('ComposerInput', () => {
  it('suggests files after @ and inserts the chosen path with Enter', async () => {
    render(<Harness />)
    await userEvent.type(box(), 'open @ma')
    const list = await screen.findByRole('listbox')
    expect(complete.completeFiles).toHaveBeenLastCalledWith('s1', 'ma')
    expect(list).toBeVisible()
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.getByRole('option', { name: /cmd\/main\.go/ })).toHaveAttribute('aria-selected', 'true')
    expect(box()).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: /cmd\/main\.go/ }).id)
    await userEvent.keyboard('{Enter}')
    expect(screen.getByTestId('value')).toHaveTextContent('open @cmd/main.go')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('suggests slash commands at the start and accepts with Tab', async () => {
    render(<Harness />)
    await userEvent.type(box(), '/rev')
    expect(await screen.findByRole('option', { name: /review-mr/ })).toBeVisible()
    expect(screen.queryByRole('option', { name: /compact/ })).toBeNull()
    await userEvent.keyboard('{Tab}')
    expect(screen.getByTestId('value')).toHaveTextContent('/review-mr')
  })

  it('shows command descriptions and accepts a click', async () => {
    render(<Harness />)
    await userEvent.type(box(), '/')
    const option = await screen.findByRole('option', { name: /compact/ })
    expect(option).toHaveTextContent('Clear history but keep a summary')
    await userEvent.click(option)
    expect(screen.getByTestId('value')).toHaveTextContent('/compact')
  })

  it('closes on Escape and Enter then does not pick anything', async () => {
    render(<Harness />)
    await userEvent.type(box(), '@c')
    await screen.findByRole('listbox')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(box()).toHaveAttribute('aria-expanded', 'false')
  })

  it('offers codex skills after $', async () => {
    render(<Harness agent="codex" />)
    await userEvent.type(box(), 'use $comp')
    expect(await screen.findByRole('option', { name: /compact/ })).toBeVisible()
  })

  it('sends with cmd+enter when no popup is open', async () => {
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} />)
    await userEvent.type(box(), 'hello')
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}')
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('keeps quiet when the lookup fails', async () => {
    vi.mocked(complete.completeFiles).mockRejectedValue(new Error('boom'))
    render(<Harness />)
    await userEvent.type(box(), '@x')
    await waitFor(() => expect(complete.completeFiles).toHaveBeenCalled())
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})
