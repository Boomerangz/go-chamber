import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  const chat = () =>
    workspace('<div class="layout"><section class="chat"><header class="chat-header"></header><div class="scroll"><ol class="items"></ol></div></section></div>')

  it('sits in the margin right of the transcript column when it fits, never over the column', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1920, configurable: true })
    const root = chat()
    box(root.querySelector('.scroll')!, { top: 120, left: 300, width: 1576, height: 600 })
    box(root.querySelector('.items')!, { top: 120, left: 760, width: 660, height: 400 })
    // margin: 1876 - 1420 = 456; the stack takes it less the insets
    expect(noticePlace()).toEqual({ top: 132, right: 56, bottom: 'auto', left: 'auto', width: 420 })
    box(root.querySelector('.items')!, { top: 120, left: 880, width: 660, height: 400 })
    expect(noticePlace()).toMatchObject({ top: 132, right: 56, width: 312 })
  })

  it('sits above the composer when the margin is too narrow, as wide as the column', () => {
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true })
    const root = chat()
    box(root.querySelector('.scroll')!, { top: 120, left: 300, width: 1096, height: 600 })
    box(root.querySelector('.items')!, { top: 120, left: 518, width: 660, height: 400 })
    // the column's right edge: 1440 - 1178 = 262; above the transcript's end: 900 - 720 + 12
    expect(noticePlace()).toEqual({ top: 'auto', right: 262, bottom: 192, left: 'auto', width: 420 })
  })

  it('narrows to the transcript on a phone', () => {
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true })
    const root = chat()
    box(root.querySelector('.scroll')!, { top: 100, left: 0, width: 390, height: 500 })
    box(root.querySelector('.items')!, { top: 100, left: 0, width: 390, height: 300 })
    expect(noticePlace()).toMatchObject({ bottom: 256, right: 12, width: 366 })
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

  it("offers a notice's action, which also dismisses it", async () => {
    let undone = 0
    render(<Notices />)
    act(() => void notify({ kind: 'info', text: 'Archived x', action: { label: 'Undo', run: () => undone++ } }))
    act(() => screen.getByRole('button', { name: 'Undo' }).click())
    expect(undone).toBe(1)
    expect(screen.queryByText('Archived x')).toBeNull()
  })

  // Fork from a removed worktree: the chat column is put back (or its
  // transcript replaced) after the stack was placed, and the unmerged note
  // then shrinks the new transcript. The stack follows both.
  it('follows a chat column mounted after it was placed, and that column growing smaller', async () => {
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true })
    const observed = new Set<Element>()
    const callbacks: (() => void)[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          callbacks.push(cb)
        }
        observe(el: Element) {
          observed.add(el)
        }
        unobserve(el: Element) {
          observed.delete(el)
        }
        disconnect() {
          observed.clear()
        }
      },
    )
    try {
      const root = workspace('<div class="layout"></div>')
      render(<Notices />)
      act(() => void notify({ kind: 'info', text: 'Worktree removed, branch kept' }))
      const stack = screen.getByRole('status').parentElement!
      const layout = root.querySelector('.layout')!
      layout.innerHTML = '<section class="chat"><div class="scroll"><ol class="items"></ol></div></section>'
      const scroll = layout.querySelector('.scroll')!
      box(scroll, { top: 120, left: 300, width: 1096, height: 600 })
      box(layout.querySelector('.items')!, { top: 120, left: 518, width: 660, height: 400 })
      await act(() => new Promise((r) => setTimeout(r, 50)))
      expect(stack).toHaveStyle({ bottom: '192px' })
      expect(observed.has(scroll)).toBe(true)
      // The note above the composer takes 60px off the transcript.
      box(scroll, { top: 120, left: 300, width: 1096, height: 540 })
      await act(async () => {
        callbacks.forEach((cb) => cb())
        await new Promise((r) => setTimeout(r, 50))
      })
      expect(stack).toHaveStyle({ bottom: '252px' })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
