import { useState } from 'react'
import { SIGNS, type DiffLine } from '../../lib/diff'
import ShowAll from '../markdown/ShowAll'
import { useClip } from '../markdown/useClip'
import './InlineDiff.css'

// Past this many lines a diff shows its head until asked for the rest: React
// renders every line as an element.
const LINE_LIMIT = 400

const sign = SIGNS
const spoken: Partial<Record<DiffLine['kind'], string>> = { add: 'added', del: 'removed' }

// InlineDiff draws a diff in the transcript: removed lines on a red wash,
// added ones on pressed paper with a strong hairline, as the Changes panel
// does. It is capped like other output and can be shown whole.
export default function InlineDiff({ lines, label = 'diff' }: { lines: DiffLine[]; label?: string }) {
  const [all, setAll] = useState(false)
  const shown = all ? lines : lines.slice(0, LINE_LIMIT)
  const [box, clip] = useClip<HTMLDivElement>([lines, all])
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
      {lines.length > shown.length ? (
        <button type="button" className="act-link show-all" onClick={() => { setAll(true); clip.setFull(true) }}>
          show all {lines.length} lines
        </button>
      ) : (
        <ShowAll clip={clip} lines={lines.length} />
      )}
    </div>
  )
}
