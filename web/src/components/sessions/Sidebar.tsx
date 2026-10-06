import { useCallback, useRef, useState } from 'react'
import AccountPanel from '../account/AccountPanel'
import AgentAvatar from '../AgentAvatar'
import FolderField from '../folders/FolderField'
import QuotaWidget from '../quota/QuotaWidget'
import { SignOut } from '../shell/Shell'
import HistoryPanel from './HistoryPanel'
import SessionList from './SessionList'
import { recentFolders } from '../../lib/folders'
import { usePending } from '../../lib/pending'
import './Sidebar.css'
import type { AgentKind, Session } from '../../lib/api'

const AGENT_KEY = 'gc.lastAgent'

function lastAgent(): AgentKind {
  try {
    const v = localStorage.getItem(AGENT_KEY)
    return v === 'codex' || v === 'claude' ? v : 'claude'
  } catch {
    return 'claude'
  }
}

function rememberAgent(agent: AgentKind) {
  try {
    localStorage.setItem(AGENT_KEY, agent)
  } catch {
    // Private mode or blocked storage: the choice just isn't remembered.
  }
}

export interface SidebarProps {
  // onCreate resolves true when the session started.
  onCreate: (agent: AgentKind, cwd: string, branch?: string) => Promise<boolean>
  sessions: Session[]
}

export default function Sidebar(props: SidebarProps) {
  const [cwd, setCwd] = useState('')
  const [agent, setAgent] = useState<AgentKind>(lastAgent)
  const [inWorktree, setInWorktree] = useState(false)
  const [branch, setBranch] = useState('')
  // missing names the field a submit found empty, until it is filled.
  const [missing, setMissing] = useState<'cwd' | 'branch' | null>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const branchInput = useRef<HTMLInputElement>(null)

  const { onCreate } = props
  const start = useCallback(
    async (agent: AgentKind, dir: string, branch?: string) => {
      const ok = await onCreate(agent, dir, branch)
      if (ok && branch) setBranch('')
      return ok
    },
    [onCreate],
  )
  const [create, creating] = usePending(start)

  const submit = () => {
    if (!cwd.trim()) {
      setMissing('cwd')
      folderInput.current?.focus()
      return
    }
    if (inWorktree && !branch.trim()) {
      setMissing('branch')
      branchInput.current?.focus()
      return
    }
    void create(agent, cwd.trim(), inWorktree ? branch.trim() : undefined)
  }

  return (
    <aside className="sidebar panel">
      <form
        className="new-session"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="segmented" role="radiogroup" aria-label="agent">
          {(['claude', 'codex'] as const).map((a) => (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={agent === a}
              onClick={() => {
                setAgent(a)
                rememberAgent(a)
              }}
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
          onChange={(v) => {
            setCwd(v)
            if (missing === 'cwd' && v.trim()) setMissing(null)
          }}
          recent={recentFolders(props.sessions, 6)}
          invalid={missing === 'cwd'}
          inputRef={folderInput}
        />
        <label className="worktree-toggle">
          <input type="checkbox" checked={inWorktree} onChange={(e) => setInWorktree(e.target.checked)} />
          In a new worktree
        </label>
        {inWorktree && (
          <label className="worktree-branch">
            <span>chamber/</span>
            <input
              ref={branchInput}
              className="field"
              aria-label="branch name"
              aria-invalid={missing === 'branch' || undefined}
              placeholder="branch name"
              value={branch}
              onChange={(e) => {
                setBranch(e.target.value)
                if (missing === 'branch' && e.target.value.trim()) setMissing(null)
              }}
            />
          </label>
        )}
        <button type="submit" className="btn btn-primary" aria-busy={creating || undefined}>
          {creating ? 'Starting…' : 'New session'}
        </button>
      </form>
      <SessionList agent={agent} creating={creating} onCreateIn={(dir) => void create(agent, dir)} />
      <HistoryPanel />
      <footer className="sidebar-footer">
        <AccountPanel key={agent} agent={agent} />
        <QuotaWidget />
        <SignOut className="sidebar-signout" />
      </footer>
    </aside>
  )
}
