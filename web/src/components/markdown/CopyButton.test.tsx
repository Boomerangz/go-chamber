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
  expect(useNotices.getState().notices[0]).toMatchObject({ kind: 'error', title: "Couldn't copy" })
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
