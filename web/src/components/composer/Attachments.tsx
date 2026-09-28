import { useRef } from 'react'
import { imageUrl } from '../../lib/api'
import type { useAttachments } from './useAttachments'
import './Attachments.css'

// Attachments shows the attach button and the images waiting to be sent.
export default function Attachments({ state }: { state: ReturnType<typeof useAttachments> }) {
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
        disabled={!state.sessionId}
        onClick={() => input.current?.click()}
        title="Attach images (or paste / drop them)"
      >
        Attach
      </button>
      {state.items.map((a) => (
        <span key={a.id} className="attachment">
          <img src={imageUrl(state.sessionId ?? '', a.id)} alt={a.name} />
          <button type="button" className="attachment-remove" aria-label={`remove ${a.name}`} onClick={() => state.remove(a.id)}>
            ×
          </button>
        </span>
      ))}
      {state.uploading && <span className="attachment-busy">uploading…</span>}
      {state.error && (
        <span className="attachment-error" role="alert">
          {state.error}
        </span>
      )}
    </div>
  )
}
