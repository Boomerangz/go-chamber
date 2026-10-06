import { X } from 'lucide-react'
import { useState } from 'react'
import { openKey, useTerminalStore } from '../../stores/terminals'
import FolderField from '../folders/FolderField'
import { icon } from '../icon'

// NewTerminalForm opens a shell in a chosen folder (home when empty) or,
// given a session, in that session's folder. The field keeps what was typed
// until the shell opened, and a failure is shown right under it.
export default function NewTerminalForm({ sessionId }: { sessionId?: string | null }) {
  const open = useTerminalStore((s) => s.open)
  const opening = useTerminalStore((s) => s.opening)
  const [cwd, setCwd] = useState('')
  const dir = cwd.trim()
  const here = Boolean(opening[openKey(dir ? { cwd: dir } : {})])
  const inSession = Boolean(sessionId && opening[openKey({ sessionId })])
  return (
    <form
      className="new-terminal"
      aria-busy={here || inSession || undefined}
      onSubmit={(e) => {
        e.preventDefault()
        void open(dir ? { cwd: dir } : {}).then((ok) => {
          if (ok) setCwd('')
        })
      }}
    >
      <FolderField label="Terminal directory" placeholder="~ (home)" value={cwd} onChange={setCwd} />
      <button type="submit" className="btn" aria-busy={here || undefined}>
        {here ? 'Opening…' : 'New terminal'}
      </button>
      {sessionId && (
        <button type="button" className="btn" aria-busy={inSession || undefined} onClick={() => void open({ sessionId })}>
          {inSession ? 'Opening…' : 'In session dir'}
        </button>
      )}
      <OpenError />
    </form>
  )
}

// OpenError shows why the last terminal didn't open, until dismissed or the
// next one opens.
export function OpenError() {
  const error = useTerminalStore((s) => s.openError)
  const dismiss = useTerminalStore((s) => s.dismissOpenError)
  if (!error) return null
  return (
    <p className="term-error" role="alert">
      <span>Couldn't open a terminal: {error}</span>
      <button type="button" className="btn btn-ghost btn-icon" aria-label="Dismiss" title="Dismiss" onClick={dismiss}>
        <X {...icon(13)} />
      </button>
    </p>
  )
}
