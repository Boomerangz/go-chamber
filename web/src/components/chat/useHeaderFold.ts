import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

// The title keeps its whole width up to this much (about 17 characters of
// the 20px heading) before the settings fold away; the usage line gives way
// before any of the title does. A title being edited or not known yet keeps
// TITLE_FALLBACK. A long title is cut rather than fold a Codex session's
// settings at 1440px.
const TITLE_MAX = 200
const TITLE_FALLBACK = 160
// The usage line is cut down to this before the settings fold.
const USAGE_MIN = 72
// "⋯" where it isn't shown yet (it is a 28px icon button).
const MORE_WIDTH = 28
// Beside a worktree's branch the folder line keeps a little of the
// repository's name (3ch), the copy button and their gaps.
const BRANCH_EXTRA = 62
// The branch takes at most this share of the folder line (Chat.css).
const BRANCH_SHARE = 0.7
// Spare pixels the title leaves the rest of the row against rounding.
const SLACK = 2
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
      // What the row holds besides the title and the usage line, as it is
      // now: the status and its tags, each with the gap before it.
      let kept = 0
      let usage: HTMLElement | null = null
      for (const item of rowItems(meta)) {
        if (tools?.contains(item)) {
          width += item.getBoundingClientRect().width
          settings++
        } else if (item.classList.contains('usage')) {
          // Its whole text, even while the row cuts it; the usage line may be
          // cut, so a turn that adds to it doesn't fold the settings away.
          usage = item
          rest += Math.min(item.scrollWidth, USAGE_MIN)
          parts++
        } else {
          // The status counts as its longest word ("waiting for you"), so a
          // turn starting or asking doesn't fold them either.
          rest += item.classList.contains('status') ? Math.max(item.scrollWidth, STATUS_MAX) : item.scrollWidth
          kept += Math.ceil(item.getBoundingClientRect().width)
          parts++
        }
      }
      if (!folded.current) toolsWidth.current = width + settings * metaGap
      const avatar = el.querySelector<HTMLElement>(':scope > .avatar')
      const heading = el.querySelector<HTMLElement>('.chat-heading h2')
      // The title, or a worktree's branch under it, whichever needs more.
      const branch = el.querySelector<HTMLElement>('.chat-path-line .session-branch')
      const branchOwn = branch ? Math.ceil(Math.max(branch.scrollWidth + BRANCH_EXTRA, branch.scrollWidth / BRANCH_SHARE)) : 0
      // The settings fold only for a title (its text) cut below this; a
      // longer title is cut instead.
      const titleMin = heading ? Math.min(Math.max(Math.ceil(heading.scrollWidth), branchOwn), TITLE_MAX) : TITLE_FALLBACK
      // Whole, the title is its text and beside it the rename pencil (a
      // finger's 36px on a touch screen) with its gap. The pencil is measured
      // itself: the title's box may stretch to the heading's width.
      const pencil = heading?.parentElement?.querySelector<HTMLElement>(':scope > .rename-btn')
      const beside = pencil ? pencil.getBoundingClientRect().width + (parseFloat(getComputedStyle(pencil.parentElement!).columnGap) || 0) : 0
      const own = Math.max(heading ? Math.ceil(heading.scrollWidth + beside) : 0, branchOwn)
      const lead = avatar ? avatar.offsetWidth + gap : 0
      const more = el.querySelector<HTMLElement>(':scope > .chat-more')?.offsetWidth || MORE_WIDTH
      const need = lead + titleMin + gap + rest + Math.max(0, parts - 1) * metaGap + toolsWidth.current
      const fold = need > avail
      // The title (with a worktree's branch) comes before the usage line:
      // the heading holds all of it that leaves the rest of the row room
      // (CSS reads these), and only what is left goes to the usage line.
      // Unfolded the rest is the status, its tags and the settings, in the
      // meta block; folded it is the status, its tags and "⋯", each beside
      // the title. Either way the usage line keeps the gap before it.
      const others = parts - (usage ? 1 : 0)
      const besides = fold
        ? lead + kept + (others + (usage ? 1 : 0)) * gap + more + gap
        : lead + gap + kept + toolsWidth.current + Math.max(0, others - 1) * metaGap + (usage ? metaGap : 0)
      // Widths are read rounded: a pixel or two to spare keeps "⋯" on the row.
      const room = Math.max(0, Math.floor(avail - besides) - SLACK)
      const whole = heading ? own : TITLE_FALLBACK
      const fit = Math.min(whole, room)
      el.style.setProperty('--title-min', `${Math.max(titleMin, fit)}px`)
      el.style.setProperty('--title-fold-min', `${fit}px`)
      // What is left for the usage line: cut, it keeps a readable part of
      // itself or none at all, never a stub of a few characters.
      if (usage) {
        const left = room - whole
        if (left < Math.min(usage.scrollWidth, USAGE_MIN)) el.setAttribute('data-usage', 'off')
        else el.removeAttribute('data-usage')
      }
      setFold(fold)
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
