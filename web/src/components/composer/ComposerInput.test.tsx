import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

function Harness({
  agent = 'claude' as const,
  onSubmit = () => {},
  onEscape,
  history,
  initial = '',
  enterSends,
}: {
  enterSends?: boolean
  agent?: 'claude' | 'codex'
  onSubmit?: () => void
  onEscape?: () => void
  history?: string[]
  initial?: string
}) {
  const [text, setText] = useState(initial)
  return (
    <>
      <ComposerInput
        sessionId="s1"
        agent={agent}
        value={text}
        onChange={setText}
        onSubmit={onSubmit}
        onEscape={onEscape}
        history={history}
        enterSends={enterSends}
        placeholder="msg"
      />
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

const box = () => screen.getByRole('combobox', { name: 'message' }) as HTMLTextAreaElement

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

  it('sends with Enter and breaks the line with Shift+Enter', async () => {
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} />)
    await userEvent.type(box(), 'one{Shift>}{Enter}{/Shift}two')
    expect(box()).toHaveValue('one\ntwo')
    expect(onSubmit).not.toHaveBeenCalled()
    await userEvent.keyboard('{Enter}')
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(box()).toHaveValue('one\ntwo')
  })

  it('does not send while an input method composes', () => {
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} />)
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true })
    fireEvent.keyDown(box(), { key: 'Enter', keyCode: 229 })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('keeps Enter a newline where it should not send (touch)', async () => {
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} enterSends={false} />)
    await userEvent.type(box(), 'a{Enter}b')
    expect(box()).toHaveValue('a\nb')
    expect(onSubmit).not.toHaveBeenCalled()
    await userEvent.keyboard('{Control>}{Enter}{/Control}')
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('picks the open suggestion with Enter instead of sending', async () => {
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} />)
    await userEvent.type(box(), 'see @ma')
    await screen.findByRole('listbox')
    await userEvent.keyboard('{Enter}')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('sends with cmd+enter when no popup is open', async () => {
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} />)
    await userEvent.type(box(), 'hello')
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}')
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('says when files could not be listed', async () => {
    vi.mocked(complete.completeFiles).mockRejectedValue(new Error('boom'))
    render(<Harness />)
    await userEvent.type(box(), '@x')
    expect(await screen.findByText("couldn't list files")).toBeInTheDocument()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('says when commands could not be listed', async () => {
    vi.mocked(complete.listCommands).mockRejectedValue(new Error('boom'))
    render(<Harness />)
    await userEvent.type(box(), '/co')
    expect(await screen.findByText("couldn't list commands")).toBeInTheDocument()
  })

  it('keeps the last suggestions, dimmed, while the next lookup runs', async () => {
    render(<Harness />)
    await userEvent.type(box(), '@ma')
    await screen.findByRole('listbox')
    vi.mocked(complete.completeFiles).mockImplementation(() => new Promise(() => {}))
    await userEvent.type(box(), 'i')
    const list = screen.getByRole('listbox')
    expect(list).toHaveAttribute('aria-busy', 'true')
    expect(list).toHaveClass('stale')
    expect(screen.getAllByRole('option')).toHaveLength(2)
  })

  it('says it is searching, then that nothing matched', async () => {
    let answer: (files: complete.FileMatch[]) => void = () => {}
    vi.mocked(complete.completeFiles).mockImplementation(() => new Promise((r) => (answer = r)))
    render(<Harness />)
    await userEvent.type(box(), '@zz')
    expect(await screen.findByText('searching…')).toBeInTheDocument()
    await waitFor(() => expect(complete.completeFiles).toHaveBeenLastCalledWith('s1', 'zz'))
    answer([])
    expect(await screen.findByText('no matches')).toBeInTheDocument()
    expect(screen.queryByRole('listbox')).toBeNull()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByText('no matches')).toBeNull()
  })

  it('hands Escape on to the chat when no popup is open', async () => {
    const onEscape = vi.fn()
    render(<Harness onEscape={onEscape} />)
    await userEvent.type(box(), '@c')
    await screen.findByRole('listbox')
    await userEvent.keyboard('{Escape}')
    expect(onEscape).not.toHaveBeenCalled()
    await userEvent.keyboard('{Escape}')
    expect(onEscape).toHaveBeenCalledTimes(1)
  })

  it('recalls the last message with ArrowUp in an empty composer', async () => {
    render(<Harness history={['older', 'fix the tests']} />)
    await userEvent.type(box(), 'x')
    await userEvent.keyboard('{ArrowUp}')
    expect(box()).toHaveValue('x')
    await userEvent.clear(box())
    await userEvent.keyboard('{ArrowUp}')
    expect(box()).toHaveValue('fix the tests')
  })

  it('walks back and forth through sent messages like a shell', async () => {
    render(<Harness history={['first', 'second', 'third']} />)
    box().focus()
    await userEvent.keyboard('{ArrowUp}{ArrowUp}')
    expect(box()).toHaveValue('second')
    await userEvent.keyboard('{ArrowUp}{ArrowUp}')
    expect(box()).toHaveValue('first')
    await userEvent.keyboard('{ArrowDown}')
    expect(box()).toHaveValue('second')
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    expect(box()).toHaveValue('')
  })

  it('keeps a draft: recalls only from the start of it and brings it back after', async () => {
    render(<Harness history={['sent before']} initial="my draft" />)
    box().focus()
    box().setSelectionRange(8, 8)
    await userEvent.keyboard('{ArrowUp}')
    expect(box()).toHaveValue('my draft')
    box().setSelectionRange(0, 0)
    await userEvent.keyboard('{ArrowUp}')
    expect(box()).toHaveValue('sent before')
    await userEvent.keyboard('{ArrowDown}')
    expect(box()).toHaveValue('my draft')
  })

  it('moves inside an edited message instead of leaving it', async () => {
    render(<Harness history={['one\ntwo']} />)
    box().focus()
    await userEvent.keyboard('{ArrowUp}')
    expect(box()).toHaveValue('one\ntwo')
    await userEvent.type(box(), '!')
    box().setSelectionRange(2, 2)
    await userEvent.keyboard('{ArrowDown}')
    expect(box()).toHaveValue('one\ntwo!')
  })

  it('grows with its text where CSS cannot size it', async () => {
    vi.stubGlobal('CSS', { supports: () => false })
    render(<Harness />)
    Object.defineProperty(box(), 'scrollHeight', { configurable: true, get: () => 90 })
    await userEvent.type(box(), 'a')
    expect(box().style.height).toBe('90px')
    vi.unstubAllGlobals()
  })
})
