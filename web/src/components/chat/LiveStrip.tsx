import { useNow } from '../../lib/now'
import { useSessionStore } from '../../stores/session'

// LiveStrip sits above the composer while the live socket is down: what the
// transcript shows may be stale, when the next attempt is, and a way to try
// now. The first connection of a page load is not a drop and stays quiet.
export default function LiveStrip() {
  const connection = useSessionStore((s) => s.connection)
  const nextRetryAt = useSessionStore((s) => s.nextRetryAt)
  const dropped = connection === 'offline' || (connection === 'connecting' && nextRetryAt !== null)
  if (!dropped) return null
  return <Dropped retryAt={connection === 'offline' ? nextRetryAt : null} />
}

function Dropped({ retryAt }: { retryAt: number | null }) {
  const retryNow = useSessionStore((s) => s.retryNow)
  const now = useNow(retryAt ? 1000 : null)
  const wait = retryAt ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : 0
  return (
    <div className="live-strip" role="status" aria-label="live updates">
      <span className="busy-mark" aria-hidden="true" />
      <span>live updates paused · {wait > 0 ? `reconnecting in ${wait}s` : 'reconnecting…'}</span>
      <button type="button" className="btn btn-xs" onClick={retryNow}>
        Reconnect now
      </button>
    </div>
  )
}
