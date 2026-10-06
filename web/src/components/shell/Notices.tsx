import { X } from 'lucide-react'
import { useEffect } from 'react'
import { icon } from '../icon'
import { isTypingTarget } from '../../lib/hotkeys'
import { useNotices } from '../../stores/notices'
import { useNoticePlace } from './noticePlace'

// Notices stacks what failed (or a quiet confirmation) where it covers no
// control: at the top of the transcript or the empty workspace, else clear
// of the dock rail (desktop) or above the pane bar (phone). Escape dismisses
// the newest one when nothing else wants the key.
export default function Notices() {
  const notices = useNotices((s) => s.notices)
  const dismiss = useNotices((s) => s.dismiss)
  const newest = notices[notices.length - 1]?.id
  const place = useNoticePlace(notices.length > 0)
  useEffect(() => {
    if (newest === undefined) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || isTypingTarget(e.target)) return
      if (document.querySelector('dialog[open], [aria-modal="true"]')) return
      dismiss(newest)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newest, dismiss])
  if (notices.length === 0) return null
  return (
    <div className="notices" aria-live="polite" style={place ?? undefined}>
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
