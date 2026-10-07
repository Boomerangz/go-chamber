import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

// The title keeps its whole width up to this much (about 17 characters of
// the 20px heading) before the settings fold away and the usage line gives
// way; a title being edited or not known yet keeps TITLE_FALLBACK. A long
// title is cut rather than fold a Codex session's settings at 1440px.
const TITLE_MAX = 200
const TITLE_FALLBACK = 160
// The usage line is cut down to this before the settings fold.
const USAGE_MIN = 72
// "⋯" where it isn't shown yet (it is a 28px icon button).
const MORE_WIDTH = 28
// The status at its longest, "waiting for you" beside its mark.
const STATUS_MAX = 128

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
      // What the folded row holds besides the title: the usage line may go
      // to nothing there, the rest keeps its width.
      let kept = 0
      for (const item of rowItems(meta)) {
        if (tools?.contains(item)) {
          width += item.getBoundingClientRect().width
          settings++
        } else {
          // Its whole text, even while the row cuts it; the usage line may be
          // cut, so a turn that adds to it doesn't fold the settings away.
          // The status counts as its longest word ("waiting for you"), so a
          // turn starting or asking doesn't either.
          const usage = item.classList.contains('usage')
          const own = usage ? 0 : item.classList.contains('status') ? Math.max(item.scrollWidth, STATUS_MAX) : item.scrollWidth
          rest += usage ? Math.min(item.scrollWidth, USAGE_MIN) : own
          kept += own + gap
          parts++
        }
      }
      if (!folded.current) toolsWidth.current = width + settings * metaGap
      const avatar = el.querySelector<HTMLElement>(':scope > .avatar')
      const heading = el.querySelector<HTMLElement>('.chat-heading h2')
      const titleMin = heading ? Math.min(Math.ceil(heading.scrollWidth), TITLE_MAX) : TITLE_FALLBACK
      // The heading holds this much (CSS reads it), so the usage line is cut first.
      el.style.setProperty('--title-min', `${titleMin}px`)
      const lead = avatar ? avatar.offsetWidth + gap : 0
      // Folded, the row is the title, the status and its tags, the usage
      // line and "⋯": the title holds no more than leaves them room, so the
      // row never wraps (see Chat.css).
      const more = el.querySelector<HTMLElement>(':scope > .chat-more')?.offsetWidth || MORE_WIDTH
      el.style.setProperty('--title-fold-min', `${Math.max(0, Math.min(titleMin, avail - lead - gap - kept - more))}px`)
      const need = lead + titleMin + gap + rest + Math.max(0, parts - 1) * metaGap + toolsWidth.current
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
