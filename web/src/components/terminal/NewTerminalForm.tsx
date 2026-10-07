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
        <X {...icon(14)} />
      </button>
    </p>
  )
}

// EndedNote says, in one line, that shells this tab knew ended when the
// server restarted, instead of letting them vanish; it goes once a shell
// is opened.
export function EndedNote() {
  const ended = useTerminalStore((s) => s.ended)
  if (ended === 0) return null
  return (
    <p className="terminal-hint term-ended" role="status" aria-label="Shells ended">
      {ended} {ended === 1 ? 'shell' : 'shells'} ended when go-chamber restarted
    </p>
  )
}
