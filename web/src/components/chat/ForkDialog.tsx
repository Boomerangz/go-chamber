import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AgentKind, Session } from '../../lib/api'
import { missingCLIs, useCapabilities, useCLIs } from '../../lib/clis'

export default function ForkDialog({ session, onFork, onClose }: {
  session: Session
  onFork: (agent?: AgentKind) => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [agent, setAgent] = useState(session.agent)
  const clis = useCLIs((s) => s.clis)
  const missing = missingCLIs(clis)
  const caps = useCapabilities(session.agent)
  useEffect(() => { dialog.current?.showModal() }, [])
  return createPortal(
    <dialog ref={dialog} className="fork-dialog" aria-label="Fork session" onCancel={onClose} onClose={onClose} onClick={(e) => {
      if (e.target === e.currentTarget) onClose()
    }}>
      <form onSubmit={(e) => {
        e.preventDefault()
        onClose()
        onFork(agent === session.agent ? undefined : agent)
      }}>
        <h3>Fork session</h3>
        <p>Create a separate session in the same working directory. File changes are shared.</p>
        <label>Agent
          <select className="field" aria-label="Fork agent" value={agent} onChange={(e) => setAgent(e.target.value as AgentKind)} autoFocus>
            <option value="claude" disabled={missing.includes('claude')}>Claude</option>
            <option value="codex" disabled={missing.includes('codex')}>Codex</option>
            <option value="opencode" disabled={missing.includes('opencode')}>OpenCode</option>
          </select>
        </label>
        {agent !== session.agent && <p>The new agent will receive a transcript file to continue from.</p>}
        <div className="fork-dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={missing.includes(agent) || (agent === session.agent && !caps.fork)}>Create fork</button>
        </div>
      </form>
    </dialog>, document.body,
  )
}
