import { useState } from 'react'
import FolderPicker from './FolderPicker'

export interface FolderFieldProps {
  label: string
  placeholder: string
  value: string
  onChange: (path: string) => void
  recent?: string[]
}

// FolderField is a path input with a Browse button that opens the folder
// picker; the path can still be typed or pasted.
export default function FolderField({ label, placeholder, value, onChange, recent }: FolderFieldProps) {
  const [open, setOpen] = useState(false)
  return (
    <div className="folder-field">
      <span className="folder-icon" aria-hidden="true" />
      <input
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button type="button" className="btn btn-ghost btn-xs browse" onClick={() => setOpen(true)}>
        Browse
      </button>
      {open && (
        <FolderPicker
          start={value.trim()}
          recent={recent}
          onPick={(path) => {
            onChange(path)
            setOpen(false)
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}
