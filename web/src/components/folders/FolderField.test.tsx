import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import FolderField from './FolderField'

vi.mock('../../lib/api', () => ({ listFolders: vi.fn() }))

afterEach(() => vi.unstubAllGlobals())

describe('FolderField', () => {
  it('fades its left edge while the path is scrolled past its start', () => {
    render(<FolderField label="Working directory" placeholder="" value="/Users/me/work/api-server" onChange={() => {}} />)
    const input = screen.getByLabelText('Working directory') as HTMLInputElement
    const field = input.closest('.folder-field')!
    Object.defineProperty(input, 'scrollWidth', { configurable: true, value: 400 })
    Object.defineProperty(input, 'clientWidth', { configurable: true, value: 200 })
    input.scrollLeft = 200
    fireEvent.scroll(input)
    expect(field).toHaveAttribute('data-fade', 'start')
    // typing at its start: the first glyph is whole, no fade
    input.scrollLeft = 0
    fireEvent.scroll(input)
    expect(field).not.toHaveAttribute('data-fade')
  })

  it('shows the end of the path again once a hidden field gets its width', () => {
    let resized = () => {}
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          resized = cb
        }
        observe() {}
        disconnect() {}
      },
    )
    render(<FolderField label="Working directory" placeholder="" value="/a/long/path/to/project" onChange={() => {}} />)
    const input = screen.getByLabelText('Working directory') as HTMLInputElement
    // hidden while the value was set: nothing to scroll then
    input.scrollLeft = 0
    Object.defineProperty(input, 'scrollWidth', { configurable: true, value: 400 })
    resized()
    expect(input.scrollLeft).toBe(400)
    // not while the owner types in it
    input.focus()
    input.scrollLeft = 0
    resized()
    expect(input.scrollLeft).toBe(0)
  })
})
