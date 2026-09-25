import { describe, expect, it } from 'vitest'
import { terminalTheme } from './theme'

describe('terminalTheme', () => {
  it('prints ink on the dark sheet', () => {
    const t = terminalTheme(true)
    expect(t.background).toBe('#0f1012')
    expect(t.foreground).toBe('#e4e2dc')
    expect(t.cursor).toBe('#8c98ff')
  })

  it('prints ink on the light sheet', () => {
    const t = terminalTheme(false)
    expect(t.background).toBe('#f3f3f1')
    expect(t.foreground).toBe('#16171a')
    expect(t.cursor).toBe('#2433d6')
    expect(t.cursorAccent).toBe('#f3f3f1')
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
})
