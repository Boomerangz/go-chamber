import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import CopyButton from './CopyButton'
import { copyText } from '../../lib/clipboard'
import { useNotices } from '../../stores/notices'

const writeText = vi.fn<(text: string) => Promise<void>>(async () => {})

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  useNotices.setState({ notices: [] })
})
afterEach(() => vi.useRealTimers())

it('shows a pending copy and does not send it twice', async () => {
  let finish!: () => void
  writeText.mockImplementation(() => new Promise<void>((r) => { finish = r }))
  render(<CopyButton text="hello" />)
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
  const pending = screen.getByRole('button', { name: 'Copying…' })
  expect(pending).toHaveAttribute('aria-busy', 'true')
  fireEvent.click(pending)
  expect(writeText).toHaveBeenCalledTimes(1)
  await act(async () => finish())
  expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
})

it('restores composer focus and selection after a legacy copy fails', async () => {
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
  render(<textarea aria-label="Draft" defaultValue="draft message" />)
  const draft = screen.getByRole('textbox') as HTMLTextAreaElement
  draft.focus()
  draft.setSelectionRange(2, 5)
  Object.defineProperty(document, 'execCommand', { configurable: true, value: () => {
    document.querySelectorAll('textarea')[1]!.focus()
    throw new Error('denied')
  } })
  expect(await copyText('plain')).toBe(false)
  expect(draft).toHaveFocus()
  expect([draft.selectionStart, draft.selectionEnd]).toEqual([2, 5])
  expect(document.querySelectorAll('textarea')).toHaveLength(1)
})

it('copies and says so for a moment', async () => {
  vi.useFakeTimers()
  render(<CopyButton text="hello" />)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy' })))
  expect(writeText).toHaveBeenCalledWith('hello')
  expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
  act(() => vi.advanceTimersByTime(1500))
  expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
})

it('names an icon-only button', async () => {
  render(<CopyButton text="x" label="Copy reply" iconOnly />)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy reply' })))
  expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
})

it('reports a failed copy', async () => {
  writeText.mockRejectedValue(new Error('denied'))
  render(<CopyButton text="x" />)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy' })))
  expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument()
  expect(useNotices.getState().notices[0]).toMatchObject({ kind: 'error', title: "Couldn't copy the text" })
})

it('names what it could not copy', async () => {
  writeText.mockRejectedValue(new Error('denied'))
  render(<CopyButton text="x" label="Copy reply" iconOnly />)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy reply' })))
  expect(useNotices.getState().notices[0]).toMatchObject({ kind: 'error', title: "Couldn't copy the reply" })
})

it('falls back to a textarea without the Clipboard API', async () => {
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
  const exec = vi.fn(() => true)
  Object.defineProperty(document, 'execCommand', { value: exec, configurable: true })
  expect(await copyText('plain')).toBe(true)
  expect(exec).toHaveBeenCalledWith('copy')
  exec.mockReturnValue(false)
  expect(await copyText('plain')).toBe(false)
  expect(document.querySelector('textarea')).toBeNull()
})
