import type { Clip } from './useClip'

// ShowAll is the link under a capped box: "show all N lines", then "show less".
export default function ShowAll({ clip, lines }: { clip: Clip; lines: number }) {
  if (!clip.clipped && !clip.full) return null
  return (
    <button type="button" className="act-link show-all" aria-expanded={clip.full} onClick={() => clip.setFull(!clip.full)}>
      {clip.full ? 'show less' : `show all ${lines} lines`}
    </button>
  )
}
