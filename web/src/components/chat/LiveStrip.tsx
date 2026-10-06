import { useNow } from '../../lib/now'
import { useSessionStore } from '../../stores/session'
import { useLiveDropped } from './useLiveDropped'

// LiveStrip sits above the composer while the live socket is down: what the
// transcript shows may be stale, when the next attempt is, and a way to try
// now. The first connection of a page load is not a drop and stays quiet.
// A note (a stop sent that the agent hasn't answered yet) rides the same
// line, so the composer keeps its one row.
export default function LiveStrip({ note }: { note?: string }) {
  const connection = useSessionStore((s) => s.connection)
  const nextRetryAt = useSessionStore((s) => s.nextRetryAt)
  const dropped = useLiveDropped()
  if (dropped) return <Dropped retryAt={connection === 'offline' ? nextRetryAt : null} note={note} />
  if (!note) return null
  return (
    <div className="live-strip" role="status">
      <span className="live-note">{note}</span>
    </div>
  )
}

function Dropped({ retryAt, note }: { retryAt: number | null; note?: string }) {
  const retryNow = useSessionStore((s) => s.retryNow)
  const now = useNow(retryAt ? 1000 : null)
  const wait = retryAt ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : 0
  return (
    <div className="live-strip" role="status" aria-label="Live updates">
      <span className="busy-mark" aria-hidden="true" />
      <span>live updates paused · {wait > 0 ? `reconnecting in ${wait}s` : 'reconnecting…'}</span>
      {note && <span className="live-note">· {note}</span>}
      <button type="button" className="btn btn-xs" onClick={retryNow}>
        Reconnect now
      </button>
    </div>
  )
}
