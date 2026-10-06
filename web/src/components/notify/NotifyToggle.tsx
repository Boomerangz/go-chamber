import { Bell, BellOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { disablePush, enablePush, pushEnabled, pushSupported, WorkerUnavailable } from '../../lib/push'
import { fail } from '../../stores/notices'
import { icon } from '../icon'
import './toggles.css'

// NotifyToggle subscribes this browser to push notifications: the agent asks
// for a decision or a turn ends while the tab is in the background.
export default function NotifyToggle() {
  const [supported] = useState(pushSupported)
  // on is null until the browser says whether this device is subscribed:
  // showing "off" first and flipping to "on" reads as a glitch.
  const [on, setOn] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  // unavailable is set when the service worker never started.
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    if (!supported) return
    void pushEnabled().then(setOn, (err: unknown) => {
      setOn(false)
      if (err instanceof WorkerUnavailable) setUnavailable(true)
    })
  }, [supported])

  if (!supported) return null
  const toggle = async () => {
    setBusy(true)
    try {
      await (on ? disablePush() : enablePush())
      setOn(!on)
    } catch (err) {
      if (err instanceof WorkerUnavailable) setUnavailable(true)
      fail(on ? "Couldn't turn notifications off" : "Couldn't turn notifications on", err, 'notify-toggle')
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      type="button"
      className="btn btn-ghost btn-icon notify-toggle"
      aria-label="Notifications"
      aria-pressed={on === true}
      aria-busy={busy || undefined}
      title={unavailable ? 'Notifications unavailable' : on ? 'Notifications are on' : 'Notify me when an agent needs me'}
      disabled={busy || on === null || unavailable}
      onClick={() => void toggle()}
    >
      {on ? <Bell {...icon(16)} /> : <BellOff {...icon(16)} />}
    </button>
  )
}
