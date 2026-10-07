import { Component, type ReactNode, type RefObject } from 'react'

// ListAnchor keeps the session rows you are looking at where they are on
// screen while the list changes around them: another folder getting busy
// moves its group to the top, and everything under it would slide down and
// out of sight. A browser's own scroll anchoring can't help here: React
// reorders the groups by moving their nodes, and a moved node loses its
// anchor. So the row in sight (the open session's first) is measured before
// the change and the list scrolled by however far it went. A list read from
// the top is left alone, so what is new shows up there.
//
// It is a class for getSnapshotBeforeUpdate: the one place React offers to
// read the layout before a change is put on screen.
type Props = { of: RefObject<HTMLElement | null>; watch: unknown[]; children: ReactNode }
type Anchor = { row: HTMLElement; scroller: HTMLElement; top: number }

export default class ListAnchor extends Component<Props> {
  getSnapshotBeforeUpdate(prev: Props): Anchor | null {
    const changed = prev.watch.length !== this.props.watch.length || prev.watch.some((w, i) => w !== this.props.watch[i])
    return changed ? anchorIn(this.props.of.current) : null
  }

  componentDidUpdate(_prev: Props, _state: unknown, anchor: Anchor | null) {
    if (!anchor?.row.isConnected) return
    const moved = anchor.row.getBoundingClientRect().top - anchor.top
    if (moved !== 0) anchor.scroller.scrollTop += moved
  }

  render() {
    return this.props.children
  }
}

function anchorIn(list: HTMLElement | null): Anchor | null {
  const scroller = list && scrollerOf(list)
  if (!list || !scroller || scroller.scrollTop <= 0) return null
  const view = scroller.getBoundingClientRect()
  const inView = (r: DOMRect) => r.height > 0 && r.top >= view.top && r.bottom <= view.bottom
  const open = list.querySelector<HTMLElement>('button.session[aria-current="true"]')
  const rows = open ? [open, ...list.querySelectorAll<HTMLElement>('button.session')] : [...list.querySelectorAll<HTMLElement>('button.session')]
  for (const row of rows) {
    const r = row.getBoundingClientRect()
    if (inView(r)) return { row, scroller, top: r.top }
  }
  return null
}

// scrollerOf is the box the list scrolls in: the list itself on a wide
// screen, the whole sidebar on a phone.
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p: HTMLElement | null = el; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY
    if (y === 'auto' || y === 'scroll') return p
  }
  return null
}
