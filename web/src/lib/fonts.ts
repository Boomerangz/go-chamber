// Measure is the width of text set in a CSS font-family list.
export type Measure = (font: string, text: string) => number

// The fixed-width fonts a client may well have; the browser's own list
// (queryLocalFonts) is Chromium-only and asks permission.
const KNOWN = [
  'Andale Mono', 'Cascadia Code', 'Cascadia Mono', 'Consolas', 'Courier New', 'DejaVu Sans Mono', 'Fira Code',
  'Fira Mono', 'Hack', 'IBM Plex Mono', 'Inconsolata', 'Iosevka', 'JetBrains Mono', 'Liberation Mono', 'Lucida Console',
  'Menlo', 'Monaco', 'Noto Sans Mono', 'PT Mono', 'Roboto Mono', 'SF Mono', 'Source Code Pro', 'Ubuntu Mono', 'Victor Mono',
]

const quote = (family: string) => JSON.stringify(family)

function canvasMeasure(): Measure | null {
  let ctx: CanvasRenderingContext2D | null = null
  try {
    ctx = document.createElement('canvas').getContext('2d')
  } catch {
    // no canvas: nothing can be measured
  }
  if (!ctx) return null
  return (font, text) => {
    ctx.font = `72px ${font}`
    return ctx.measureText(text).width
  }
}

// installed: text in the family measures unlike text in a fallback alone.
const installed = (family: string, measure: Measure) =>
  ['monospace', 'serif'].some((base) => measure(`${quote(family)}, ${base}`, 'mmmmiiii') !== measure(base, 'mmmmiiii'))

// fixed: narrow and wide letters take the same room. A family lacking
// them falls back to serif, where they don't.
const fixed = (family: string, measure: Measure) =>
  measure(`${quote(family)}, serif`, 'iiii') === measure(`${quote(family)}, serif`, 'MMMM')

// knownFonts lists the well-known fixed-width fonts this client has.
export function knownFonts(measure: Measure | null = canvasMeasure()): string[] {
  if (!measure) return []
  return KNOWN.filter((family) => installed(family, measure))
}

// allFonts asks the browser for every installed fixed-width font; null
// where it cannot say or the owner refused. It needs a click to ask.
export async function allFonts(measure: Measure | null = canvasMeasure()): Promise<string[] | null> {
  const query = (window as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts
  if (!query || !measure) return null
  try {
    const families = new Set((await query.call(window)).map((f) => f.family))
    return [...families].filter((family) => fixed(family, measure)).sort((a, b) => a.localeCompare(b))
  } catch {
    return null
  }
}

// fontStack puts the chosen family ahead of the default ones.
export const fontStack = (family: string | null, fallback: string) => (family ? `${quote(family)}, ${fallback}` : fallback)
