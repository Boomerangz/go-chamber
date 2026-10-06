import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { notify, resetNotices } from '../../stores/notices'
import { resetStore } from '../../stores/session'
import Notices from './Notices'
import { noticePlace } from './noticePlace'

function box(el: Element, r: { top: number; left: number; width: number; height: number }) {
  el.getBoundingClientRect = () => ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON() {} }) as DOMRect
}

function workspace(html: string) {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.append(root)
  return root
}

beforeEach(() => {
  resetStore()
  resetNotices()
  Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true })
})
afterEach(() => document.body.replaceChildren())

describe('noticePlace', () => {
  it('sits at the top of the open transcript, below the chat header and clear of the dock', () => {
    const root = workspace('<div class="layout"><section class="chat"><header class="chat-header"></header><div class="scroll"></div></section></div>')
    box(root.querySelector('.scroll')!, { top: 120, left: 300, width: 1096, height: 600 })
    expect(noticePlace()).toEqual({ top: 132, right: 56, bottom: 'auto', left: 'auto', width: 420 })
  })

  it('narrows to the transcript on a phone', () => {
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true })
    const root = workspace('<div class="layout"><section class="chat"><div class="scroll"></div></section></div>')
    box(root.querySelector('.scroll')!, { top: 100, left: 0, width: 390, height: 500 })
    expect(noticePlace()).toMatchObject({ top: 112, right: 12, width: 366 })
  })

  it('uses the empty workspace when no session is open', () => {
    const root = workspace('<div class="layout"><div class="chat empty"></div></div>')
    box(root.querySelector('.chat')!, { top: 44, left: 300, width: 1096, height: 856 })
    expect(noticePlace()).toMatchObject({ top: 56, right: 56 })
  })

  it('leaves the place to CSS when neither is on screen (a phone showing the list)', () => {
    workspace('<div class="layout"><section class="chat"><div class="scroll"></div></section></div>')
    expect(noticePlace()).toBeNull()
  })

  it('places the stack it renders', () => {
    const root = workspace('<div class="layout"><div class="chat empty"></div></div>')
    box(root.querySelector('.chat')!, { top: 44, left: 300, width: 1096, height: 856 })
    render(<Notices />)
    act(() => void notify({ kind: 'error', title: 'Broke', text: 'it did' }))
    const stack = screen.getByRole('alert').parentElement!
    expect(stack).toHaveStyle({ top: '56px', right: '56px' })
  })
})
