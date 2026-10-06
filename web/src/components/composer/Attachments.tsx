import { useRef } from 'react'
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
        disabled={!state.sessionId || locked}
        onClick={() => input.current?.click()}
        title={locked ? 'Images go with the next message' : 'Attach images (or paste / drop them)'}
      >
        Attach
      </button>
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
          <span className="busy-mark" aria-hidden="true" />
        </span>
      ))}
      {state.errors.map((e) => (
        <span key={e.key} className="attachment-error" role="alert">
          <span>{e.message.includes(e.name) ? e.message : `${e.name}: ${e.message}`}</span>
          <button type="button" className="btn btn-icon btn-ghost" aria-label={`dismiss ${e.name}`} onClick={() => state.dismiss(e.key)}>
            <X {...icon(12)} />
          </button>
        </span>
      ))}
    </div>
  )
}
