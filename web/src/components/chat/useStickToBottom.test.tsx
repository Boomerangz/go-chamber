import { act, render } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useStickToBottom } from './useStickToBottom'

let report: () => void = () => {}
const observed: Element[] = []
class Observer {
  constructor(cb: () => void) {
    report = cb
  }
  observe(el: Element) {
    observed.push(el)
  }
  disconnect() {}
}

let unpin: () => void = () => {}
let recheck: () => void = () => {}
let pinned = true
function Chat({ dep }: { dep: number }) {
  const [ref, stick] = useStickToBottom(dep, [])
  useEffect(() => {
    unpin = stick.unpin
    recheck = stick.recheck
    pinned = stick.pinned
  })
  return (
    <div ref={ref} data-testid="scroll">
      <ol className="items" />
    </div>
  )
}

describe('useStickToBottom recheck', () => {
  it('pins again a view that a jump left at its end, as a short chat is', () => {
    const { getByTestId } = render(<Chat dep={0} />)
    const el = getByTestId('scroll')
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 300 })
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 300 })
    act(() => unpin())
    expect(pinned).toBe(false)
    // Nothing to scroll: no scroll event would ever pin it again.
    act(() => recheck())
    expect(pinned).toBe(true)
    // A view left above its end stays unpinned.
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 900 })
    act(() => unpin())
    act(() => recheck())
    expect(pinned).toBe(false)
  })
})

describe('useStickToBottom', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    observed.length = 0
  })

  it('follows the end when rows grow after layout, unless the owner scrolled up', () => {
    // Rows drawn later than they mount (sizes measured a frame on, rows off
    // screen laid out when they come near) push the end down.
    vi.stubGlobal('ResizeObserver', Observer)
    const { getByTestId } = render(<Chat dep={1} />)
    const el = getByTestId('scroll')
    expect(observed).toContain(el.querySelector('.items'))
    let height = 500
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => height })
    height = 900
    act(() => report())
    expect(el.scrollTop).toBe(900)
    act(() => unpin())
    height = 1400
    act(() => report())
    expect(el.scrollTop).toBe(900)
  })
})
