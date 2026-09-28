import { useEffect, useState } from 'react'
import { disablePush, enablePush, pushEnabled, pushSupported } from '../../lib/push'

// NotifyToggle subscribes this browser to push notifications: the agent asks
// for a decision or a turn ends while the tab is in the background.
export default function NotifyToggle() {
  const [supported] = useState(pushSupported)
  const [on, setOn] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (supported) void pushEnabled().then(setOn, () => setOn(false))
  }, [supported])

  if (!supported) return null
  const toggle = async () => {
    setBusy(true)
    setError(null)
    try {
      await (on ? disablePush() : enablePush())
      setOn(!on)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      type="button"
      className="btn btn-ghost notify-toggle"
      aria-label="Notifications"
      aria-pressed={on}
      title={error ?? (on ? 'Notifications are on' : 'Notify me when an agent needs me')}
      disabled={busy}
      onClick={() => void toggle()}
    >
      {on ? '🔔' : '🔕'}
    </button>
  )
}
