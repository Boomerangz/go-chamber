import { useCallback, useRef, useState } from 'react'
import { Accounts } from '../account/AccountPanel'
import AgentAvatar from '../AgentAvatar'
import FolderField from '../folders/FolderField'
import QuotaWidget from '../quota/QuotaWidget'
import ArchivedSessions from './ArchivedSessions'
import { SignOut } from '../shell/Shell'
import HistoryPanel from './HistoryPanel'
import SessionList from './SessionList'
import { recentFolders } from '../../lib/folders'
import { usePending } from '../../lib/pending'
import { groupSessions } from '../../lib/sessions'
import { useSessionStore } from '../../stores/session'
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

const FOLDER_KEY = 'gc.lastFolder'

function lastFolder(): string {
  try {
    return localStorage.getItem(FOLDER_KEY) ?? ''
  } catch {
    return ''
  }
}

function rememberFolder(cwd: string) {
  try {
    localStorage.setItem(FOLDER_KEY, cwd)
  } catch {
    // Storage blocked: the next start begins empty.
  }
}

// CHIPS is how many recent folders sit under the folder field.
const CHIPS = 4

export interface SidebarProps {
  // onCreate resolves true when the session started.
  onCreate: (agent: AgentKind, cwd: string, branch?: string) => Promise<boolean>
  sessions: Session[]
}

export default function Sidebar(props: SidebarProps) {
  // typed is what the owner chose; until then the field offers the open
  // session's folder, or the one last started in.
  const [typed, setTyped] = useState<string | null>(null)
  const activeCwd = useSessionStore((s) => s.sessions.find((x) => x.id === s.activeId)?.cwd)
  const [remembered, setRemembered] = useState(lastFolder)
  const cwd = typed ?? activeCwd ?? remembered
  const setCwd = setTyped
  // creatingIn is the folder whose group "+" is starting a session.
  const [creatingIn, setCreatingIn] = useState<string | null>(null)
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
      if (ok) {
        rememberFolder(dir)
        setRemembered(dir)
      }
      if (ok && branch) setBranch('')
      return ok
    },
    [onCreate],
  )
  const [create, creating] = usePending(start)
  const createIn = async (dir: string) => {
    setCreatingIn(dir)
    try {
      await create(agent, dir)
    } finally {
      setCreatingIn(null)
    }
  }
  const chips = groupSessions(props.sessions.filter((s) => !s.parentId)).slice(0, CHIPS)

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
        {missing === 'cwd' && (
          <p className="field-hint" role="alert">
            Choose a folder first
          </p>
        )}
        {chips.length > 0 && (
          <div className="recent folder-chips" role="group" aria-label="Recent folders">
            {chips.map((g) => (
              <button
                type="button"
                key={g.cwd}
                className="chip"
                title={g.cwd}
                aria-pressed={g.cwd === cwd}
                onClick={() => {
                  setCwd(g.cwd)
                  if (missing === 'cwd') setMissing(null)
                }}
              >
                {g.name}
              </button>
            ))}
          </div>
        )}
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
        <button type="submit" className="btn btn-primary" title="New session (n)" aria-busy={(creating && !creatingIn) || undefined}>
          {creating && !creatingIn ? 'Starting…' : 'New session'}
        </button>
      </form>
      <SessionList agent={agent} creating={creating} creatingIn={creatingIn} onCreateIn={(dir) => void createIn(dir)} />
      <ArchivedSessions />
      <HistoryPanel />
      <footer className="sidebar-footer">
        <Accounts />
        <QuotaWidget />
        <SignOut className="sidebar-signout" />
      </footer>
    </aside>
  )
}
