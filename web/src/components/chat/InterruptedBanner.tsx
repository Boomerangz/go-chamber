import { useEffect, useState } from 'react'
import type { Session } from '../../lib/api'
import { usePending } from '../../lib/pending'
import { SENT_HOLD_MS, useLiveDropped } from './useLiveDropped'

const interruptionText: Record<string, string> = {
  crashed: 'the agent process exited unexpectedly',
  idle_timeout: 'the agent was stopped after being idle',
  server_restart: 'go-chamber restarted mid-turn',
  quota: 'the subscription limit was reached',
}

export default function InterruptedBanner({
  session,
  blocked,
  onContinue,
  onAutoContinue,
}: {
  session: Session
  // blocked says why Continue can't run now (the agent's CLI is missing).
  blocked?: string
  // Both resolve true once the server took the change.
  onContinue: () => Promise<boolean>
  onAutoContinue: (on: boolean) => Promise<boolean>
}) {
  const reason = session.interruption?.reason
  const after = session.interruption?.resumeAfter
  const resets = after && !after.startsWith('0001') ? new Date(after) : undefined
  // A continued turn makes the banner go; until then the button stays busy,
  // but not forever: with the agent quiet or the live socket down it lets go
  // and says the continue was sent.
  const [resume, continuing] = usePending(onContinue)
  const [held, setHeld] = useState(false)
  const [sent, setSent] = useState(false)
  const dropped = useLiveDropped()
  if (held && dropped) {
    setHeld(false)
    setSent(true)
  }
  useEffect(() => {
    if (!held) return
    const timer = setTimeout(() => {
      setHeld(false)
      setSent(true)
    }, SENT_HOLD_MS)
    return () => clearTimeout(timer)
  }, [held])
  const busy = continuing || held
  const run = async () => {
    if (busy) return
    setSent(false)
    if (await resume()) setHeld(true)
  }
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
        {session.interruption?.withRequest && ' It was waiting for your answer; Continue and the agent asks again.'}
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
          {sent && <span className="composer-note">sent · waiting for agent</span>}
          <button type="button" className="btn" aria-busy={busy} disabled={Boolean(blocked)} title={blocked} onClick={() => void run()}>
            {busy ? 'Continuing…' : 'Continue'}
          </button>
        </span>
      )}
    </div>
  )
}
