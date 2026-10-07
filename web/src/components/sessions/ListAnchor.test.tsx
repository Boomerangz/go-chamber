import { render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ListAnchor from './ListAnchor'

// Layout is faked the way a browser would lay the list out: rows stack in
// DOM order, each 50px tall unless it says otherwise, and show shifted by
// how far the list is scrolled; the scroller shows 0-400 of it.
const size = (row: HTMLElement) => Number(row.dataset.size ?? 50)
const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) }) as DOMRect

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const scroller = this.closest<HTMLElement>('[data-testid="scroller"]')
    if (!scroller) return rect(0, 0)
    if (this === scroller) return rect(0, 400)
    let top = 0
    for (const row of scroller.querySelectorAll<HTMLElement>('button.session')) {
      if (row === this) return rect(top - scroller.scrollTop, size(row))
      top += size(row)
    }
    return rect(0, 0)
  })
})
afterEach(() => vi.restoreAllMocks())

const body = createRef<HTMLDivElement>()
function List({ order, active, tall, watch = order }: { order: string[]; active?: string; tall?: string; watch?: unknown }) {
  return (
    <div data-testid="scroller" style={{ overflowY: 'auto' }}>
      <ListAnchor of={body} watch={[watch]}>
        <div ref={body}>
          {order.map((id) => (
            <button key={id} className="session" data-session={id} aria-current={id === active ? 'true' : undefined} data-size={id === tall ? 80 : undefined}>
              {id}
            </button>
          ))}
        </div>
      </ListAnchor>
    </div>
  )
}

const rows = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`)

describe('ListAnchor', () => {
  it('keeps the rows on screen where they were when a group moves in above them', () => {
    const view = render(<List order={rows(20)} />)
    const scroller = view.getByTestId('scroller')
    scroller.scrollTop = 500
    // a busy folder's rows jump from the bottom to the top: 3 rows, 150px
    view.rerender(<List order={['b0', 'b1', 'b2', ...rows(20)]} />)
    expect(scroller.scrollTop).toBe(650)
  })

  it("holds on to the open session's row first, when it is in sight", () => {
    const view = render(<List order={rows(20)} active="r12" />)
    const scroller = view.getByTestId('scroller')
    scroller.scrollTop = 500
    // r11 grows by 30 (a longer title wraps): r12 below it is followed,
    // not r10 at the top of the view
    view.rerender(<List order={rows(20)} active="r12" tall="r11" watch="grown" />)
    expect(scroller.scrollTop).toBe(530)
  })

  it('leaves a list read from the top alone: what is new shows up there', () => {
    const view = render(<List order={rows(20)} />)
    const scroller = view.getByTestId('scroller')
    view.rerender(<List order={['b0', ...rows(20)]} />)
    expect(scroller.scrollTop).toBe(0)
  })

  it('stays out of the way when what it watches did not change', () => {
    const view = render(<List order={rows(20)} watch="same" />)
    const scroller = view.getByTestId('scroller')
    scroller.scrollTop = 500
    view.rerender(<List order={['b0', ...rows(20)]} watch="same" />)
    expect(scroller.scrollTop).toBe(500)
  })
})
