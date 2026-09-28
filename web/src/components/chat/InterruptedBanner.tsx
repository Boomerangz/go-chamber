import type { Session } from '../../lib/api'

const interruptionText: Record<string, string> = {
  crashed: 'the agent process exited unexpectedly',
  idle_timeout: 'the agent was stopped after being idle',
  server_restart: 'go-chamber restarted mid-turn',
  quota: 'the subscription limit was reached',
}

export default function InterruptedBanner({
  session,
  onContinue,
  onAutoContinue,
}: {
  session: Session
  onContinue: () => void
  onAutoContinue: (on: boolean) => void
}) {
  const reason = session.interruption?.reason
  const after = session.interruption?.resumeAfter
  const resets = after && !after.startsWith('0001') ? new Date(after) : undefined
  return (
    <div className="banner banner-warn" role="status">
      <strong>Turn interrupted</strong>
      <span>
        {reason ? interruptionText[reason] ?? reason : 'the turn ended abnormally'}.
        {resets && ` The limit resets at ${resets.toLocaleTimeString()}.`}
      </span>
      {session.nativeId && (
        <span className="banner-actions">
          {resets && (
            <label className="banner-toggle">
              <input
                type="checkbox"
                aria-label="Continue after reset"
                checked={!!session.autoContinue}
                onChange={(e) => onAutoContinue(e.target.checked)}
              />
              continue after reset
            </label>
          )}
          <button type="button" className="btn" onClick={onContinue}>
            Continue
          </button>
        </span>
      )}
    </div>
  )
}
