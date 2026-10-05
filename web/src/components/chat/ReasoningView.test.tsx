import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import ReasoningView from './ReasoningView'

const { parses } = vi.hoisted(() => ({ parses: vi.fn() }))
vi.mock('../markdown/Markdown', () => ({
  default: ({ text }: { text: string }) => { parses(text); return <p>{text}</p> },
}))

beforeEach(() => parses.mockClear())

it('parses reasoning only while expanded and opens the latest streamed text', async () => {
  const view = render(<ReasoningView text="first" />)
  view.rerender(<ReasoningView text="latest" />)
  expect(parses).not.toHaveBeenCalled()
  await userEvent.click(screen.getByText('Thinking'))
  expect(await screen.findByText('latest')).toBeInTheDocument()
  view.rerender(<ReasoningView text="updated while open" />)
  expect(screen.getByText('updated while open')).toBeInTheDocument()
  await userEvent.click(screen.getByText('Thinking'))
  await waitFor(() => expect(screen.queryByText('updated while open')).toBeNull())
  parses.mockClear()
  view.rerender(<ReasoningView text="updated while closed" />)
  expect(parses).not.toHaveBeenCalled()
  await userEvent.click(screen.getByText('Thinking'))
  expect(await screen.findByText('updated while closed')).toBeInTheDocument()
})
