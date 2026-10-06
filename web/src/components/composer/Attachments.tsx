import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { icon } from '../icon'
import { imageUrl } from '../../lib/api'
import type { useAttachments } from './useAttachments'
import './Attachments.css'

// Attachments shows the attach button, the images waiting to be sent, the
// ones still uploading and the ones that failed. locked: a running turn only
// takes text, so images wait for the next message.
export default function Attachments({ state, locked = false }: { state: ReturnType<typeof useAttachments>; locked?: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  // A tap on Attach while it is locked says why, next to it.
  const [note, setNote] = useState(false)
  if (note && !locked) setNote(false)
  return (
    <div className="attachments">
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        hidden
        aria-label="attach images"
        onChange={(e) => {
          if (e.target.files) void state.add(e.target.files)
          e.target.value = ''
        }}
      />
      <button
        type="button"
        className="btn btn-ghost attach"
        disabled={!state.sessionId}
        aria-disabled={locked || undefined}
        onClick={() => (locked ? setNote(true) : input.current?.click())}
        title={locked ? 'Images go with the next message' : 'Attach images (or paste / drop them)'}
      >
        Attach
      </button>
      {note && (
        <span className="composer-note attach-note" role="status">
          images go with the next message
        </span>
      )}
      {state.dragging && <span className="attachment-drop">Drop images to attach</span>}
      {state.items.map((a) => (
        <span key={a.id} className="attachment">
          <img src={imageUrl(state.sessionId ?? '', a.id)} alt={a.name} />
          <button type="button" className="attachment-remove" aria-label={`remove ${a.name}`} onClick={() => state.remove(a.id)}>
            <X {...icon(12)} />
          </button>
        </span>
      ))}
      {state.uploads.map((u) => (
        <span key={u.key} className="attachment attachment-pending" title={u.name} role="status" aria-label={`uploading ${u.name}`}>
          {u.file && <Preview file={u.file} />}
          <span className="busy-mark" aria-hidden="true" />
        </span>
      ))}
      {state.errors.map((e) => (
        <span key={e.key} className="attachment-error" role="alert">
          <span>{e.message.includes(e.name) ? e.message : `${e.name}: ${e.message}`}</span>
          {e.file && (
            <button type="button" className="btn btn-xs" aria-label={`retry ${e.name}`} onClick={() => state.retry(e.key)}>
              Retry
            </button>
          )}
          <button type="button" className="btn btn-icon btn-ghost" aria-label={`dismiss ${e.name}`} onClick={() => state.dismiss(e.key)}>
            <X {...icon(12)} />
          </button>
        </span>
      ))}
    </div>
  )
}

// Preview shows a picked image before the server has it, from the local file.
function Preview({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let next: string
    try {
      next = URL.createObjectURL(file)
    } catch {
      // No preview where the file can't be read locally; the mark still shows.
      return
    }
    // The object URL exists only once created here; it is released on cleanup.
    // eslint-disable-next-line react/set-state-in-effect
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [file])
  return url ? <img src={url} alt="" /> : null
}
