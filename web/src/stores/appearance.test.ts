import { beforeEach, describe, expect, it } from 'vitest'
import { isDark, loadAppearance, resetAppearance, useAppearanceStore } from './appearance'

const store = () => useAppearanceStore.getState()
const root = () => document.documentElement.dataset

beforeEach(() => {
  localStorage.clear()
  resetAppearance()
})

describe('appearance store', () => {
  it('follows the system, at the default size and measure', () => {
    expect(loadAppearance()).toEqual({ theme: 'system', scheme: 'chamber', text: 'default', wide: false, agentIcons: 'mono', termSmoothing: true })
    expect(root().theme).toBeUndefined()
    expect(root().text).toBeUndefined()
    expect(root().wide).toBeUndefined()
  })

  it('sets each choice on the page and remembers it', () => {
    store().setTheme('dark')
    store().setText('large')
    store().setWide(true)
    expect(root()).toMatchObject({ theme: 'dark', text: 'large', wide: '' })
    expect(loadAppearance()).toEqual({ theme: 'dark', scheme: 'chamber', text: 'large', wide: true, agentIcons: 'mono', termSmoothing: true })
    store().setTheme('system')
    store().setText('default')
    store().setWide(false)
    expect(root().theme).toBeUndefined()
    expect(root().text).toBeUndefined()
    expect(root().wide).toBeUndefined()
  })

  it('ignores a stored value it does not know', () => {
    localStorage.setItem('gc.appearance', JSON.stringify({ theme: 'sepia', text: 'huge', wide: 'yes' }))
    expect(loadAppearance()).toEqual({ theme: 'system', scheme: 'chamber', text: 'default', wide: false, agentIcons: 'mono', termSmoothing: true })
    localStorage.setItem('gc.appearance', '{')
    expect(loadAppearance()).toEqual({ theme: 'system', scheme: 'chamber', text: 'default', wide: false, agentIcons: 'mono', termSmoothing: true })
  })

  it('reads a chosen theme over the system one', () => {
    store().setTheme('dark')
    expect(isDark()).toBe(true)
    store().setTheme('light')
    expect(isDark()).toBe(false)
  })
})

describe('colour scheme', () => {
  it('writes the scheme\'s tokens for the sheet in use and clears them for Chamber', () => {
    store().setTheme('dark')
    store().setScheme('nord')
    expect(root().scheme).toBe('nord')
    expect(document.documentElement.style.getPropertyValue('--paper')).toBe('#2e3440')
    store().setTheme('light')
    expect(document.documentElement.style.getPropertyValue('--paper')).toBe('#eceff4')
    expect(loadAppearance().scheme).toBe('nord')
    store().setScheme('chamber')
    expect(root().scheme).toBeUndefined()
    expect(document.documentElement.style.getPropertyValue('--paper')).toBe('')
  })

  it('ignores a stored scheme it does not know', () => {
    localStorage.setItem('gc.appearance', JSON.stringify({ scheme: 'neon' }))
    expect(loadAppearance().scheme).toBe('chamber')
  })
})
