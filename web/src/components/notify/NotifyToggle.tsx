import { Bell, BellOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { disablePush, enablePush, pushBlocked, pushEnabled, pushFailure, pushNeedsHttps, pushSupported, WorkerUnavailable } from '../../lib/push'
import { fail, notify } from '../../stores/notices'
import { icon } from '../icon'
import './toggles.css'

const HTTPS_TITLE = 'Notifications need HTTPS (or localhost)'

// NotifyToggle subscribes this browser to push notifications: the agent asks
// for a decision or a turn ends while the tab is in the background.
export default function NotifyToggle() {
  const [supported] = useState(pushSupported)
  const [needsHttps] = useState(pushNeedsHttps)
  // on is null until the browser says whether this device is subscribed:
  // showing "off" first and flipping to "on" reads as a glitch.
  const [on, setOn] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  // unavailable is set when the service worker never started.
  const [unavailable, setUnavailable] = useState(false)
  // blocked: the browser's site settings deny notifications; asking again
  // can't change that, so the bell says where to look instead.
  const [blocked, setBlocked] = useState(pushBlocked)

  useEffect(() => {
    if (!supported) return
    void pushEnabled().then(setOn, (err: unknown) => {
      setOn(false)
      if (err instanceof WorkerUnavailable) setUnavailable(true)
    })
  }, [supported])

  if (!supported) {
    // Over plain HTTP (a LAN address) the browser offers no push at all:
    // say so rather than leave the owner looking for the bell.
    if (!needsHttps) return null
    return (
      <button
        type="button"
        className="btn btn-ghost btn-icon notify-toggle"
        aria-label="Notifications"
        aria-pressed={false}
        aria-disabled="true"
        title={HTTPS_TITLE}
        onClick={() =>
          notify({
            kind: 'info',
            title: 'Notifications need HTTPS',
            text: 'Browsers only send notifications to pages opened over HTTPS or on localhost. Open go-chamber that way to turn them on.',
            key: 'notify-toggle',
          })
        }
      >
        <BellOff {...icon(16)} />
      </button>
    )
  }
  const toggle = async () => {
    // The owner may have unblocked it since: look again before saying so.
    if (!on && pushBlocked()) {
      setBlocked(true)
      notify({
        kind: 'error',
        title: 'Notifications are blocked',
        text: "Allow notifications for this site in the browser's site settings, then click the bell again.",
        key: 'notify-toggle',
      })
      return
    }
    setBlocked(false)
    setBusy(true)
    try {
      await (on ? disablePush() : enablePush())
      setOn(!on)
    } catch (err) {
      if (err instanceof WorkerUnavailable) setUnavailable(true)
      setBlocked(pushBlocked())
      fail(on ? "Couldn't turn notifications off" : "Couldn't turn notifications on", pushFailure(err), 'notify-toggle')
    } finally {
      setBusy(false)
    }
  }
  const title = unavailable
    ? 'Notifications unavailable'
    : on
      ? 'Notifications are on'
      : blocked
        ? 'Blocked in browser site settings'
        : 'Notify me when an agent needs me'
  return (
    <button
      type="button"
      className="btn btn-ghost btn-icon notify-toggle"
      aria-label="Notifications"
      aria-pressed={on === true}
      aria-busy={busy || undefined}
      title={title}
      disabled={busy || on === null || unavailable}
      onClick={() => void toggle()}
    >
      {on ? <Bell {...icon(16)} /> : <BellOff {...icon(16)} />}
    </button>
  )
}
