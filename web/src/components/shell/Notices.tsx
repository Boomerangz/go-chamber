import { X } from 'lucide-react'
import { icon } from '../icon'
import { useNotices } from '../../stores/notices'

// Notices stacks what failed (or a quiet confirmation) where it doesn't cover
// the composer: under the top bar on desktop, above the pane bar on phones.
export default function Notices() {
  const notices = useNotices((s) => s.notices)
  const dismiss = useNotices((s) => s.dismiss)
  if (notices.length === 0) return null
  return (
    <div className="notices" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className={`toast toast-${n.kind}`} role={n.kind === 'error' ? 'alert' : 'status'}>
          <div className="toast-body">
            {n.title && <span className="toast-title">{n.title}</span>}
            <span className="toast-text">{n.text}</span>
          </div>
          <button type="button" className="btn btn-ghost btn-icon toast-close" aria-label="Dismiss" title="Dismiss" onClick={() => dismiss(n.id)}>
            <X {...icon(14)} />
          </button>
        </div>
      ))}
    </div>
  )
}
