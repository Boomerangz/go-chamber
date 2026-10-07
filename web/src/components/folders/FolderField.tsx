import { Folder } from 'lucide-react'
import { icon } from '../icon'
import { useEffect, useLayoutEffect, useRef, useState, type Ref } from 'react'
import FolderPicker from './FolderPicker'
import { fadeOf } from '../../lib/fade'
import './FolderField.css'

export interface FolderFieldProps {
  label: string
  placeholder: string
  value: string
  onChange: (path: string) => void
  recent?: string[]
  // invalid marks the field as missing a required folder.
  invalid?: boolean
  // describedBy names the hint that says what the field needs.
  describedBy?: string
  inputRef?: Ref<HTMLInputElement>
}

// FolderField is a path input with a Browse button that opens the folder
// picker; the path can still be typed or pasted.
export default function FolderField({ label, placeholder, value, onChange, recent, invalid, describedBy, inputRef }: FolderFieldProps) {
  const [open, setOpen] = useState(false)
  const browse = useRef<HTMLButtonElement>(null)
  const box = useRef<HTMLDivElement>(null)
  // Scrolled past its start, the field fades its left edge: the first glyph
  // in view is cut, and a fade says more lies before it. (Not an ellipsis:
  // Chromium draws a scrolled, ellipsized input blank.)
  const [fade, setFade] = useState(false)
  const measure = (el: HTMLInputElement) => setFade(fadeOf(el.scrollLeft, el.scrollWidth, el.clientWidth).includes('start'))
  // A long path shows its end, the project name, unless the owner is typing in it.
  const showEnd = (el: HTMLInputElement | null) => {
    if (el && document.activeElement !== el) el.scrollLeft = el.scrollWidth
    if (el) measure(el)
  }
  useLayoutEffect(() => showEnd(box.current?.querySelector('input') ?? null), [value])
  // A field set while hidden (a phone's folded form) or resized (the phone's
  // larger font) shows the end again once it has its width.
  useEffect(() => {
    const input = box.current?.querySelector('input')
    if (!input || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => showEnd(input))
    observer.observe(input)
    return () => observer.disconnect()
  }, [])
  // Focus goes back where the picker was opened from.
  const close = () => {
    setOpen(false)
    browse.current?.focus()
  }
  return (
    <div ref={box} className="folder-field" data-invalid={invalid || undefined} data-fade={fade ? 'start' : undefined}>
      <Folder {...icon(14)} className="icon folder-icon" />
      <input
        ref={inputRef}
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => showEnd(e.currentTarget)}
        onScroll={(e) => measure(e.currentTarget)}
        onSelect={(e) => measure(e.currentTarget)}
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
