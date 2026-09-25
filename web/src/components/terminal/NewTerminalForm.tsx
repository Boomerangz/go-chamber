import { useState } from 'react'
import { useTerminalStore } from '../../stores/terminals'
import FolderField from '../folders/FolderField'

// NewTerminalForm opens a shell in a chosen folder (home when empty) or,
// given a session, in that session's folder.
export default function NewTerminalForm({ sessionId }: { sessionId?: string | null }) {
  const open = useTerminalStore((s) => s.open)
  const [cwd, setCwd] = useState('')
  return (
    <form
      className="new-terminal"
      onSubmit={(e) => {
        e.preventDefault()
        const dir = cwd.trim()
        void open(dir ? { cwd: dir } : {})
        setCwd('')
      }}
    >
      <FolderField label="terminal directory" placeholder="~ (home)" value={cwd} onChange={setCwd} />
      <button type="submit" className="btn">
        New terminal
      </button>
      {sessionId && (
        <button type="button" className="btn" onClick={() => void open({ sessionId })}>
          In session dir
        </button>
      )}
    </form>
  )
}
