import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { icon } from '../icon'
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
import { useIsRepo } from '../../lib/useIsRepo'
import { recentProjects } from '../../lib/sessions'
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
  // A worktree session offers its repository: a worktree of a worktree isn't wanted.
  const activeCwd = useSessionStore((s) => {
    const active = s.sessions.find((x) => x.id === s.activeId)
    return active?.worktree?.repo ?? active?.cwd
  })
  const [remembered, setRemembered] = useState(lastFolder)
  const cwd = typed ?? activeCwd ?? remembered
  const setCwd = setTyped
  // creatingIn is the folder whose group "+" is starting a session.
  const [creatingIn, setCreatingIn] = useState<string | null>(null)
  const [agent, setAgent] = useState<AgentKind>(lastAgent)
  const [wantWorktree, setInWorktree] = useState(false)
  // A worktree needs a repository: a folder known not to be one can't have it.
  const repo = useIsRepo(cwd)
  const inWorktree = wantWorktree && repo !== false
  const [branch, setBranch] = useState('')
  // A new search reads from the top: what matches is above, not scrolled past.
  const body = useRef<HTMLDivElement>(null)
  const query = useSessionStore((s) => s.query)
  const searched = useRef(query)
  useEffect(() => {
    if (searched.current === query) return
    searched.current = query
    if (body.current) body.current.scrollTop = 0
  }, [query])
  // missing names the field a submit found empty, until it is filled.
  const [missing, setMissing] = useState<'cwd' | 'branch' | null>(null)
  // composing unfolds the form on phones, where it otherwise folds to one
  // line so the sessions own the screen. Wider screens always show it.
  const [composing, setComposing] = useState(false)
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
      if (ok) setComposing(false)
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
  const chips = recentProjects(props.sessions, CHIPS)

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
        data-folded={!composing || undefined}
        noValidate
        onFocus={(e) => {
          if (e.target !== e.currentTarget.querySelector('.new-session-open')) setComposing(true)
        }}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <button type="button" className="new-session-open" aria-expanded={composing} onClick={() => setComposing(!composing)}>
          <ChevronDown {...icon(14)} className="icon chevron" />
          Start a session
        </button>
        <div className="segmented" role="radiogroup" aria-label="Agent">
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
          label="Working directory"
          placeholder="Choose a project folder"
          value={cwd}
          onChange={(v) => {
            setCwd(v)
            if (missing === 'cwd' && v.trim()) setMissing(null)
          }}
          recent={recentFolders(props.sessions, 6)}
          invalid={missing === 'cwd'}
          describedBy={missing === 'cwd' ? 'new-session-folder-hint' : undefined}
          inputRef={folderInput}
        />
        {missing === 'cwd' && (
          <p className="field-hint" id="new-session-folder-hint" role="alert">
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
                <span className="chip-label">{g.name}</span>
              </button>
            ))}
          </div>
        )}
        <label className="worktree-toggle">
          <input
            type="checkbox"
            checked={inWorktree}
            disabled={repo === false}
            aria-describedby={repo === false ? 'new-session-worktree-off' : undefined}
            onChange={(e) => setInWorktree(e.target.checked)}
          />
          In a new worktree
          {repo === false && (
            <span className="worktree-off" id="new-session-worktree-off">
              · not a git repository
            </span>
          )}
        </label>
        {inWorktree && (
          <label className="worktree-branch">
            <span>chamber/</span>
            <input
              ref={branchInput}
              className="field"
              aria-label="Branch name"
              aria-invalid={missing === 'branch' || undefined}
              aria-describedby={missing === 'branch' ? 'new-session-branch-hint' : undefined}
              placeholder="branch name"
              value={branch}
              onChange={(e) => {
                setBranch(e.target.value)
                if (missing === 'branch' && e.target.value.trim()) setMissing(null)
              }}
            />
          </label>
        )}
        {inWorktree && missing === 'branch' && (
          <p className="field-hint" id="new-session-branch-hint" role="alert">
            Name the branch
          </p>
        )}
        <button type="submit" className="btn btn-primary" title="New session (n)" aria-busy={(creating && !creatingIn) || undefined}>
          {creating && !creatingIn ? 'Starting…' : 'New session'}
        </button>
      </form>
      <div className="sidebar-body" ref={body}>
        <SessionList agent={agent} creating={creating} creatingIn={creatingIn} onCreateIn={(dir) => void createIn(dir)} />
        <ArchivedSessions />
        <HistoryPanel />
      </div>
      <footer className="sidebar-footer">
        <Accounts />
        <QuotaWidget />
        <SignOut className="sidebar-signout" />
      </footer>
    </aside>
  )
}
