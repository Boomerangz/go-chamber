import type { Clip } from './useClip'
import { lineCount } from '../../lib/format'

// ShowAll is the link under a capped box: "show all N lines" (just "show
// all" for one long wrapped line), then "show less".
export default function ShowAll({ clip, lines }: { clip: Clip; lines: number }) {
  if (!clip.clipped && !clip.full) return null
  return (
    <button type="button" className="act-link show-all" aria-expanded={clip.full} onClick={() => clip.setFull(!clip.full)}>
      {clip.full ? 'show less' : lines > 1 ? `show all ${lineCount(lines)}` : 'show all'}
    </button>
  )
}
