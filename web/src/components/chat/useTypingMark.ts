import { useEffect, type RefObject } from 'react'
import { matches } from './useMedia'

// How long the on-screen keyboard may take to come up before the field is
// brought into view anyway.
const KEYBOARD_MS = 400

// How long after a finger lifts its click may still be on the way.
const TAP_MS = 400

// isTextField: a field that takes typed text, the one a phone's keyboard
// comes up for (an option's radio or checkbox doesn't).
function isTextField(el: EventTarget | null): el is HTMLElement {
  if (el instanceof HTMLTextAreaElement) return true
  return el instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(el.type)
}

// useTypingMark: while a text field of the chat has focus on a phone (a
// coarse pointer, ≤720px), the on-screen keyboard takes half the screen.
// The page is marked <html data-typing="chat"> so the chrome can make room
// (the chat header compacts, the pane bar may hide), and a field inside the
// transcript (a question's "Other…") is brought back into view, with its
// card, once the keyboard has resized the page.
export function useTypingMark(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current
    if (!el) return
    const html = document.documentElement
    let pending: (() => void) | null = null
    const settle = () => {
      pending?.()
      pending = null
    }
    const onIn = (e: FocusEvent) => {
      if (!isTextField(e.target) || !matches('(max-width: 720px)') || !matches('(pointer: coarse)')) return
      html.dataset.typing = 'chat'
      const field = e.target
      if (!field.closest('.scroll')) return
      settle()
      const show = () => {
        settle()
        field.closest('.request-slot')?.scrollIntoView?.({ block: 'nearest' })
        field.scrollIntoView?.({ block: 'nearest' })
      }
      const timer = setTimeout(show, KEYBOARD_MS)
      window.addEventListener('resize', show, { once: true })
      pending = () => {
        clearTimeout(timer)
        window.removeEventListener('resize', show)
      }
    }
    const clear = () => {
      if (html.dataset.typing === 'chat' && !isTextField(document.activeElement)) delete html.dataset.typing
    }
    // A tap that takes the focus (Send) must land where it started: the
    // page grows back only once the press is over and its click went. A
    // mouse moves the focus on press; a touch only after the finger lifts,
    // just before the click, so the hold lasts until that click (or, if
    // none comes, a moment after the lift).
    let holding = false
    let cleared: ReturnType<typeof setTimeout> | undefined
    const release = (ms: number) => {
      clearTimeout(cleared)
      cleared = setTimeout(() => {
        holding = false
        clear()
      }, ms)
    }
    const onDown = () => {
      clearTimeout(cleared)
      holding = true
    }
    const onUp = () => {
      if (holding) release(TAP_MS)
    }
    const onClick = () => {
      if (holding) release(0)
    }
    const onOut = (e: FocusEvent) => {
      // Focus moving on to another of the chat's fields keeps the mark.
      if (isTextField(e.relatedTarget) && el.contains(e.relatedTarget)) return
      settle()
      if (!holding) clear()
    }
    el.addEventListener('focusin', onIn)
    el.addEventListener('focusout', onOut)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
    window.addEventListener('click', onClick, true)
    return () => {
      el.removeEventListener('focusin', onIn)
      el.removeEventListener('focusout', onOut)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
      window.removeEventListener('click', onClick, true)
      clearTimeout(cleared)
      settle()
      if (html.dataset.typing === 'chat') delete html.dataset.typing
    }
  }, [root])
}
