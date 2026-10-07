import { useId } from 'react'
import { Activity } from 'lucide-react'
import { icon } from '../icon'
import { fleet, fleetText } from '../../lib/fleet'
import { useWaitingCount } from '../../lib/waiting'
import { useSessionStore } from '../../stores/session'

// OverviewToggle opens every session at a glance, and says the glance on
// itself: "2 running · 1 waiting" after its word, so the bar tells the owner
// how the fleet stands without opening anything. The line is the button's
// description; its name stays "Overview".
export default function OverviewToggle(props: { pressed: boolean; onClick: () => void }) {
  const waiting = useWaitingCount()
  const text = useSessionStore((s) => fleetText(fleet(s.sessions, s.pendingRequests, waiting)))
  const id = useId()
  return (
    <button
      type="button"
      className="btn btn-ghost overview-toggle"
      aria-pressed={props.pressed}
      aria-describedby={text ? id : undefined}
      title={props.pressed ? 'Back to the workspace' : 'Every session at a glance'}
      onClick={props.onClick}
    >
      <Activity {...icon(16)} className="icon bar-icon" />
      <span className="bar-label">Overview</span>
      {text && (
        <span className="fleet" id={id} aria-hidden="true">
          {text}
        </span>
      )}
    </button>
  )
}
