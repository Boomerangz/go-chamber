import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import Keys from './Keys'

const boxes = (el: Element) => [...el.querySelectorAll('kbd')].map((k) => k.textContent)

describe('Keys', () => {
  it('draws one key per box, alternatives apart', () => {
    const { container } = render(<Keys keys="a · s · d" />)
    const keys = container.querySelector('.keys')!
    expect(boxes(keys)).toEqual(['a', 's', 'd'])
    expect(keys.querySelectorAll('.keys-or')).toHaveLength(2)
    expect(keys).toHaveTextContent('a · s · d')
  })

  it('takes a chord apart and puts its word after a space', () => {
    const { container } = render(<Keys keys="⇧↵" label="newline" />)
    const keys = container.querySelector('.keys')!
    expect(boxes(keys)).toEqual(['⇧', '↵'])
    expect(keys.querySelector('.keys-label')).toHaveTextContent('newline')
    expect(keys).toHaveTextContent('⇧↵ newline')
  })
})
