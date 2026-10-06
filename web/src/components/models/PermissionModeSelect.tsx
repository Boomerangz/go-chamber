import { useRef, useState } from 'react'
import type { Session } from '../../lib/api'
import { isDangerousMode } from '../../lib/models'
import { useSessionStore } from '../../stores/session'
import './PermissionModeSelect.css'

// modes are each agent's approval behaviours: Claude's permission modes and
// Codex's approval-and-sandbox presets. Empty defers to the agent's config.
const modes: Record<Session['agent'], [string, string][]> = {
  claude: [
    ['default', 'ask before edits'],
    ['acceptEdits', 'accept edits'],
    ['plan', 'plan only'],
    ['bypassPermissions', 'bypass permissions'],
  ],
  codex: [
    ['read-only', 'read only'],
    ['auto', 'auto'],
    ['full-access', 'full access'],
  ],
}

const dangerTitle = "The agent won't ask before running commands or editing files"

// PermissionModeSelect chooses how the agent asks before acting. The new
// mode shows at once with a busy mark while it saves, and goes back if the
// server refuses it.
export default function PermissionModeSelect({ session }: { session: Session }) {
  const setMode = useSessionStore((s) => s.setPermissionMode)
  const [pending, setPending] = useState<string | null>(null)
  const latest = useRef(0)
  const value = pending ?? session.permissionMode ?? ''
  const danger = isDangerousMode(value)

  const change = async (mode: string) => {
    const ticket = ++latest.current
    setPending(mode)
    await setMode(session.id, mode)
    if (ticket === latest.current) setPending(null)
  }

  return (
    <label className="reviewer">
      Mode
      <select
        className={`field field-sm${danger ? ' mode-danger' : ''}`}
        aria-label="permission mode"
        aria-busy={pending !== null || undefined}
        title={danger ? dangerTitle : undefined}
        value={value}
        onChange={(e) => void change(e.target.value)}
      >
        <option value="">from {session.agent === 'codex' ? 'Codex' : 'Claude'} config</option>
        {modes[session.agent].map(([v, label]) => (
          <option key={v} value={v} title={isDangerousMode(v) ? dangerTitle : undefined}>
            {label}
          </option>
        ))}
      </select>
      {pending !== null && <span className="busy-mark" aria-hidden="true" />}
    </label>
  )
}
