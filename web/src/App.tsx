import { useEffect, useState } from 'react'
import AccountPanel from './components/account/AccountPanel'
import FolderField from './components/folders/FolderField'
import ModelPicker from './components/models/ModelPicker'
import RequestCard from './components/requests/RequestCard'
import QuotaWidget from './components/quota/QuotaWidget'
import RequestTray from './components/requests/RequestTray'
import SessionList from './components/sessions/SessionList'
import TerminalPanel from './components/terminal/TerminalPanel'
import { fetchHealth, type AgentKind, type ApprovalReviewer, type Health, type Item, type Session } from './lib/api'
import { recentFolders } from './lib/folders'
import { sessionTitle } from './lib/sessions'
import { displayStatus } from './lib/format'
import { itemTree, type ItemNode } from './lib/tree'
import { useSessionStore, type Pane } from './stores/session'

export default function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const sessions = useSessionStore((s) => s.sessions)
  const activeId = useSessionStore((s) => s.activeId)
  const pane = useSessionStore((s) => s.pane)
  const error = useSessionStore((s) => s.error)
  const loadSessions = useSessionStore((s) => s.loadSessions)
  const loadRequests = useSessionStore((s) => s.loadRequests)
  const loadQuotas = useSessionStore((s) => s.loadQuotas)
  const createSession = useSessionStore((s) => s.createSession)

  useEffect(() => {
    let alive = true
    fetchHealth().then((h) => alive && setHealth(h))
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (health === 'online') {
      void loadSessions()
      void loadRequests()
      void loadQuotas()
    }
  }, [health, loadSessions, loadRequests, loadQuotas])

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <h1>go-chamber</h1>
        </div>
        <span className={`health health-${health ?? 'connecting'}`}>
          <span className="dot" aria-hidden="true" />
          {health ?? 'connecting'}
        </span>
      </header>
      {health === 'unauthorized' && (
        <section className="notice panel">
          <h2>Token required</h2>
          <p>
            Open the URL with <code>?token=…</code> printed by go-chamber at startup.
          </p>
        </section>
      )}
      {health === 'online' && (
        <>
          <div className="layout" data-pane={pane}>
            <Sidebar sessions={sessions} onCreate={(agent, cwd) => void createSession(agent, cwd)} />
            {activeId ? <Chat /> : <EmptyChat />}
            <div className="workbench">
              <RequestTray />
              <TerminalPanel sessionId={activeId} />
            </div>
          </div>
          <PaneBar />
        </>
      )}
      {error && (
        <p className="error toast" role="alert">
          {error}
        </p>
      )}
    </main>
  )
}

const panes: { id: Pane; label: string; icon: string }[] = [
  { id: 'sessions', label: 'Sessions', icon: '☰' },
  { id: 'chat', label: 'Chat', icon: '✦' },
  { id: 'requests', label: 'Requests', icon: '◉' },
  { id: 'terminal', label: 'Terminal', icon: '›_' },
]

// PaneBar switches views on narrow screens; hidden on desktop by CSS.
function PaneBar() {
  const pane = useSessionStore((s) => s.pane)
  const setPane = useSessionStore((s) => s.setPane)
  const pending = useSessionStore((s) => s.pendingRequests.length)
  return (
    <nav className="panebar" aria-label="Views">
      {panes.map((p) => (
        <button key={p.id} aria-pressed={pane === p.id} onClick={() => setPane(p.id)}>
          <span className="panebar-icon" aria-hidden="true">
            {p.icon}
          </span>
          {p.label}
          {p.id === 'requests' && pending > 0 && <span className="badge">{pending}</span>}
        </button>
      ))}
    </nav>
  )
}

function EmptyChat() {
  return (
    <section className="chat empty panel">
      <div className="hero">
        <span className="hero-mark" aria-hidden="true" />
        <h2>Start a session</h2>
        <p>Pick an agent and a project folder on the left, or open an existing session.</p>
      </div>
    </section>
  )
}

function Sidebar(props: { onCreate: (agent: AgentKind, cwd: string) => void; sessions: Session[] }) {
  const [cwd, setCwd] = useState('')
  const [agent, setAgent] = useState<AgentKind>('claude')
  return (
    <aside className="sidebar panel">
      <form
        className="new-session"
        onSubmit={(e) => {
          e.preventDefault()
          if (cwd.trim()) props.onCreate(agent, cwd.trim())
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
        <button type="submit" className="btn btn-primary">
          New session
        </button>
      </form>
      <SessionList onCreateIn={(dir) => props.onCreate(agent, dir)} />
      <footer className="sidebar-footer">
        <AccountPanel key={agent} agent={agent} />
        <QuotaWidget />
      </footer>
    </aside>
  )
}

// ApprovalReviewerSelect chooses who reviews Codex approval requests
// (sandbox escapes, network access) for the active session.
function ApprovalReviewerSelect({ session }: { session: Session }) {
  const setReviewer = useSessionStore((s) => s.setApprovalReviewer)
  if (session.agent !== 'codex') return null
  return (
    <label className="reviewer">
      Approvals
      <select
        className="field field-sm"
        aria-label="approval reviewer"
        value={session.approvalReviewer ?? ''}
        onChange={(e) => void setReviewer(session.id, e.target.value as ApprovalReviewer)}
      >
        <option value="" disabled>
          from Codex config
        </option>
        <option value="user">ask me</option>
        <option value="auto_review">auto-review</option>
      </select>
    </label>
  )
}

function SessionUsage() {
  const usage = useSessionStore((s) => s.chat.usage)
  const result = useSessionStore((s) => s.chat.result)
  const tokens = usage?.totalTokens ?? ((result?.inputTokens ?? 0) + (result?.outputTokens ?? 0))
  const cost = usage?.costUsd ?? result?.costUsd
  if (!tokens && !cost) return null
  return (
    <span className="usage" aria-label="session usage">
      {tokens ? `${tokens.toLocaleString()} tokens` : ''}
      {cost ? ` · $${cost.toFixed(4)}` : ''}
    </span>
  )
}

function AgentAvatar({ agent }: { agent: AgentKind }) {
  return (
    <span className={`avatar avatar-${agent}`} aria-hidden="true">
      {agent === 'claude' ? 'C' : 'X'}
    </span>
  )
}

function Chat() {
  const chat = useSessionStore((s) => s.chat)
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === s.activeId))
  const connection = useSessionStore((s) => s.connection)
  const send = useSessionStore((s) => s.send)
  const steer = useSessionStore((s) => s.steer)
  const interrupt = useSessionStore((s) => s.interrupt)
  const respond = useSessionStore((s) => s.respond)
  const stopTask = useSessionStore((s) => s.stopTask)
  const [text, setText] = useState('')
  const status = displayStatus(chat, session)
  const running = status === 'running'

  const submit = () => {
    const value = text.trim()
    if (!value) return
    if (running) {
      void steer(value)
    } else {
      void send(value)
    }
    setText('')
  }

  return (
    <section className="chat panel">
      <header className="chat-header">
        {session && <AgentAvatar agent={session.agent} />}
        <div className="chat-heading">
          <h2>{session ? sessionTitle(session) : 'Session'}</h2>
          {session && <span className="chat-path">{session.cwd}</span>}
        </div>
        <div className="chat-meta">
          <span className={`status status-${status}`}>{status}</span>
          {connection !== 'online' && <span className={`health health-${connection}`}>{connection}</span>}
          <SessionUsage />
          {session && <ModelPicker session={session} />}
          {session && <ApprovalReviewerSelect session={session} />}
        </div>
      </header>
      <div className="scroll">
        <ol className="items">
          {itemTree(chat.order, chat.items).filter((node) => !isBlank(node.item)).map((node) => (
            <li key={node.item.id} className={`row row-${node.item.kind}`}>
              <ItemView node={node} onStopTask={stopTask} />
            </li>
          ))}
        </ol>
        {chat.order.length === 0 && status !== 'interrupted' && (
          <p className="chat-hint">Send a message to start. The agent runs in {session?.cwd ?? 'the session folder'}.</p>
        )}
        {Object.values(chat.requests).map((request) => (
          <RequestCard key={request.id} request={request} onRespond={respond} />
        ))}
      </div>
      {status === 'interrupted' && session && <InterruptedBanner session={session} />}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <textarea
          aria-label="message"
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={running ? 'Steer the running turn…' : 'Message the agent…  ⌘↵ to send'}
        />
        <div className="composer-actions">
          {running && (
            <button type="button" className="btn btn-danger stop" onClick={() => void interrupt()}>
              Stop
            </button>
          )}
          <button type="submit" className="btn btn-primary">
            {running ? 'Steer' : 'Send'}
          </button>
        </div>
      </form>
    </section>
  )
}

const interruptionText: Record<string, string> = {
  crashed: 'the agent process exited unexpectedly',
  idle_timeout: 'the agent was stopped after being idle',
  server_restart: 'go-chamber restarted mid-turn',
  quota: 'the subscription limit was reached',
}

function InterruptedBanner({ session }: { session: Session }) {
  const reason = session.interruption?.reason
  const after = session.interruption?.resumeAfter
  return (
    <div className="banner banner-warn" role="status">
      <strong>Turn interrupted</strong>
      <span>
        {reason ? interruptionText[reason] ?? reason : 'the turn ended abnormally'}.{' '}
        {after && !after.startsWith('0001')
          ? `Resume after ${new Date(after).toLocaleTimeString()}.`
          : 'Send a message to resume the session.'}
      </span>
    </div>
  )
}

function ItemView({
  node,
  onStopTask,
}: {
  node: ItemNode
  onStopTask: (sessionId: string, taskId: string) => void
}) {
  const item = node.item
  switch (item.kind) {
    case 'user_message':
      return <div className="item user">{item.text}</div>
    case 'assistant_message':
      return <div className="item assistant">{item.text}</div>
    case 'reasoning':
      return (
        <details className="item reasoning">
          <summary>Thinking</summary>
          <pre>{item.text}</pre>
        </details>
      )
    case 'command':
      return (
        <div className={`item command state-${item.status}`}>
          <span className="item-icon" aria-hidden="true">
            $
          </span>
          <code>{commandText(item)}</code>
          {item.text && <pre>{item.text}</pre>}
        </div>
      )
    case 'file_change':
      return (
        <div className={`item file state-${item.status}`}>
          <span className="item-icon" aria-hidden="true">
            ✎
          </span>
          <code>{item.path || item.name}</code>
          {item.diff && <pre>{item.diff}</pre>}
        </div>
      )
    case 'hook':
      return <HookView item={item} />
    case 'subagent':
      return (
        <div className={`item subagent state-${item.status}`}>
          <div className="subagent-head">
            <span className="item-icon" aria-hidden="true">
              ⧉
            </span>
            <span>subagent: {item.name}</span>
            {item.agentId && item.status !== 'completed' && item.status !== 'failed' && (
              <button className="btn btn-ghost btn-xs stop-task" onClick={() => onStopTask(item.sessionId, item.agentId!)}>
                Stop
              </button>
            )}
          </div>
          {item.text && <pre>{item.text}</pre>}
          {node.children.length > 0 && (
            <ol className="subagent-items">
              {node.children.map((child) => (
                <li key={child.item.id}>
                  <ItemView node={child} onStopTask={onStopTask} />
                </li>
              ))}
            </ol>
          )}
        </div>
      )
    default:
      return (
        <div className={`item tool state-${item.status}`}>
          <span className="item-icon" aria-hidden="true">
            ⚙
          </span>
          <code>{item.name}</code>
          {item.text && <pre>{item.text}</pre>}
        </div>
      )
  }
}

const hookBadge: Record<string, string> = { success: 'ok', blocked: 'blocked', error: 'error' }

// HookView shows a user-configured hook the agent ran; a hook that blocked
// the agent explains why the agent continued.
function HookView({ item }: { item: Item }) {
  const outcome = item.outcome ?? (item.status === 'streaming' || item.status === 'pending' ? 'running' : 'success')
  const head = (
    <>
      <span className="item-icon" aria-hidden="true">
        ⚡
      </span>
      <span className="hook-name">{item.name} hook</span>
      <span className={`hook-badge hook-${outcome}`}>{hookBadge[outcome] ?? outcome}</span>
      {item.text && <span className="hook-preview">{item.text}</span>}
    </>
  )
  if (!item.text) return <div className={`item hook outcome-${outcome}`}>{head}</div>
  return (
    <details className={`item hook outcome-${outcome}`}>
      <summary>{head}</summary>
      <pre>{item.text}</pre>
    </details>
  )
}

// isBlank hides finished assistant messages without text (Codex sends
// them, e.g. after a hook continued the turn).
function isBlank(item: Item): boolean {
  return item.kind === 'assistant_message' && item.status === 'completed' && !item.text?.trim()
}

function commandText(item: Item): string {
  const input = item.input
  if (input && typeof input === 'object' && 'command' in input) {
    return String((input as { command: unknown }).command)
  }
  return item.name ?? 'command'
}
