const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

// Match one complete emoji, including flags, keycaps, modifiers and ZWJ
// sequences. Plain digits and text symbols such as © are not markers.
export function titleEmoji(title: string): string {
  const first = graphemes.segment(title.trimStart())[Symbol.iterator]().next().value?.segment ?? ''
  return /\p{Emoji_Presentation}|\uFE0F|\u20E3/u.test(first) ? first : ''
}

export function withTitleEmoji(title: string, emoji: string): string {
  const trimmed = title.trim()
  const text = trimmed.slice(titleEmoji(trimmed).length).trimStart()
  return [emoji, text].filter(Boolean).join(' ')
}
