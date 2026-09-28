import type { Session } from '../../lib/api'
import { useSessionStore } from '../../stores/session'

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

// PermissionModeSelect chooses how the agent asks before acting.
export default function PermissionModeSelect({ session }: { session: Session }) {
  const setMode = useSessionStore((s) => s.setPermissionMode)
  return (
    <label className="reviewer">
      Mode
      <select
        className="field field-sm"
        aria-label="permission mode"
        value={session.permissionMode ?? ''}
        onChange={(e) => void setMode(session.id, e.target.value)}
      >
        <option value="">from {session.agent === 'codex' ? 'Codex' : 'Claude'} config</option>
        {modes[session.agent].map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  )
}
