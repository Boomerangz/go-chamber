import { statusWord, type ShownStatus } from '../../lib/status'

// StatusMark is a session row's state: the square mark, and a word unless
// the session rests (idle, detached), where the mark alone says it. On a
// narrow row "waiting for you" keeps only "waiting" (see index.css).
export default function StatusMark({ shown }: { shown: ShownStatus }) {
  if (shown === 'detached') {
    // Most sessions rest detached; the dashed mark alone says so.
    return <span className="session-status session-status-detached" role="img" aria-label="detached" title="detached · resumes when you write" />
  }
  if (shown === 'idle') {
    // Idle is a resting state too: the hollow mark alone.
    return <span className="session-status session-status-idle" role="img" aria-label="idle" title="idle · waiting for your next message" />
  }
  if (shown === 'waiting') {
    return (
      <span className="session-status session-status-waiting" title={statusWord(shown)}>
        <span className="status-word">
          waiting<span className="status-more"> for you</span>
        </span>
      </span>
    )
  }
  return <span className={`session-status session-status-${shown}`}>{statusWord(shown)}</span>
}
