import { useState } from 'react'
import type { Session } from '../../lib/api'
import { usePending } from '../../lib/pending'

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
  // Both resolve true once the server took the change.
  onContinue: () => Promise<boolean>
  onAutoContinue: (on: boolean) => Promise<boolean>
}) {
  const reason = session.interruption?.reason
  const after = session.interruption?.resumeAfter
  const resets = after && !after.startsWith('0001') ? new Date(after) : undefined
  // A continued turn makes the banner go; until then the button stays busy.
  const [resume, continuing] = usePending(onContinue, { holdOnSuccess: true })
  // The checkbox shows the owner's choice at once and reverts if it isn't saved.
  const [saving, setSaving] = useState<boolean | null>(null)
  const autoContinue = saving ?? !!session.autoContinue
  const toggle = async (on: boolean) => {
    setSaving(on)
    try {
      await onAutoContinue(on)
    } finally {
      setSaving(null)
    }
  }
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
                aria-busy={saving !== null || undefined}
                checked={autoContinue}
                onChange={(e) => {
                  if (saving === null) void toggle(e.target.checked)
                }}
              />
              continue after reset
            </label>
          )}
          <button type="button" className="btn" aria-busy={continuing} onClick={() => void resume()}>
            {continuing ? 'Continuing…' : 'Continue'}
          </button>
        </span>
      )}
    </div>
  )
}
