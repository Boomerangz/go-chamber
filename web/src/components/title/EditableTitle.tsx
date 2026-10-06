import { useState } from 'react'

interface Props {
  value: string
  // label names the thing being renamed: "session", "terminal".
  label: string
  onRename: (title: string) => Promise<unknown> | void
  className?: string
  // heading renders the name as an h2, keeping the button out of its name.
  heading?: boolean
}

// EditableTitle shows a name that turns into a text field on double click or
// the pencil button. Enter or leaving the field saves, Escape cancels; an
// empty name lets the server fall back to its default.
export default function EditableTitle({ value, label, onRename, className, heading }: Props) {
  const [draft, setDraft] = useState<string | null>(null)

  const save = () => {
    if (draft === null) return
    const next = draft.trim()
    setDraft(null)
    if (next !== value) void onRename(next)
  }

  if (draft !== null) {
    return (
      <input
        className={`title-input ${className ?? ''}`}
        aria-label={`${label} name`}
        value={draft}
        maxLength={200}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            save()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setDraft(null)
          }
        }}
      />
    )
  }
  return (
    <span className={`editable-title ${className ?? ''}`}>
      {heading ? (
        <h2 onDoubleClick={() => setDraft(value)}>{value}</h2>
      ) : (
        <span onDoubleClick={() => setDraft(value)}>{value}</span>
      )}
      <button type="button" className="rename-btn" aria-label={`Rename ${label}`} title={`Rename ${label}`} onClick={() => setDraft(value)}>
        ✎
      </button>
    </span>
  )
}
