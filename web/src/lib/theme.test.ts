import { describe, expect, it } from 'vitest'
import { searchDecorations, terminalTheme } from './theme'

describe('terminalTheme', () => {
  it('prints ink on the dark sheet', () => {
    const t = terminalTheme(true)
    expect(t.background).toBe('#151412')
    expect(t.foreground).toBe('#d4cfc4')
    expect(t.cursor).toBe('#9aa8e6')
  })

  it('prints ink on the light sheet', () => {
    const t = terminalTheme(false)
    expect(t.background).toBe('#faf9f6')
    expect(t.foreground).toBe('#2c2b27')
    expect(t.cursor).toBe('#3550b8')
    expect(t.cursorAccent).toBe('#faf9f6')
  })

  it('selects with a translucent accent in both schemes', () => {
    expect(terminalTheme(true).selectionBackground).toMatch(/^rgba\(/)
    expect(terminalTheme(false).selectionBackground).toMatch(/^rgba\(/)
    expect(terminalTheme(true).selectionBackground).not.toBe(terminalTheme(false).selectionBackground)
  })

  it('keeps ANSI colours readable on each sheet', () => {
    expect(terminalTheme(true).black).not.toBe(terminalTheme(true).background)
    expect(terminalTheme(false).white).not.toBe(terminalTheme(false).background)
  })

  it('keeps shell yellow apart from the "needs you" amber', () => {
    for (const dark of [true, false]) {
      const t = terminalTheme(dark)
      expect([t.yellow, t.brightYellow]).not.toContain('#e3a33a')
      expect([t.yellow, t.brightYellow]).not.toContain('#b86a00')
      expect([t.yellow, t.brightYellow]).not.toContain('#8f5200')
    }
  })

  it('takes the sheet, ink and accent from the page tokens', () => {
    const tokens: Record<string, string> = { '--paper': '#101010', '--ink': '#fafafa', '--act': '#123456', '--bad': '#ff0000' }
    const t = terminalTheme(true, (name) => tokens[name] ?? '')
    expect(t).toMatchObject({ background: '#101010', foreground: '#fafafa', cursor: '#123456', cursorAccent: '#101010', red: '#ff0000' })
  })
})

describe('searchDecorations', () => {
  const tokens: Record<string, string> = { '--paper-3': '#ddd', '--rule': '#ccc', '--rule-strong': '#888', '--act': '#23d' }
  const read = (name: string) => tokens[name] ?? ''

  it('marks matches in the sheet’s tokens, the current one in the focus colour', () => {
    expect(searchDecorations(false, read)).toEqual({
      matchBackground: '#ddd',
      matchOverviewRuler: '#888',
      activeMatchBackground: '#ccc',
      activeMatchBorder: '#23d',
      activeMatchColorOverviewRuler: '#23d',
    })
  })

  it('takes one tone stronger on the dark sheet, so a match still shows', () => {
    expect(searchDecorations(true, read)).toMatchObject({ matchBackground: '#ccc', activeMatchBackground: '#888' })
  })

  it('falls back to the design values without a stylesheet', () => {
    expect(searchDecorations(false, () => '')).toMatchObject({ matchBackground: '#e7e4dd', activeMatchBorder: '#3550b8' })
    expect(searchDecorations(true, () => '')).toMatchObject({ matchBackground: '#2a2825', activeMatchBorder: '#9aa8e6' })
  })
})
