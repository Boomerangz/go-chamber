import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

// The title keeps at least this much before the settings fold away.
const TITLE_MIN = 160

// useHeaderFold tells when the chat header's settings (model, mode,
// approvals, fork) no longer fit on its one row beside the title and the
// status: they then fold behind "⋯". It measures what the row would need
// unfolded, so folding never flips back and forth, and it follows the
// header's width (a dock opening beside the chat) and its contents (another
// mode, a longer usage line). A phone folds by its own rules.
export function useHeaderFold(header: RefObject<HTMLElement | null>): boolean {
  const [fold, setFold] = useState(false)
  const folded = useRef(fold)
  useLayoutEffect(() => {
    folded.current = fold
  })
  // The settings' width when last seen unfolded; folded, they have none.
  const toolsWidth = useRef(0)
  useLayoutEffect(() => {
    const el = header.current
    if (!el) return
    const check = () => {
      if (window.matchMedia?.('(max-width: 720px)').matches) {
        setFold(false)
        return
      }
      const meta = el.querySelector<HTMLElement>('.chat-meta')
      const tools = el.querySelector<HTMLElement>('.chat-tools')
      if (!meta) return
      const style = getComputedStyle(el)
      const gap = parseFloat(style.columnGap) || 0
      const metaGap = parseFloat(getComputedStyle(meta).columnGap) || 0
      const avail = el.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0)
      let rest = 0
      let parts = 0
      let width = 0
      let settings = 0
      for (const item of rowItems(meta)) {
        if (tools?.contains(item)) {
          width += item.getBoundingClientRect().width
          settings++
        } else {
          // Its whole text, even while the row cuts it.
          rest += item.scrollWidth
          parts++
        }
      }
      if (!folded.current) toolsWidth.current = width + settings * metaGap
      const avatar = el.querySelector<HTMLElement>(':scope > .avatar')
      const need = (avatar ? avatar.offsetWidth + gap : 0) + TITLE_MIN + gap + rest + Math.max(0, parts - 1) * metaGap + toolsWidth.current
      setFold(need > avail)
    }
    check()
    if (typeof ResizeObserver === 'undefined') return
    const resize = new ResizeObserver(check)
    resize.observe(el)
    const changes = new MutationObserver(check)
    changes.observe(el, { subtree: true, childList: true, characterData: true })
    return () => {
      resize.disconnect()
      changes.disconnect()
    }
  }, [header])
  return fold
}

// rowItems lists the boxes laid out in a flex row, looking through
// display: contents wrappers and skipping what isn't shown.
function rowItems(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = []
  for (const child of Array.from(el.children) as HTMLElement[]) {
    const display = getComputedStyle(child).display
    if (display === 'none') continue
    if (display === 'contents') out.push(...rowItems(child))
    else out.push(child)
  }
  return out
}
