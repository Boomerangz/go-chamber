import { Pencil } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { icon } from '../icon'

interface Props {
  value: string
  // label names the thing being renamed: "session", "terminal".
  label: string
  // onRename resolves false when the rename did not go through.
  onRename: (title: string) => Promise<unknown> | void
  className?: string
  // heading renders the name as an h2, keeping the button out of its name.
  heading?: boolean
}

// EditableTitle shows a name that turns into a text field on double click or
// the pencil button. Enter or leaving the field saves, Escape cancels; an
// empty name lets the server fall back to its default. The new name shows
// at once and goes back if the rename fails.
export default function EditableTitle({ value, label, onRename, className, heading }: Props) {
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  // refocus is set when the field closes from the keyboard, so focus lands
  // back on the button instead of falling to the page.
  const refocus = useRef(false)

  useEffect(() => {
    if (draft === null && refocus.current) {
      refocus.current = false
      button.current?.focus()
    }
  }, [draft])

  const save = () => {
    if (draft === null) return
    const next = draft.trim()
    setDraft(null)
    if (next === value) return
    const result = onRename(next)
    if (!result) return
    // An empty name falls back to a server default we can't predict.
    if (next) setSaving(next)
    void Promise.resolve(result).then(
      () => setSaving(null),
      () => setSaving(null),
    )
  }

  if (draft !== null) {
    return (
      <input
        className={`title-input ${className ?? ''}`}
        aria-label={`${label[0]!.toUpperCase()}${label.slice(1)} name`}
        value={draft}
        maxLength={200}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            refocus.current = true
            save()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            refocus.current = true
            setDraft(null)
          }
        }}
      />
    )
  }
  const shown = saving ?? value
  return (
    <span className={`editable-title ${className ?? ''}`} aria-busy={saving !== null || undefined}>
      {heading ? (
        <h2 onDoubleClick={() => setDraft(shown)}>{shown}</h2>
      ) : (
        <span onDoubleClick={() => setDraft(shown)}>{shown}</span>
      )}
      <button
        ref={button}
        type="button"
        className="rename-btn"
        aria-label={`Rename ${label}`}
        title={`Rename ${label}`}
        onClick={() => setDraft(shown)}
      >
        <Pencil {...icon(13)} />
      </button>
    </span>
  )
}
