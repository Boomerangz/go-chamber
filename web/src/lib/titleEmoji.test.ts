import { describe, expect, it } from 'vitest'
import { titleEmoji, withTitleEmoji } from './titleEmoji'

describe('title emoji', () => {
  it('adds a marker at the start and replaces it without stacking', () => {
    expect(withTitleEmoji('Release notes', '🚀')).toBe('🚀 Release notes')
    expect(withTitleEmoji('🐛 Release notes', '🚀')).toBe('🚀 Release notes')
    expect(withTitleEmoji('  Release notes  ', '🚀')).toBe('🚀 Release notes')
    expect(withTitleEmoji('', '🚀')).toBe('🚀')
  })

  it.each(['👩🏽‍💻', '🇷🇺', '1️⃣', '❤️', '☀️', '🏳️‍🌈'])('recognizes the whole %s grapheme', (emoji) => {
    expect(titleEmoji(`${emoji} Notes`)).toBe(emoji)
    expect(withTitleEmoji(`${emoji} Notes`, '🐛')).toBe('🐛 Notes')
    expect(withTitleEmoji(`${emoji} Notes`, '')).toBe('Notes')
  })

  it('keeps ordinary prefixes, internal emoji and subsequent emoji intact', () => {
    for (const name of ['123 notes', '# notes', '* notes', 'Notes 🚀', '© copyright']) {
      expect(titleEmoji(name)).toBe('')
      expect(withTitleEmoji(name, '')).toBe(name)
    }
    expect(withTitleEmoji('🚀 🐛 Notes', '📚')).toBe('📚 🐛 Notes')
    expect(withTitleEmoji('🚀', '')).toBe('')
  })
})
