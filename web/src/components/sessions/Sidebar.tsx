import { useState } from 'react'
import AccountPanel from '../account/AccountPanel'
import AgentAvatar from '../AgentAvatar'
import FolderField from '../folders/FolderField'
import QuotaWidget from '../quota/QuotaWidget'
import HistoryPanel from './HistoryPanel'
import SessionList from './SessionList'
import { recentFolders } from '../../lib/folders'
import type { AgentKind, Session } from '../../lib/api'

export default function Sidebar(props: { onCreate: (agent: AgentKind, cwd: string, branch?: string) => void; sessions: Session[] }) {
  const [cwd, setCwd] = useState('')
  const [agent, setAgent] = useState<AgentKind>('claude')
  const [inWorktree, setInWorktree] = useState(false)
  const [branch, setBranch] = useState('')
  return (
    <aside className="sidebar panel">
      <form
        className="new-session"
        onSubmit={(e) => {
          e.preventDefault()
          if (cwd.trim() && (!inWorktree || branch.trim())) props.onCreate(agent, cwd.trim(), inWorktree ? branch.trim() : undefined)
        }}
      >
        <div className="segmented" role="radiogroup" aria-label="agent">
          {(['claude', 'codex'] as const).map((a) => (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={agent === a}
              onClick={() => setAgent(a)}
            >
              <AgentAvatar agent={a} />
              {a === 'claude' ? 'Claude' : 'Codex'}
            </button>
          ))}
        </div>
        <FolderField
          label="working directory"
          placeholder="Choose a project folder"
          value={cwd}
          onChange={setCwd}
          recent={recentFolders(props.sessions, 6)}
        />
        <label className="worktree-toggle">
          <input type="checkbox" checked={inWorktree} onChange={(e) => setInWorktree(e.target.checked)} />
          In a new worktree
        </label>
        {inWorktree && (
          <label className="worktree-branch">
            <span>chamber/</span>
            <input
              className="field"
              aria-label="branch name"
              placeholder="branch name"
              value={branch}
              required
              onChange={(e) => setBranch(e.target.value)}
            />
          </label>
        )}
        <button type="submit" className="btn btn-primary">
          New session
        </button>
      </form>
      <SessionList onCreateIn={(dir) => props.onCreate(agent, dir)} />
      <HistoryPanel />
      <footer className="sidebar-footer">
        <AccountPanel key={agent} agent={agent} />
        <QuotaWidget />
      </footer>
    </aside>
  )
}
