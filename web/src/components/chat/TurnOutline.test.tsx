import { fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { expect, it, vi } from 'vitest'
import TurnOutline from './TurnOutline'

const entries = [
  { id: 'u1', n: 1, text: 'Объясни архитектуру' },
  { id: 'u2', n: 2, text: 'run the tests' },
]

function scroller() {
  const root = document.createElement('div')
  for (const e of entries) {
    const row = document.createElement('li')
    row.dataset.row = e.id
    row.scrollIntoView = vi.fn()
    root.appendChild(row)
  }
  document.body.appendChild(root)
  const ref = createRef<HTMLDivElement>() as { current: HTMLDivElement | null }
  ref.current = root as HTMLDivElement
  return ref
}

it('lists the turns by number and goes to the one picked', () => {
  const ref = scroller()
  render(<TurnOutline entries={entries} scrollRef={ref} reduced />)
  const nav = screen.getByRole('navigation', { name: 'Turns' })
  expect(nav).toHaveTextContent('1Объясни архитектуру')
  fireEvent.click(screen.getByRole('button', { name: /2\s*run the tests/ }))
  const row = ref.current!.querySelector<HTMLElement>('[data-row="u2"]')!
  expect(row.scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' })
})

it('marks the turn being read as current', () => {
  const ref = scroller()
  render(<TurnOutline entries={entries} scrollRef={ref} reduced={false} />)
  // jsdom lays nothing out: every row sits at the top, so the last is current
  fireEvent.scroll(ref.current!)
  expect(screen.getByRole('button', { name: /run the tests/ })).toHaveAttribute('aria-current', 'location')
  fireEvent.click(screen.getByRole('button', { name: /Объясни/ }))
  const row = ref.current!.querySelector<HTMLElement>('[data-row="u1"]')!
  expect(row.scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' })
})

it('draws nothing for a transcript of one turn', () => {
  const { container } = render(<TurnOutline entries={entries.slice(0, 1)} scrollRef={scroller()} reduced />)
  expect(container).toBeEmptyDOMElement()
})

it('keeps a picked turn current until the owner scrolls by hand', () => {
  const ref = scroller()
  render(<TurnOutline entries={entries} scrollRef={ref} reduced />)
  fireEvent.scroll(ref.current!)
  fireEvent.click(screen.getByRole('button', { name: /Объясни/ }))
  expect(screen.getByRole('button', { name: /Объясни/ })).toHaveAttribute('aria-current', 'location')
  fireEvent.wheel(ref.current!)
  expect(screen.getByRole('button', { name: /run the tests/ })).toHaveAttribute('aria-current', 'location')
})

it('marks the turn at the upper third while the transcript scrolls', () => {
  const ref = scroller()
  const root = ref.current!
  Object.defineProperty(root, 'scrollHeight', { configurable: true, value: 2000 })
  Object.defineProperty(root, 'clientHeight', { configurable: true, value: 300 })
  const at = (id: string, top: number) =>
    (root.querySelector<HTMLElement>(`[data-row="${id}"]`)!.getBoundingClientRect = () => ({ top }) as DOMRect)
  at('u1', 20)
  at('u2', 900)
  render(<TurnOutline entries={entries} scrollRef={ref} reduced />)
  expect(screen.getByRole('button', { name: /Объясни/ })).toHaveAttribute('aria-current', 'location')
})
