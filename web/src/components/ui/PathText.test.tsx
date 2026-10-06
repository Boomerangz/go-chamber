import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/home', () => ({ useHome: () => '/Users/me' }))
import PathText from './PathText'

describe('PathText', () => {
  it('keeps the last folder apart from the folders above it, home as ~', () => {
    const { container } = render(<PathText path="/Users/me/Develop/app" className="term-cwd" />)
    const el = container.firstElementChild!
    expect(el).toHaveClass('path-text', 'term-cwd')
    expect(el).toHaveAttribute('title', '/Users/me/Develop/app')
    expect(el.querySelector('.path-head')).toHaveTextContent('~/Develop/')
    expect(el.querySelector('.path-tail')).toHaveTextContent('app')
    expect(el).toHaveTextContent('~/Develop/app')
  })

  it('shows a bare folder without an empty head', () => {
    const { container } = render(<PathText path="/Users/me" />)
    expect(container.querySelector('.path-head')).toBeNull()
    expect(container.querySelector('.path-tail')).toHaveTextContent('~')
  })
})
