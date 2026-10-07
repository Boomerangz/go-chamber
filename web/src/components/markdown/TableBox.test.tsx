import { describe, expect, it } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import TableBox from './TableBox'
import { fadeOf } from '../../lib/fade'
import Markdown from './Markdown'

describe('fadeOf', () => {
  it('names no edge when the table fits', () => {
    expect(fadeOf(0, 300, 300)).toBe('')
    expect(fadeOf(0, 301, 300)).toBe('')
  })
  it('fades the end while more lies past it', () => {
    expect(fadeOf(0, 500, 300)).toBe('end')
  })
  it('fades the start once scrolled, both edges midway', () => {
    expect(fadeOf(200, 500, 300)).toBe('start')
    expect(fadeOf(198, 500, 300)).toBe('start end')
    expect(fadeOf(2, 500, 300)).toBe('start end')
  })
})

describe('TableBox', () => {
  it('a markdown table sits in its own scroll box', () => {
    const { container } = render(<Markdown text={'| a | b |\n|---|---|\n| 1 | 2 |'} />)
    const box = container.querySelector('.md-table')!
    expect(box.firstElementChild?.tagName).toBe('TABLE')
    expect(box.hasAttribute('data-fade')).toBe(false)
  })
  it('marks the edges with more as the box scrolls', () => {
    const { container } = render(<TableBox><tbody><tr><td>x</td></tr></tbody></TableBox>)
    const box = container.querySelector<HTMLDivElement>('.md-table')!
    Object.defineProperty(box, 'scrollWidth', { value: 500, configurable: true })
    Object.defineProperty(box, 'clientWidth', { value: 300, configurable: true })
    fireEvent.scroll(box)
    expect(box.dataset.fade).toBe('end')
    box.scrollLeft = 100
    fireEvent.scroll(box)
    expect(box.dataset.fade).toBe('start end')
  })
})
