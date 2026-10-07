import { useEffect, type RefObject } from 'react'

// useListAnchor keeps the session rows you are looking at where they are on
// screen while the list changes around them: a session getting busy moves
// up its group, a new folder comes in on top, a row gains a mark, and
// everything under it would slide down and out of sight. A browser's own
// scroll anchoring can't be relied on here: React reorders rows by moving
// their nodes, and a moved node loses its anchor. So the row in sight (the
// open session's first, or what the owner just pressed) is noted whenever
// the list scrolls, and after any change inside the list it is put back
// where it was. A list read from the top is left alone, so what is new
// shows up there.
// top is the row's place in the list, not on screen: whatever moves the
// whole list (a form unfolding above it on a phone) isn't undone.
type Anchor = { row: HTMLElement; top: number }

export function useListAnchor(of: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const list = of.current
    if (!list) return
    let anchor: Anchor | null = null
    const note = () => {
      anchor = anchorIn(list)
    }
    const restore = () => {
      const scroller = scrollerOf(list)
      if (scroller && anchor?.row.isConnected) {
        const moved = offsetIn(list, anchor.row) - anchor.top
        if (moved !== 0) scroller.scrollTop += moved
      }
      note()
    }
    // the scroller is the list itself on a wide screen and the sidebar on a
    // phone, so scrolls are heard wherever they happen around the list
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && e.target.contains(list)) note()
    }
    document.addEventListener('scroll', onScroll, true)
    // what the owner presses stays under their finger: folding a group by
    // its header doesn't scroll the header away to keep the open row put
    const onPress = (e: Event) => {
      const pressed = e.target instanceof Element ? e.target.closest<HTMLElement>('button, summary, a') : null
      if (pressed && list.contains(pressed)) anchor = { row: pressed, top: offsetIn(list, pressed) }
    }
    list.addEventListener('pointerdown', onPress, true)
    list.addEventListener('keydown', onPress, true)
    const mutations = new MutationObserver(restore)
    mutations.observe(list, { childList: true, subtree: true, characterData: true, attributes: true })
    const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(restore)
    sizes?.observe(list)
    note()
    return () => {
      document.removeEventListener('scroll', onScroll, true)
      list.removeEventListener('pointerdown', onPress, true)
      list.removeEventListener('keydown', onPress, true)
      mutations.disconnect()
      sizes?.disconnect()
    }
  }, [of])
}

function anchorIn(list: HTMLElement): Anchor | null {
  const scroller = scrollerOf(list)
  if (!scroller || scroller.scrollTop <= 0) return null
  const view = scroller.getBoundingClientRect()
  const open = list.querySelector<HTMLElement>('button.session[aria-current="true"]')
  if (open) {
    const r = open.getBoundingClientRect()
    if (r.height > 0 && r.bottom > view.top && r.top < view.bottom) return { row: open, top: offsetIn(list, open) }
  }
  for (const row of list.querySelectorAll<HTMLElement>('button.session')) {
    const r = row.getBoundingClientRect()
    if (r.height > 0 && r.top >= view.top && r.bottom <= view.bottom) return { row, top: offsetIn(list, row) }
  }
  return null
}

const offsetIn = (list: HTMLElement, row: HTMLElement) => row.getBoundingClientRect().top - list.getBoundingClientRect().top

// scrollerOf is the box the list scrolls in: the list itself on a wide
// screen, the whole sidebar on a phone.
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p: HTMLElement | null = el; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY
    if (y === 'auto' || y === 'scroll') return p
  }
  return null
}
