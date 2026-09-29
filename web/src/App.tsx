import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion, type TargetAndTransition } from 'motion/react'
import {
  ChevronsRight,
  FileDiff,
  FilePen,
  Inbox,
  List,
  MessageSquareText,
  SquareTerminal,
  Terminal,
  Webhook,
  Workflow,
  Wrench,
} from 'lucide-react'
import { icon } from './components/icon'
import AccountPanel from './components/account/AccountPanel'
import DiffPanel from './components/changes/DiffPanel'
import FolderField from './components/folders/FolderField'
import Markdown from './components/markdown/Markdown'
import ModelPicker from './components/models/ModelPicker'
import PermissionModeSelect from './components/models/PermissionModeSelect'
import ComposerInput from './components/composer/ComposerInput'
import Attachments from './components/composer/Attachments'
import { useAttachments } from './components/composer/useAttachments'
import InterruptedBanner from './components/chat/InterruptedBanner'
import EditableTitle from './components/title/EditableTitle'
import NotifyToggle from './components/notify/NotifyToggle'
import RequestCard from './components/requests/RequestCard'
import QuotaWidget from './components/quota/QuotaWidget'
import RequestTray from './components/requests/RequestTray'
import SessionList from './components/sessions/SessionList'
import HistoryPanel from './components/sessions/HistoryPanel'
import TerminalPanel from './components/terminal/TerminalPanel'
import TerminalWorkspace from './components/terminal/TerminalWorkspace'
import { fetchHealth, imageUrl, type AgentKind, type ApprovalReviewer, type Health, type Item, type Session } from './lib/api'
import { recentFolders } from './lib/folders'
import { sessionTitle } from './lib/sessions'
import { displayStatus } from './lib/format'
import { enter } from './lib/motion'
import { firstUnseen, loadSeen, saveSeen } from './lib/seen'
import { itemTree, type ItemNode } from './lib/tree'
import { parseRoute, routePath } from './lib/route'
import { turnNumbers } from './lib/turns'
import { useLayoutStore, type Mode } from './stores/layout'
import { useSessionStore, type Pane } from './stores/session'
import { useTerminalStore } from './stores/terminals'

export default function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const sessions = useSessionStore((s) => s.sessions)
  const activeId = useSessionStore((s) => s.activeId)
  const pane = useSessionStore((s) => s.pane)
  const error = useSessionStore((s) => s.error)
  const loadSessions = useSessionStore((s) => s.loadSessions)
  const loadRequests = useSessionStore((s) => s.loadRequests)
  const loadQuotas = useSessionStore((s) => s.loadQuotas)
  const connect = useSessionStore((s) => s.connect)
  const createSession = useSessionStore((s) => s.createSession)
  const mode = useLayoutStore((s) => s.mode)
  const dock = useLayoutStore((s) => s.dock)
  const loadTerminals = useTerminalStore((s) => s.load)

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
      void loadTerminals()
      connect()
    }
  }, [health, loadSessions, loadRequests, loadQuotas, loadTerminals, connect])

  useRouteSync(health === 'online')

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">
          <h1>go-chamber</h1>
        </div>
        {health === 'online' && <ModeSwitch />}
        <div className="topbar-end">
          <span className={`health health-${health ?? 'connecting'}`}>
            <span className="dot" aria-hidden="true" />
            {health ?? 'connecting'}
          </span>
          {health === 'online' && <NotifyToggle />}
          {health === 'online' && (
            <form method="post" action="/logout" className="signout">
              <button type="submit" className="btn btn-ghost">Sign out</button>
            </form>
          )}
        </div>
      </header>
      {health === 'unauthorized' && (
        <section className="notice panel">
          <h2>Signed out</h2>
          <p>
            <a href="/">Sign in</a> with the access token go-chamber printed at startup.
          </p>
        </section>
      )}
      {health === 'online' && mode === 'terminal' && (
        <div className="layout term-layout">
          <TerminalWorkspace sessions={sessions} />
        </div>
      )}
      {health === 'online' && mode === 'agents' && (
        <>
          <div className="layout" data-pane={pane} data-dock={dock ?? 'closed'}>
            <Sidebar sessions={sessions} onCreate={(agent, cwd, branch) => void createSession(agent, cwd, branch)} />
            {activeId ? <Chat key={activeId} /> : <EmptyChat />}
            <div className="dock">
              {dock && (
                <div className="dock-body">
                  {dock === 'requests' ? (
                    <RequestTray />
                  ) : dock === 'changes' ? (
                    <DiffPanel key={activeId} sessionId={activeId} />
                  ) : (
                    <TerminalPanel sessionId={activeId} />
                  )}
                </div>
              )}
              <DockRail />
            </div>
            <div className="requests-pane">
              <RequestTray />
            </div>
            <div className="changes-pane">{pane === 'changes' && <DiffPanel key={activeId} sessionId={activeId} />}</div>
          </div>
          <PaneBar />
        </>
      )}
      {error && (
        <p className="error toast" role="alert">
          {error}
          <button className="btn toast-close" aria-label="Dismiss" onClick={() => useSessionStore.setState({ error: null })}>
            ×
          </button>
        </p>
      )}
    </main>
  )
}

const modes: { id: Mode; label: string }[] = [
  { id: 'agents', label: 'Agents' },
  { id: 'terminal', label: 'Terminal' },
]

// ModeSwitch flips between agent sessions and the terminal workspace.
function ModeSwitch() {
  const mode = useLayoutStore((s) => s.mode)
  const setMode = useLayoutStore((s) => s.setMode)
  const running = useTerminalStore((s) => s.terminals.filter((t) => t.status === 'running').length)
  return (
    <div className="segmented mode-switch" role="radiogroup" aria-label="Mode">
      {modes.map((m) => (
        <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} onClick={() => setMode(m.id)}>
          {m.label}
          {m.id === 'terminal' && running > 0 && <span className="count">{running}</span>}
        </button>
      ))}
    </div>
  )
}

// DockRail is the collapsed dock: one button per tab, with counts.
function DockRail() {
  const dock = useLayoutStore((s) => s.dock)
  const toggleDock = useLayoutStore((s) => s.toggleDock)
  const pending = useSessionStore((s) => s.pendingRequests.length)
  const running = useTerminalStore((s) => s.terminals.filter((t) => t.status === 'running').length)
  const tabs = [
    { id: 'requests' as const, label: 'Requests', icon: <Inbox {...icon(16)} />, count: pending },
    { id: 'terminal' as const, label: 'Terminal', icon: <SquareTerminal {...icon(16)} />, count: running },
    { id: 'changes' as const, label: 'Changes', icon: <FileDiff {...icon(16)} />, count: 0 },
  ]
  return (
    <div className="dock-rail" role="toolbar" aria-label="Dock" aria-orientation="vertical">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`rail-btn rail-${t.id}`}
          aria-pressed={dock === t.id}
          aria-label={t.count > 0 ? `${t.label} ${t.count}` : t.label}
          title={t.label}
          onClick={() => toggleDock(t.id)}
        >
          {t.icon}
          {t.count > 0 && (
            <span className="rail-count" aria-hidden="true">
              {t.count}
            </span>
          )}
        </button>
      ))}
      {dock && (
        <button type="button" className="rail-btn rail-collapse" aria-label="Collapse dock" title="Collapse" onClick={() => toggleDock(dock)}>
          <ChevronsRight {...icon(16)} />
        </button>
      )}
    </div>
  )
}

const panes: { id: Pane; label: string; icon: ReactNode }[] = [
  { id: 'sessions', label: 'Sessions', icon: <List {...icon(18)} /> },
  { id: 'chat', label: 'Chat', icon: <MessageSquareText {...icon(18)} /> },
  { id: 'requests', label: 'Requests', icon: <Inbox {...icon(18)} /> },
  { id: 'changes', label: 'Changes', icon: <FileDiff {...icon(18)} /> },
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
          {p.icon}
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
        <h2>Start a session</h2>
        <p>Pick an agent and a project folder on the left, or open an existing session.</p>
      </div>
    </section>
  )
}

function Sidebar(props: { onCreate: (agent: AgentKind, cwd: string, branch?: string) => void; sessions: Session[] }) {
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
  const renameSession = useSessionStore((s) => s.renameSession)
  const connection = useSessionStore((s) => s.connection)
  const send = useSessionStore((s) => s.send)
  const steer = useSessionStore((s) => s.steer)
  const interrupt = useSessionStore((s) => s.interrupt)
  const respond = useSessionStore((s) => s.respond)
  const stopTask = useSessionStore((s) => s.stopTask)
  const continueSession = useSessionStore((s) => s.continueSession)
  const setAutoContinue = useSessionStore((s) => s.setAutoContinue)
  const forkSession = useSessionStore((s) => s.forkSession)
  const [text, setText] = useState('')
  const attachments = useAttachments(session?.id)
  const status = displayStatus(chat, session)
  const running = status === 'running'
  const reduced = useReducedMotion() ?? false
  const nodes = itemTree(chat.order, chat.items).filter((node) => !isBlank(node.item))
  const turns = turnNumbers(nodes)
  const unseen = useUnseen(session?.id, chat.order)
  const scrollRef = useStickToBottom(chat)

  const submit = () => {
    const value = text.trim()
    const images = attachments.ids
    // Steering takes text only; attached images wait for the next turn.
    if (!value && (running || images.length === 0)) return
    if (running) {
      void steer(value)
    } else {
      void send(value, images)
      attachments.clear()
    }
    setText('')
  }

  return (
    <section className="chat panel">
      <header className="chat-header">
        {session && <AgentAvatar agent={session.agent} />}
        <div className="chat-heading">
          {session ? (
            <EditableTitle heading value={sessionTitle(session)} label="session" onRename={(title) => renameSession(session.id, title)} />
          ) : (
            <h2>Session</h2>
          )}
          {session && <span className="chat-path">{session.cwd}</span>}
        </div>
        <div className="chat-meta">
          <span className={`status status-${status}`}>{status}</span>
          {connection !== 'online' && <span className={`health health-${connection}`}>{connection}</span>}
          <SessionUsage />
          {session && <ModelPicker session={session} />}
          {session && <PermissionModeSelect session={session} />}
          {session && <ApprovalReviewerSelect session={session} />}
          {session?.nativeId && (
            <button type="button" className="btn btn-ghost" onClick={() => void forkSession(session.id)}>
              Fork
            </button>
          )}
        </div>
      </header>
      <div className="scroll" ref={scrollRef}>
        <ol className="items">
          <AnimatePresence initial={false}>
            {nodes.map((node) => (
              <Fragment key={node.item.id}>
                {node.item.id === unseen && (
                  <li className="unseen-mark" aria-label="New since your last visit">
                    new since you left
                  </li>
                )}
                <motion.li className={`row row-${node.item.kind}`} {...enter(reduced)}>
                  {turns.has(node.item.id) && (
                    <span className="turn-no" aria-label={`turn ${turns.get(node.item.id)}`}>
                      {turns.get(node.item.id)}.
                    </span>
                  )}
                  <ItemView node={node} onStopTask={stopTask} />
                </motion.li>
              </Fragment>
            ))}
          </AnimatePresence>
        </ol>
        {chat.order.length === 0 && status !== 'interrupted' && (
          <p className="chat-hint">Send a message to start. The agent runs in {session?.cwd ?? 'the session folder'}.</p>
        )}
        <AnimatePresence initial={false}>
          {Object.values(chat.requests).map((request) => (
            <motion.div
              key={request.id}
              className="request-slot"
              {...enter(reduced, 'margin')}
              exit={reduced ? { opacity: 0 } : resolve}
              ref={scrollOnMount}
            >
              <RequestCard request={request} agent={session?.agent} onRespond={respond} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      {status === 'interrupted' && session && (
        <InterruptedBanner
          session={session}
          onContinue={() => void continueSession()}
          onAutoContinue={(on) => void setAutoContinue(session.id, on)}
        />
      )}
      <form
        className="composer"
        {...attachments.dropProps}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <ComposerInput
          sessionId={session?.id}
          agent={session?.agent}
          value={text}
          onChange={setText}
          onSubmit={submit}
          placeholder={running ? 'Steer the running turn…' : 'Message the agent…  ⌘↵ to send'}
        />
        <div className="composer-actions">
          <Attachments state={attachments} />
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

// useUnseen remembers where the user stopped reading this session and returns
// the first item that arrived since, for the "new since you left" mark.
function useUnseen(sessionId: string | undefined, order: string[]): string | null {
  // Read once: the mark stays where the user left, while new items stream in.
  const [seen] = useState(() => (sessionId ? loadSeen(sessionId) : null))
  const last = order[order.length - 1]
  useEffect(() => {
    if (sessionId && last) saveSeen(sessionId, last)
  }, [sessionId, last])
  return firstUnseen(order, seen)
}

// resolve strikes the answered request through, then folds it away.
const resolve: TargetAndTransition = {
  '--strike': [0, 1, 1],
  opacity: [1, 1, 0],
  height: [null, null, 0],
  transition: { duration: 0.45, times: [0, 0.45, 1], ease: 'easeOut' },
}

// useStickToBottom keeps the chat scrolled to the end while new output
// streams in, unless the user scrolled up to read.
function useStickToBottom(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  useLayoutEffect(() => {
    const el = ref.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [dep])
  return ref
}

// A pending request is the one thing the user must act on: bring all of it
// into view when it arrives or when the session opens.
function scrollOnMount(el: HTMLDivElement | null) {
  el?.scrollIntoView({ block: 'nearest' })
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
      return (
        <div className="item user">
          {item.text}
          {item.images?.length ? (
            <div className="item-images">
              {item.images.map((id) => (
                <a key={id} href={imageUrl(item.sessionId, id)} target="_blank" rel="noopener noreferrer">
                  <img src={imageUrl(item.sessionId, id)} alt="attached image" loading="lazy" />
                </a>
              ))}
            </div>
          ) : null}
        </div>
      )
    case 'assistant_message':
      return (
        <div className="item assistant">
          <Markdown text={item.text ?? ''} />
        </div>
      )
    case 'reasoning':
      return (
        <details className="item reasoning">
          <summary>Thinking</summary>
          <Markdown text={item.text ?? ''} />
        </details>
      )
    case 'plan':
      return (
        <div className="item plan">
          <Markdown text={item.text ?? ''} />
        </div>
      )
    case 'command':
      return (
        <div className={`item command state-${item.status}`}>
          <span className="item-icon">
            <Terminal {...icon(13)} />
          </span>
          <code>{commandText(item)}</code>
          {item.text && <Folded label="Output" text={item.text} />}
        </div>
      )
    case 'file_change':
      return (
        <div className={`item file state-${item.status}`}>
          <span className="item-icon">
            <FilePen {...icon(13)} />
          </span>
          <code>{item.path || item.name}</code>
          {item.diff && <Folded label="Diff" text={item.diff} />}
        </div>
      )
    case 'hook':
      return <HookView item={item} />
    case 'decision':
      return (
        <div className={`item decision decision-${item.decision ?? 'answered'}`}>
          <span className="decision-kw">{item.decision ?? 'answered'}</span>
          <span className="decision-name">{item.name || 'Request'}</span>
          {item.text && <span className="decision-text">{item.text}</span>}
        </div>
      )
    case 'subagent':
      return (
        <div className={`item subagent state-${item.status}`}>
          <div className="subagent-head">
            <span className="item-icon">
              <Workflow {...icon(13)} />
            </span>
            <span>subagent: {item.name}</span>
            {item.agentId && item.status !== 'completed' && item.status !== 'failed' && (
              <button className="btn btn-ghost btn-xs stop-task" onClick={() => onStopTask(item.sessionId, item.agentId!)}>
                Stop
              </button>
            )}
          </div>
          {item.text && <Folded label="Output" text={item.text} />}
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
          <span className="item-icon">
            <Wrench {...icon(13)} />
          </span>
          <code>{item.name}</code>
          {item.text && <Folded label="Output" text={item.text} />}
        </div>
      )
  }
}

// Folded keeps tool output out of the way: long command output and diffs
// used to fill the whole chat. The summary says how much is inside.
function Folded({ label, text }: { label: string; text: string }) {
  const lines = text.replace(/\n$/, '').split('\n').length
  return (
    <details className="item-output">
      <summary>
        {label} · {lines} {lines === 1 ? 'line' : 'lines'}
      </summary>
      <pre>{text}</pre>
    </details>
  )
}

const hookBadge: Record<string, string> = { success: 'ok', blocked: 'blocked', error: 'error' }

// HookView shows a user-configured hook the agent ran; a hook that blocked
// the agent explains why the agent continued.
function HookView({ item }: { item: Item }) {
  const outcome = item.outcome ?? (item.status === 'streaming' || item.status === 'pending' ? 'running' : 'success')
  const head = (
    <>
      <span className="item-icon">
        <Webhook {...icon(13)} />
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

// useRouteSync keeps the URL on the open session (/s/<id>) or terminal
// (/t/<id>): a reload or a shared link reopens it, and Back returns to the
// previous one.
function useRouteSync(online: boolean) {
  useEffect(() => {
    if (!online) return
    const apply = () => {
      const route = parseRoute(location.pathname)
      if (route.kind === 'session') {
        useLayoutStore.getState().setMode('agents')
        if (useSessionStore.getState().activeId !== route.id) void useSessionStore.getState().selectSession(route.id)
      } else if (route.kind === 'terminal') {
        useLayoutStore.getState().setMode('terminal')
        useTerminalStore.getState().select(route.id)
      }
    }
    const current = () =>
      routePath(useLayoutStore.getState().mode, useSessionStore.getState().activeId, useTerminalStore.getState().activeId)
    // ponytail: with nothing open the URL keeps the last session or terminal,
    // so Back never lands on an empty step; a reload then reopens that one.
    const follow = () => {
      const path = current()
      if (path !== '/' && path !== location.pathname) history.pushState(null, '', path + location.search)
    }
    apply()
    if (current() !== '/' && current() !== location.pathname) history.replaceState(null, '', current() + location.search)
    const unsubscribe = [useLayoutStore.subscribe(follow), useSessionStore.subscribe(follow), useTerminalStore.subscribe(follow)]
    window.addEventListener('popstate', apply)
    return () => {
      unsubscribe.forEach((u) => u())
      window.removeEventListener('popstate', apply)
    }
  }, [online])
}
