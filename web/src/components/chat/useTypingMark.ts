import { useEffect, type RefObject } from 'react'
import { matches } from './useMedia'

// How long the on-screen keyboard may take to come up before the field is
// brought into view anyway.
const KEYBOARD_MS = 400

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
    const onOut = (e: FocusEvent) => {
      // Focus moving on to another of the chat's fields keeps the mark.
      if (isTextField(e.relatedTarget) && el.contains(e.relatedTarget)) return
      settle()
      if (html.dataset.typing === 'chat') delete html.dataset.typing
    }
    el.addEventListener('focusin', onIn)
    el.addEventListener('focusout', onOut)
    return () => {
      el.removeEventListener('focusin', onIn)
      el.removeEventListener('focusout', onOut)
      settle()
      if (html.dataset.typing === 'chat') delete html.dataset.typing
    }
  }, [root])
}
