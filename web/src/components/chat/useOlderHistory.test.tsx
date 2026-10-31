import { act, fireEvent, render } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { expect, it, vi } from 'vitest'
import { useOlderHistory } from './useOlderHistory'

it('loads near the top once, preserves the visible row and waits for an explicit retry after errors', () => {
  const load = vi.fn(async () => {})
  const unpin = vi.fn()
  let loadMore!: () => void
  function View({ loading = false, error = null as string | null, older = false }) {
    const ref = useRef<HTMLDivElement>(null)
    const more = useOlderHistory(ref, unpin, { before: older ? 2 : 10, loading, error, load }, older)
    useEffect(() => { loadMore = more }, [more])
    return <div ref={ref} data-testid="scroll">{older && <div data-row="old" />}<div data-row="current" /></div>
  }
  const view = render(<View />)
  const el = view.getByTestId('scroll')
  let top = 20
  const row = el.querySelector('[data-row="current"]')!
  row.getBoundingClientRect = () => ({ top, bottom: top + 40 }) as DOMRect
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 1000 })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: 400 })
  el.scrollTop = 50
  fireEvent.scroll(el)
  fireEvent.scroll(el)
  expect(load).toHaveBeenCalledTimes(1)
  expect(unpin).toHaveBeenCalledTimes(1)
  view.rerender(<View loading />)
  top = 220
  view.rerender(<View older />)
  expect(el.scrollTop).toBe(250)
  view.rerender(<View error="offline" />)
  fireEvent.scroll(el)
  expect(load).toHaveBeenCalledTimes(1)
  act(() => loadMore())
  expect(load).toHaveBeenCalledTimes(2)
})
