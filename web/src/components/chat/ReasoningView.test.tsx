import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ReasoningView from './ReasoningView'

const { parses } = vi.hoisted(() => ({ parses: vi.fn() }))
vi.mock('../markdown/Markdown', () => ({
  default: ({ text }: { text: string }) => { parses(text); return <p>{text}</p> },
}))

beforeEach(() => parses.mockClear())
afterEach(() => vi.useRealTimers())

it('parses reasoning only while expanded and opens the latest streamed text', async () => {
  const view = render(<ReasoningView text="first" />)
  view.rerender(<ReasoningView text="latest" />)
  expect(parses).not.toHaveBeenCalled()
  await userEvent.click(screen.getByText('Thought'))
  expect(await screen.findByText('latest')).toBeInTheDocument()
  view.rerender(<ReasoningView text="updated while open" />)
  expect(screen.getByText('updated while open')).toBeInTheDocument()
  await userEvent.click(screen.getByText('Thought'))
  await waitFor(() => expect(screen.queryByText('updated while open')).toBeNull())
  parses.mockClear()
  view.rerender(<ReasoningView text="updated while closed" />)
  expect(parses).not.toHaveBeenCalled()
  await userEvent.click(screen.getByText('Thought'))
  expect(await screen.findByText('updated while closed')).toBeInTheDocument()
})

it('says it is still thinking and previews the newest line while the reasoning streams', () => {
  const { container } = render(<ReasoningView text={'Look at the code.\n\n**Then** fix it\n\n'} streaming />)
  expect(screen.getByText('Thinking…').closest('summary')).toHaveClass('streaming')
  const preview = container.querySelector('.reasoning-preview')!
  expect(preview).toHaveTextContent(/^Then fix it$/)
  expect(preview).toHaveAttribute('title', 'Then fix it')
})

it('shows no preview before any thought arrives', () => {
  const { container } = render(<ReasoningView text={'\n  \n'} streaming />)
  expect(container.querySelector('.reasoning-preview')).toBeNull()
})

it('hides the preview while the thoughts are open', async () => {
  const { container } = render(<ReasoningView text="a line" streaming />)
  await userEvent.click(screen.getByText('Thinking…'))
  expect(container.querySelector('.reasoning-preview')).toBeNull()
})

it('says how long it thought when it saw the thinking start', () => {
  vi.useFakeTimers({ now: 0 })
  const view = render(<ReasoningView text="x" streaming />)
  vi.setSystemTime(4200)
  view.rerender(<ReasoningView text="x" />)
  const summary = screen.getByText('Thought for 4s').closest('summary')!
  expect(summary).not.toHaveClass('streaming')
  vi.setSystemTime(9000)
  view.rerender(<ReasoningView text="x more" />)
  expect(screen.getByText('Thought for 4s')).toBeInTheDocument()
})

it('rounds a quick thought up to a second and reads minutes past a minute', () => {
  vi.useFakeTimers({ now: 0 })
  const quick = render(<ReasoningView text="x" streaming />)
  vi.setSystemTime(200)
  quick.rerender(<ReasoningView text="x" />)
  expect(screen.getByText('Thought for 1s')).toBeInTheDocument()
  quick.unmount()
  vi.setSystemTime(0)
  const slow = render(<ReasoningView text="x" streaming />)
  vi.setSystemTime(125_000)
  slow.rerender(<ReasoningView text="x" />)
  expect(screen.getByText('Thought for 2m 5s')).toBeInTheDocument()
})
