import { act, render } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useClip, type Clip } from './useClip'

let seen: Clip | undefined
function Box() {
  const [ref, clip] = useClip<HTMLDivElement>([])
  useEffect(() => {
    seen = clip
  })
  return <div ref={ref} />
}

describe('useClip', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('measures when the observer reports, not while the page is being built', () => {
    // Reading a size in a layout effect forces a layout per box: hundreds of
    // them when a long transcript opens.
    let report: () => void = () => {}
    class Observer {
      constructor(cb: () => void) {
        report = cb
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', Observer)
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(900)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(280)
    render(<Box />)
    expect(height).not.toHaveBeenCalled()
    expect(seen?.clipped).toBe(false)
    act(() => report())
    expect(seen?.clipped).toBe(true)
  })

  it('measures at once without an observer', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(900)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(280)
    render(<Box />)
    expect(seen?.clipped).toBe(true)
  })
})
