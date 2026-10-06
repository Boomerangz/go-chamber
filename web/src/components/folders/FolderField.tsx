import { Folder } from 'lucide-react'
import { icon } from '../icon'
import { useLayoutEffect, useRef, useState, type Ref } from 'react'
import FolderPicker from './FolderPicker'
import './FolderField.css'

export interface FolderFieldProps {
  label: string
  placeholder: string
  value: string
  onChange: (path: string) => void
  recent?: string[]
  // invalid marks the field as missing a required folder.
  invalid?: boolean
  inputRef?: Ref<HTMLInputElement>
}

// FolderField is a path input with a Browse button that opens the folder
// picker; the path can still be typed or pasted.
export default function FolderField({ label, placeholder, value, onChange, recent, invalid, inputRef }: FolderFieldProps) {
  const [open, setOpen] = useState(false)
  const browse = useRef<HTMLButtonElement>(null)
  const box = useRef<HTMLDivElement>(null)
  // A long path shows its end, the project name, unless the owner is typing in it.
  const showEnd = (el: HTMLInputElement | null) => {
    if (el && document.activeElement !== el) el.scrollLeft = el.scrollWidth
  }
  useLayoutEffect(() => showEnd(box.current?.querySelector('input') ?? null), [value])
  // Focus goes back where the picker was opened from.
  const close = () => {
    setOpen(false)
    browse.current?.focus()
  }
  return (
    <div ref={box} className="folder-field" data-invalid={invalid || undefined}>
      <Folder {...icon(14)} className="icon folder-icon" />
      <input
        ref={inputRef}
        aria-label={label}
        aria-invalid={invalid || undefined}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => showEnd(e.currentTarget)}
      />
      <button ref={browse} type="button" className="btn btn-ghost btn-xs browse" onClick={() => setOpen(true)}>
        Browse
      </button>
      {open && (
        <FolderPicker
          start={value.trim()}
          recent={recent}
          onPick={(path) => {
            onChange(path)
            close()
          }}
          onClose={close}
        />
      )}
    </div>
  )
}
