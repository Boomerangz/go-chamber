import { act, fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useListAnchor } from './useListAnchor'

// Layout is faked the way a browser would lay the list out: rows stack in
// DOM order, each 50px tall unless it says otherwise, and show shifted by
// how far the list is scrolled; the scroller shows 0-400 of it, and the
// list itself starts at the top of what it scrolled.
const size = (row: HTMLElement) => Number(row.dataset.size ?? 50)
const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) }) as DOMRect

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const scroller = this.closest<HTMLElement>('[data-testid="scroller"]')
    if (!scroller) return rect(0, 0)
    if (this === scroller) return rect(0, 400)
    const rows = [...scroller.querySelectorAll<HTMLElement>('button.session')]
    if (this.dataset.list !== undefined) return rect(-scroller.scrollTop, rows.reduce((h, r) => h + size(r), 0))
    let top = 0
    for (const row of rows) {
      if (row === this) return rect(top - scroller.scrollTop, size(row))
      top += size(row)
    }
    return rect(0, 0)
  })
})
afterEach(() => vi.restoreAllMocks())

function List({ order, active, tall, other }: { order: string[]; active?: string; tall?: string; other?: string }) {
  const body = useRef<HTMLDivElement>(null)
  useListAnchor(body)
  return (
    <div data-testid="scroller" style={{ overflowY: 'auto' }}>
      <div ref={body} data-list="">
        {order.map((id) => (
          <button key={id} className="session" data-session={id} aria-current={id === active ? 'true' : undefined} data-size={id === tall ? 80 : undefined}>
            {id}
            {other}
          </button>
        ))}
      </div>
    </div>
  )
}

const rows = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`)

// read scrolls the list the way its owner does, and lets the list note it
function read(scroller: HTMLElement, top: number) {
  scroller.scrollTop = top
  fireEvent.scroll(scroller)
}

// settle lets the list's observers see what changed
const settle = () => act(async () => {})

describe('useListAnchor', () => {
  it('keeps the rows on screen where they were when rows come in above them', async () => {
    const view = render(<List order={rows(20)} />)
    const scroller = view.getByTestId('scroller')
    read(scroller, 500)
    // a busy session moves up from below: rows come in above, 150px
    view.rerender(<List order={['b0', 'b1', 'b2', ...rows(20)]} />)
    await settle()
    expect(scroller.scrollTop).toBe(650)
  })

  it("holds on to the open session's row first, also when its bottom edge is a hair out of sight", async () => {
    const view = render(<List order={rows(20)} active="r17" />)
    const scroller = view.getByTestId('scroller')
    // r17 spans 850-900: shown 350.5-400.5, half a pixel past the edge
    read(scroller, 499.5)
    // r16 grows by 30 (a longer title wraps): r17 is followed, not r10
    view.rerender(<List order={rows(20)} active="r17" tall="r16" />)
    await settle()
    expect(scroller.scrollTop).toBe(529.5)
  })

  it('follows changes that come from anywhere, not only the session list', async () => {
    const view = render(<List order={rows(20)} active="r12" />)
    const scroller = view.getByTestId('scroller')
    read(scroller, 500)
    view.rerender(<List order={rows(20)} active="r12" tall="r11" other=" new" />)
    await settle()
    expect(scroller.scrollTop).toBe(530)
  })

  it('leaves a list read from the top alone: what is new shows up there', async () => {
    const view = render(<List order={rows(20)} />)
    const scroller = view.getByTestId('scroller')
    view.rerender(<List order={['b0', ...rows(20)]} />)
    await settle()
    expect(scroller.scrollTop).toBe(0)
  })

  it('keeps what the owner presses under their finger, before the open row', async () => {
    const view = render(<List order={rows(20)} active="r15" />)
    const scroller = view.getByTestId('scroller')
    read(scroller, 500)
    // pressing r11 (say, to fold what it heads) shrinks the rows under it:
    // r11 stays put, and the open r15 below goes up with the rest
    fireEvent.pointerDown(view.getByRole('button', { name: 'r11' }))
    view.rerender(<List order={rows(20).filter((r) => r !== 'r12' && r !== 'r13')} active="r15" />)
    await settle()
    expect(scroller.scrollTop).toBe(500)
  })

  it('goes where the owner scrolls', async () => {
    const view = render(<List order={rows(20)} />)
    const scroller = view.getByTestId('scroller')
    read(scroller, 500)
    read(scroller, 200)
    view.rerender(<List order={['b0', ...rows(20)]} />)
    await settle()
    expect(scroller.scrollTop).toBe(250)
  })
})
