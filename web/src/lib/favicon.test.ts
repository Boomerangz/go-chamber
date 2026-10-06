import { beforeEach, describe, expect, it } from 'vitest'
import baseSvg from '../../public/icon.svg?raw'
import { ATTENTION_ICON, setAttentionIcon } from './favicon'

beforeEach(() => {
  document.head.innerHTML = '<link rel="icon" type="image/svg+xml" href="/icon.svg" />'
})

const href = () => document.querySelector('link[rel="icon"]')!.getAttribute('href')

describe('setAttentionIcon', () => {
  it('is the app icon with an amber square mark drawn last', () => {
    expect(ATTENTION_ICON.startsWith('data:image/svg+xml,')).toBe(true)
    const svg = decodeURIComponent(ATTENTION_ICON.slice('data:image/svg+xml,'.length))
    const base = baseSvg.trim()
    expect(svg.startsWith(base.slice(0, -'</svg>'.length))).toBe(true)
    expect(svg).toMatch(/<rect x="300" y="12" width="200" height="200" rx="16" fill="#e3a33a" stroke="#0f1012" stroke-width="24"\/><\/svg>$/)
  })

  it('swaps in the marked icon while requests wait, and back', () => {
    setAttentionIcon(true)
    expect(href()).toBe(ATTENTION_ICON)
    setAttentionIcon(true)
    expect(href()).toBe(ATTENTION_ICON)
    setAttentionIcon(false)
    expect(href()).toBe('/icon.svg')
  })

  it('does nothing without an icon link', () => {
    document.head.innerHTML = ''
    expect(() => setAttentionIcon(true)).not.toThrow()
  })
})
