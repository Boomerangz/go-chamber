// keyGroups takes a shortcut as the help writes it ("a · s · d", "⇧↵",
// "Ctrl+Shift+F", "↑ ↓") apart into what is drawn: alternatives (split on
// "·"), each a run of keys, one key per box. A Mac chord is a run of
// modifier glyphs and its key; a written-out one is joined with "+".
const MODIFIER_GLYPHS = new Set(['⌘', '⌥', '⇧', '⌃'])

export function keyGroups(keys: string): string[][] {
  return keys
    .split(/\s+·\s+/)
    .map((alt) => alt.trim().split(/\s+/).filter(Boolean).flatMap(chordKeys))
    .filter((group) => group.length > 0)
}

function chordKeys(chord: string): string[] {
  if (chord.length > 1 && chord.includes('+')) return chord.split('+').filter(Boolean)
  const out: string[] = []
  let rest = chord
  while (rest.length > 1 && MODIFIER_GLYPHS.has(rest[0]!)) {
    out.push(rest[0]!)
    rest = rest.slice(1)
  }
  out.push(rest)
  return out
}
