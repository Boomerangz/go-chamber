import { beforeEach, describe, expect, it } from 'vitest'
import { ATTENTION_ICON, setAttentionIcon } from './favicon'

beforeEach(() => {
  document.head.innerHTML = '<link rel="icon" type="image/svg+xml" href="/icon.svg" />'
})

const href = () => document.querySelector('link[rel="icon"]')!.getAttribute('href')

describe('setAttentionIcon', () => {
  it('swaps in the icon with the amber mark while requests wait, and back', () => {
    setAttentionIcon(true)
    expect(href()).toBe(ATTENTION_ICON)
    expect(decodeURIComponent(ATTENTION_ICON)).toContain('#e3a33a')
    setAttentionIcon(false)
    expect(href()).toBe('/icon.svg')
  })

  it('does nothing without an icon link', () => {
    document.head.innerHTML = ''
    expect(() => setAttentionIcon(true)).not.toThrow()
  })
})
