import { Fragment, type ReactNode } from 'react'
import { keyGroups } from '../../lib/keys'

// Keys draws a shortcut the one way DESIGN asks for: one key per kbd box,
// alternatives set apart by "·", and the word it does after the same gap
// wherever a hint is shown (help, composer, switcher, empty states).
export default function Keys({ keys, label }: { keys: string; label?: ReactNode }) {
  return (
    <span className="keys">
      {keyGroups(keys).map((group, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="keys-or"> · </span>}
          {group.map((key, j) => (
            <kbd key={j}>{key}</kbd>
          ))}
        </Fragment>
      ))}
      {label !== undefined && (
        <>
          {' '}
          <span className="keys-label">{label}</span>
        </>
      )}
    </span>
  )
}
