import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { numberedParts } from './numbered'
import TermTitle from './TermTitle'

describe('TermTitle', () => {
  it('keeps a numbered shell’s number apart from the name that gives way', () => {
    const { container } = render(<TermTitle title="frontend-application 2" className="term-tab-title" />)
    const title = container.firstElementChild!
    expect(title).toHaveClass('numbered', 'term-tab-title')
    expect(title.querySelector('.numbered-name')).toHaveTextContent('frontend-application')
    expect(title.querySelector('.numbered-n')?.textContent).toBe(' 2')
    expect(title.querySelector('.sr-only')?.textContent).toBe('frontend-application 2')
  })

  it('leaves a title without a number whole', () => {
    const { container } = render(<TermTitle title="api" />)
    expect(container.querySelector('.numbered-n')).toBeNull()
    expect(container.textContent).toBe('api')
  })

  it('splits only a trailing number after a space', () => {
    expect(numberedParts('build 12')).toEqual({ name: 'build', n: ' 12' })
    expect(numberedParts('v2')).toEqual({ name: 'v2', n: '' })
    expect(numberedParts('12')).toEqual({ name: '12', n: '' })
  })
})
