import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import FolderField from './FolderField'

vi.mock('../../lib/api', () => ({ listFolders: vi.fn() }))

afterEach(() => vi.unstubAllGlobals())

describe('FolderField', () => {
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
