import { useEffect, useState } from 'react'
import AccountPanel from './components/account/AccountPanel'
import RequestCard from './components/requests/RequestCard'
import QuotaWidget from './components/quota/QuotaWidget'
import RequestTray from './components/requests/RequestTray'
import TerminalPanel from './components/terminal/TerminalPanel'
import { fetchHealth, type Health, type Item, type Session } from './lib/api'
import { itemTree, sessionTree, type ItemNode, type SessionNode } from './lib/tree'
import { useSessionStore } from './stores/session'

export default function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const sessions = useSessionStore((s) => s.sessions)
  const activeId = useSessionStore((s) => s.activeId)
  const error = useSessionStore((s) => s.error)
  const loadSessions = useSessionStore((s) => s.loadSessions)
  const loadRequests = useSessionStore((s) => s.loadRequests)
  const loadQuotas = useSessionStore((s) => s.loadQuotas)
  const createSession = useSessionStore((s) => s.createSession)
  const selectSession = useSessionStore((s) => s.selectSession)

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
        <h1>go-chamber</h1>
        <span className={`health health-${health}`}>{health ?? 'connecting'}</span>
      </header>
      {health === 'unauthorized' && (
        <p className="notice">
          Open the URL with <code>?token=…</code> printed by go-chamber at startup.
        </p>
      )}
      {health === 'online' && (
        <div className="layout">
          <Sidebar
            sessions={sessions}
            activeId={activeId}
            onCreate={(agent, cwd) => void createSession(agent, cwd)}
            onSelect={(id) => void selectSession(id)}
          />
          {activeId ? <Chat /> : <section className="empty">Select or create a session.</section>}
          <div className="workbench">
            <RequestTray />
            <TerminalPanel sessionId={activeId} />
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </main>
  )
}

function Sidebar(props: {
  sessions: Session[]
  activeId: string | null
  onCreate: (agent: import('./lib/api').AgentKind, cwd: string) => void
  onSelect: (id: string) => void
}) {
  const [cwd, setCwd] = useState('')
  const [agent, setAgent] = useState<import('./lib/api').AgentKind>('claude')
  return (
    <aside className="sidebar">
      <form
        className="new-session"
        onSubmit={(e) => {
          e.preventDefault()
          if (cwd.trim()) props.onCreate(agent, cwd.trim())
        }}
      >
        <select aria-label="agent" value={agent} onChange={(e) => setAgent(e.target.value as import('./lib/api').AgentKind)}>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
        <input
          aria-label="working directory"
          placeholder="/path/to/project"
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
        />
        <button type="submit">New session</button>
      </form>
      <AccountPanel key={agent} agent={agent} />
      <QuotaWidget />
      <ul className="sessions">
        {sessionTree(props.sessions).map((node) => (
          <SessionNodeView
            key={node.session.id}
            node={node}
            activeId={props.activeId}
            onSelect={props.onSelect}
            depth={0}
          />
        ))}
      </ul>
    </aside>
  )
}

// ApprovalReviewerSelect chooses who reviews Codex approval requests
// (sandbox escapes, network access) for the active session.
function ApprovalReviewerSelect() {
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === s.activeId))
  const setReviewer = useSessionStore((s) => s.setApprovalReviewer)
  if (!session || session.agent !== 'codex') return null
  return (
    <label className="reviewer">
      Approvals
      <select
        aria-label="approval reviewer"
        value={session.approvalReviewer ?? ''}
        onChange={(e) => void setReviewer(session.id, e.target.value as import('./lib/api').ApprovalReviewer)}
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
      {tokens ? `${tokens} tokens` : ''}
      {cost ? ` $${cost.toFixed(4)}` : ''}
    </span>
  )
}

function SessionNodeView({
  node,
  activeId,
  onSelect,
  depth,
}: {
  node: SessionNode
  activeId: string | null
  onSelect: (id: string) => void
  depth: number
}) {
  const session = node.session
  return (
    <li>
      <button
        className={session.id === activeId ? 'session active' : 'session'}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onSelect(session.id)}
      >
        <span className="session-title">{session.title || session.cwd}</span>
        <span className={`status status-${session.status}`}>{session.status}</span>
      </button>
      {node.children.length > 0 && (
        <ul className="sessions">
          {node.children.map((child) => (
            <SessionNodeView
              key={child.session.id}
              node={child}
              activeId={activeId}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

function Chat() {
  const chat = useSessionStore((s) => s.chat)
  const connection = useSessionStore((s) => s.connection)
  const send = useSessionStore((s) => s.send)
  const steer = useSessionStore((s) => s.steer)
  const interrupt = useSessionStore((s) => s.interrupt)
  const respond = useSessionStore((s) => s.respond)
  const stopTask = useSessionStore((s) => s.stopTask)
  const [text, setText] = useState('')

  return (
    <section className="chat">
      <div className="chat-meta">
        <span className={`status status-${chat.status}`}>{chat.status}</span>
        <span className={`health health-${connection}`}>{connection}</span>
        <SessionUsage />
        <ApprovalReviewerSelect />
      </div>
      <ol className="items">
        {itemTree(chat.order, chat.items).map((node) => (
          <li key={node.item.id}>
            <ItemView node={node} onStopTask={stopTask} />
          </li>
        ))}
      </ol>
      {Object.values(chat.requests).map((request) => (
        <RequestCard key={request.id} request={request} onRespond={respond} />
      ))}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          const value = text.trim()
          if (value) {
            if (chat.status === 'running') {
              void steer(value)
            } else {
              void send(value)
            }
            setText('')
          }
        }}
      >
        <textarea
          aria-label="message"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Message the agent…"
        />
        {chat.status === 'running' ? <button type="submit">Steer</button> : <button type="submit">Send</button>}
        {chat.status === 'running' && (
          <button type="button" className="stop" onClick={() => void interrupt()}>
            Stop
          </button>
        )}
      </form>
    </section>
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
        <div className="item command">
          <code>{commandText(item)}</code>
          {item.text && <pre>{item.text}</pre>}
        </div>
      )
    case 'file_change':
      return (
        <div className="item file">
          <code>{item.path || item.name}</code>
          {item.diff && <pre>{item.diff}</pre>}
        </div>
      )
    case 'subagent':
      return (
        <div className="item subagent">
          <span>subagent: {item.name}</span>
          {item.text && <pre>{item.text}</pre>}
          {item.agentId && item.status !== 'completed' && item.status !== 'failed' && (
            <button className="stop-task" onClick={() => onStopTask(item.sessionId, item.agentId!)}>
              Stop
            </button>
          )}
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
        <div className="item tool">
          <code>{item.name}</code>
          {item.text && <pre>{item.text}</pre>}
        </div>
      )
  }
}

function commandText(item: Item): string {
  const input = item.input
  if (input && typeof input === 'object' && 'command' in input) {
    return String((input as { command: unknown }).command)
  }
  return item.name ?? 'command'
}
