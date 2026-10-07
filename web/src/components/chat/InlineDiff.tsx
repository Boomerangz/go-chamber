import { useState } from 'react'
import { SIGNS, type DiffLine } from '../../lib/diff'
import ShowAll from '../markdown/ShowAll'
import { count, lineCount } from '../../lib/format'
import { useClip } from '../markdown/useClip'
import './InlineDiff.css'

// Past this many lines a diff shows its head until asked for more: React
// renders every line as an element. More comes a chunk at a time, so a
// 10,000-line diff never puts 10,000 rows in the page at once.
const LINE_LIMIT = 400
const CHUNK = 500

const sign = SIGNS
const spoken: Partial<Record<DiffLine['kind'], string>> = { add: 'added', del: 'removed' }

// InlineDiff draws a diff in the transcript: removed lines on a red wash,
// added ones on pressed paper with a strong hairline, as the Changes panel
// does. It is capped like other output and can be shown whole.
export default function InlineDiff({ lines, label = 'diff' }: { lines: DiffLine[]; label?: string }) {
  const [limit, setLimit] = useState(LINE_LIMIT)
  const shown = lines.length > limit ? lines.slice(0, limit) : lines
  const left = lines.length - shown.length
  const [box, clip] = useClip<HTMLDivElement>([lines, limit])
  return (
    <div className="inline-diff-wrap">
      <div ref={box} className={clip.full ? 'inline-diff full' : 'inline-diff'} role="group" aria-label={label}>
        {shown.map((line, i) => (
          <div key={i} className={`idiff idiff-${line.kind}`}>
            {spoken[line.kind] && <span className="sr-only">{spoken[line.kind]}: </span>}
            <span className="idiff-sign" aria-hidden="true">
              {sign[line.kind]}
            </span>
            {line.text}
          </div>
        ))}
      </div>
      {left > 0 ? (
        <button type="button" className="act-link show-all" onClick={() => { setLimit(limit + CHUNK); clip.setFull(true) }}>
          {left > CHUNK ? `show ${count(CHUNK)} more of ${lineCount(lines.length)}` : `show all ${lineCount(lines.length)}`}
        </button>
      ) : (
        <ShowAll clip={clip} lines={lines.length} />
      )}
    </div>
  )
}
